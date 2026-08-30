import type { NotifyLayout, NotifyMode, NotifyPrefs, NotifyPreview } from "./notify-prefs.ts";
import { paneTopicFor, summaryTopicFor, type PushMessage } from "./push.ts";
import { herdTagFor } from "./sessions.ts";
import type { AgentStatus, AgentView, NotificationHistoryEntry } from "./types.ts";

// A notification shouldn't be fire-and-forget. This coordinator gives every blocked/done alert a
// lifecycle and collapses the herd into a single, always-accurate notification. The provider is
// intentionally injected: reading a journal is asynchronous and must not make the state transition
// path wait on disk I/O.

type NotifiableStatus = "blocked" | "done";
type NotificationPrefs = Pick<NotifyPrefs, "preview" | "mode" | "layout">;
const PREVIEW_RANK: Record<NotifyPreview, number> = { hidden: 0, blocked: 1, all: 2 };

const MAX_TITLE_CHARS = 96;
const MAX_BODY_CHARS = 160;
// Independent from display length: a single grapheme can contain unbounded marks and overflow push payloads.
const MAX_COPY_CODE_POINTS = 256;
const MAX_LABEL_CLUSTER_CODE_POINTS = 128;
// Keep the newest work visible; the count prefix is more useful than dozens of one-character fragments.
const MAX_DIGEST_ITEMS = 4;
const COPY_SEPARATOR = " · ";
const DIGEST_SEPARATOR = "; ";
const CONTROL_CHARACTERS = /\p{Cc}+/gu;
const BIDI_CONTROLS = /\p{Bidi_Control}+/gu;
const UNREADABLE_LABEL = /^[\s\p{Default_Ignorable_Code_Point}\p{M}]+$/u;
const GRAPHEMES =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemes(value: string): string[] {
  return GRAPHEMES ? [...GRAPHEMES.segment(value)].map((part) => part.segment) : [...value];
}

function cleanLabel(value: string | null | undefined): string | undefined {
  const clean = value
    ?.replace(BIDI_CONTROLS, " ")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || UNREADABLE_LABEL.test(clean)) return undefined;
  if (graphemes(clean).some((cluster) => [...cluster].length > MAX_LABEL_CLUSTER_CODE_POINTS)) {
    return undefined;
  }
  return clean;
}

/** Grapheme-safe display clamp with a secondary transport bound for adversarial dense copy. */
function clampCopy(
  value: string,
  maxChars: number,
  maxCodePoints = MAX_COPY_CODE_POINTS,
): string {
  const chars = graphemes(value);
  if (chars.length <= maxChars && [...value].length <= maxCodePoints) return value;
  const kept: string[] = [];
  let keptCodePoints = 0;
  for (const cluster of chars) {
    const clusterCodePoints = [...cluster].length;
    if (
      kept.length >= maxChars - 1 ||
      keptCodePoints + clusterCodePoints > maxCodePoints - 1
    ) {
      break;
    }
    kept.push(cluster);
    keptCodePoints += clusterCodePoints;
  }
  return `${kept.join("")}…`;
}

function pathTail(value: string): string | undefined {
  const clean = cleanLabel(value)?.replace(/[\\/]+$/, "");
  return cleanLabel(clean?.split(/[\\/]/).at(-1));
}

/** The thing the notification is ABOUT. Explicit operator naming wins, then live work, then session. */
function workLabel(agent: AgentView): string {
  const candidates = [
    agent.paneLabel,
    agent.terminalTitle,
    agent.sessionName,
    agent.tabLabel,
    agent.workspaceLabel,
    pathTail(agent.cwd),
    agent.agent,
  ];
  return candidates.map(cleanLabel).find((label): label is string => label !== undefined) ?? "Agent";
}

/** Compact locator for the body, excluding anything already promoted into the title. */
function contextLabel(agent: AgentView, work: string): string {
  const parts: string[] = [];
  const seen = new Set([work.toLowerCase()]);
  for (const candidate of [agent.agent, agent.workspaceLabel, agent.tabLabel]) {
    const label = cleanLabel(candidate);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(label);
  }
  return clampCopy(parts.join(COPY_SEPARATOR) || cleanLabel(agent.agent) || "Agent", MAX_BODY_CHARS);
}

/** Preview text is provider output, not operator metadata, so it gets the same hostile-copy bounds. */
function cleanPreview(value: unknown): string | undefined {
  const clean = cleanLabel(typeof value === "string" ? value : undefined);
  return clean === undefined ? undefined : clampCopy(clean, MAX_BODY_CHARS);
}

/** The timer primitive the coordinator schedules against — real setTimeout in the bridge, fake in tests. */
export interface NotifyClock<H> {
  schedule(fn: () => void, delayMs: number): H;
  cancel(handle: H): void;
}

/** The current state of the herd's single notification, derived from everything outstanding. */
export interface HerdSummary {
  /** Headline: "Done: Review auth" for one, or a count for several. */
  title: string;
  /** Compact agent/workspace context for one alert, or named work items for a digest. */
  body: string;
  /** Deep-link target when exactly one alert is outstanding; undefined for a multi-agent digest. */
  paneId?: string;
  /** Re-alert (buzz) the device — true when a new alert arrived, false on a silent retraction update. */
  renotify: boolean;
}

/**
 * A sink has both herd-summary and pane-scoped slots. Every operation reports whether its instruction
 * reached the push queue; render operations may be muted and return false, while clears always attempt
 * delivery. Queue acceptance is intentionally separate from per-device delivery, so history cannot be
 * made atomic with individual subscriptions.
 */
export interface NotifySink {
  render(summary: HerdSummary): boolean;
  clear(): boolean;
  renderPane(summary: HerdSummary): boolean;
  clearPane(paneId: string): boolean;
}

/** Just the transport the sink needs — "deliver this message to the devices". */
export interface PushSender {
  send(msg: PushMessage): unknown;
}
/** Just the quiet-hours check the sink needs — "are we muted right now?". */
export interface MuteGate {
  isMuted(): boolean;
}

/** History is deliberately narrower than the persisted store: the coordinator never supplies IDs or timestamps. */
export interface NotificationHistoryRecorder {
  record(draft: {
    paneId: string;
    status: NotifiableStatus;
    work: string;
    context: string;
    preview?: string;
  }): unknown;
  resolve(paneId: string): unknown;
}

/** Metadata stays out of the wire-facing summary shape while allowing the sink to set urgency correctly. */
const SUMMARY_META = new WeakMap<object, { blocked: boolean }>();

function summaryBlocked(summary: HerdSummary): boolean {
  const metadata = SUMMARY_META.get(summary);
  if (metadata) return metadata.blocked;
  // Manual sink callers predate the metadata seam; retain the obvious copy policy for them too.
  return /\bneeds? you\b|\bneed attention\b/i.test(`${summary.title} ${summary.body}`);
}

function withSummaryMeta(summary: HerdSummary, blocked: boolean): HerdSummary {
  SUMMARY_META.set(summary, { blocked });
  return summary;
}

/** Notification tags cannot use a raw pane id safely: IDs may contain colons, slashes, or Unicode. */
export function paneTagFor(herdTag: string, paneId: string): string {
  let encoded: string;
  try {
    encoded = encodeURIComponent(paneId);
  } catch {
    // encodeURIComponent rejects lone UTF-16 surrogates. A slash cannot occur in the normal encoded
    // alphabet, so this fallback remains collision-free with well-formed IDs as well.
    encoded = `/${[...paneId].map((part) => part.codePointAt(0)!.toString(16)).join("_")}`;
  }
  return `${herdTag}:${encoded}`;
}

const LEGACY_SUMMARY_TOPIC = "collie-herd";

export interface NotificationSlotQueue {
  send(message: PushMessage): unknown;
  flush(): Promise<void>;
}

/**
 * Retract every slot identity retained in recent history before sessions can render replacements.
 * Resolved rows stay in scope: a process can die after recording resolution but before its async clear
 * reaches the push service. Clearing is idempotent, and the bounded rows are the only durable identity
 * source available after either a graceful restart or a crash.
 */
export async function reconcileStartupNotificationSlots(
  push: NotificationSlotQueue,
  entries: readonly NotificationHistoryEntry[],
): Promise<void> {
  const queued = new Set<string>();
  const queue = (message: PushMessage): void => {
    const key = `${message.tag ?? ""}\u0000${message.topic ?? ""}`;
    if (queued.has(key)) return;
    queued.add(key);
    try {
      const result = push.send(message);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // The durable row remains available for the next startup retry.
    }
  };

  for (const entry of entries) {
    const isPrimary = entry.session === undefined;
    const session = entry.session ?? "default";
    const herdTag = herdTagFor(isPrimary, session);

    if (isPrimary) {
      queue({ type: "clear", tag: herdTag, urgency: "high" });
    } else {
      // Clear both the pre-session topic and the current session-scoped topic.
      queue({ type: "clear", tag: herdTag, topic: LEGACY_SUMMARY_TOPIC, urgency: "high" });
      queue({ type: "clear", tag: herdTag, topic: summaryTopicFor(session), urgency: "high" });
    }
    queue({
      type: "clear",
      tag: paneTagFor(herdTag, entry.paneId),
      topic: paneTopicFor(isPrimary ? undefined : session, entry.paneId),
      urgency: "high",
    });
  }
  await push.flush();
}

/**
 * Build the {@link NotifySink} the coordinator drives. Render operations honor the mute gate; lifecycle
 * clears always attempt delivery so snooze can retract already-visible notifications. Summary alerts keep
 * the historical herd tag; named summaries add a deterministic session-scoped collapse topic. Per-task
 * alerts use a stable pane tag and push collapse topic so changing one pane never replaces another
 * pane's queued message.
 */
export function makeNotifySink(
  push: PushSender,
  mute: MuteGate,
  herdTag: string,
  sessionName?: string,
): NotifySink {
  const deliver = (msg: PushMessage): boolean => {
    try {
      const result = push.send(msg);
      // A true return means the instruction was accepted by the push queue. Device delivery and
      // pruning complete later, so history cannot be made atomic with individual subscriptions.
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).catch((err) => {
          try {
            console.warn(
              `[notify] push delivery failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } catch {
            // Logging must not turn a handled rejection into another unhandled rejection.
          }
        });
      }
      return true;
    } catch {
      return false;
    }
  };

  return {
    render: (summary) => {
      if (mute.isMuted()) return false;
      const blocked = summaryBlocked(summary);
      const msg: PushMessage = {
        title: summary.title,
        body: summary.body,
        tag: herdTag,
        paneId: summary.paneId,
        renotify: summary.renotify,
        silent: !blocked,
        ...(blocked ? { vibrate: [200, 100, 200] } : {}),
        urgency: blocked ? "high" : "normal",
      };
      if (sessionName !== undefined) {
        msg.session = sessionName;
        msg.topic = summaryTopicFor(sessionName);
      }
      return deliver(msg);
    },
    clear: () => {
      const msg: PushMessage = { type: "clear", tag: herdTag, urgency: "high" };
      if (sessionName !== undefined) msg.topic = summaryTopicFor(sessionName);
      return deliver(msg);
    },
    renderPane: (summary) => {
      if (mute.isMuted() || summary.paneId === undefined) return false;
      const paneId = summary.paneId;
      const blocked = summaryBlocked(summary);
      const msg: PushMessage = {
        title: summary.title,
        body: summary.body,
        tag: paneTagFor(herdTag, paneId),
        paneId,
        renotify: summary.renotify,
        topic: paneTopicFor(sessionName, paneId),
        silent: !blocked,
        ...(blocked ? { vibrate: [200, 100, 200] } : {}),
        urgency: blocked ? "high" : "normal",
      };
      if (sessionName !== undefined) msg.session = sessionName;
      return deliver(msg);
    },
    clearPane: (paneId) => {
      return deliver({
        type: "clear",
        tag: paneTagFor(herdTag, paneId),
        topic: paneTopicFor(sessionName, paneId),
        urgency: "high",
      });
    },
  };
}

interface Alert {
  agent: string;
  work: string;
  context: string;
  status: NotifiableStatus;
  preview?: string;
  historyRecorded: boolean;
}

interface Pending<H> {
  handle: H;
  status: NotifiableStatus;
  generation: number;
}

export interface NotificationCoordinatorOptions<H = unknown> {
  clock: NotifyClock<H>;
  sink: NotifySink;
  delayMs: number;
  isNotifiable: (status: AgentStatus) => boolean;
  prefs: () => NotificationPrefs;
  preview: (agent: AgentView, status: NotifiableStatus) => Promise<string | undefined>;
  history?: NotificationHistoryRecorder;
}

export class NotificationCoordinator<H = unknown> {
  /** paneId → debouncing alert (timer + its kind) that hasn't entered the current mode yet. */
  private readonly pending = new Map<string, Pending<H>>();
  /** paneId → alert that has fired (insertion-ordered for summary digest copy). */
  private readonly outstanding = new Map<string, Alert>();
  /** paneId → generations whose preview provider has been invoked but has not completed yet. */
  private readonly inFlight = new Map<string, Set<number>>();
  /** Every async promotion captures one generation; any lifecycle change invalidates old work. */
  private readonly generations = new Map<string, number>();
  /** Sent slots, retained so mode switches and teardown retract every old notification. */
  private readonly renderedPaneIds = new Set<string>();
  private summaryRendered = false;
  private lastPrefs: NotificationPrefs;

  constructor(private readonly options: NotificationCoordinatorOptions<H>) {
    this.lastPrefs = { ...options.prefs() };
  }

  /** Wire to `StateEngine.onTransition`. */
  onTransition(agent: AgentView, _from: AgentStatus, to: AgentStatus): void {
    const id = agent.paneId;
    const generation = this.bumpGeneration(id);
    this.cancelPending(id);
    // A status flip invalidates the old alert before the new debounce starts. This prevents a stale
    // provider completion from replacing a newer status (and avoids a lock-screen alert for the old kind).
    this.retract(id);
    if (!this.options.isNotifiable(to)) return;

    const status = to as NotifiableStatus;
    const handle = this.options.clock.schedule(() => {
      const current = this.pending.get(id);
      if (!current || current.generation !== generation) return;
      this.pending.delete(id);
      // This call is intentionally unconditional: hidden privacy still populates the in-memory alert,
      // so switching to an allowed privacy level can reveal the already-fetched preview without a race.
      this.startPreview(agent, status, generation);
    }, this.options.delayMs);
    this.pending.set(id, { handle, status, generation });
  }

  /** Wire to `StateEngine.onRemove` — a vanished pane is implicitly resolved. */
  onRemove(paneId: string): void {
    this.bumpGeneration(paneId);
    this.cancelPending(paneId);
    this.retract(paneId);
  }

  /**
   * Re-evaluate live kind/privacy/layout/mode preferences after the store changes. Kind retractions
   * remove their old slot; copy-only changes replace outstanding alerts without re-alerting.
   */
  applyPrefs(): void {
    const before = this.lastPrefs;
    const current = { ...this.options.prefs() };
    this.lastPrefs = current;

    for (const [id, pending] of [...this.pending]) {
      if (!this.options.isNotifiable(pending.status)) {
        this.bumpGeneration(id);
        this.cancelPending(id);
      }
    }

    const removed: string[] = [];
    for (const [id, alert] of [...this.outstanding]) {
      if (!this.options.isNotifiable(alert.status)) {
        this.bumpGeneration(id);
        this.outstanding.delete(id);
        removed.push(id);
        this.resolveHistory(id);
      }
    }

    const modeChanged = before.mode !== current.mode;
    const privacyDowngraded = PREVIEW_RANK[current.preview] < PREVIEW_RANK[before.preview];
    const displayChanged = before.preview !== current.preview || before.layout !== current.layout;

    if (modeChanged || privacyDowngraded) {
      // A mode switch cannot leave both slot families alive. A privacy downgrade also retracts the old
      // content before a policy-compliant replacement is queued, so replacement failure cannot preserve
      // disallowed lock-screen copy until the next bridge restart. Push serializes both on each topic.
      this.clearSlotsForMode(before.mode);
      if (this.outstanding.size > 0) this.renderOutstanding(false);
      return;
    }

    if (current.mode === "per-task") {
      for (const id of removed) this.clearPaneSlot(id);
      if (displayChanged) this.renderOutstanding(false);
      return;
    }

    if (removed.length > 0 || displayChanged) this.emit(false);
  }

  /** Tear down this session's notifications, including any in-flight provider completions. */
  clearAll(): void {
    const invalidated = new Set<string>([
      ...this.pending.keys(),
      ...this.inFlight.keys(),
      ...this.outstanding.keys(),
    ]);
    for (const id of invalidated) this.bumpGeneration(id);
    for (const id of [...this.pending.keys()]) this.cancelPending(id);
    for (const [id] of [...this.outstanding]) {
      this.outstanding.delete(id);
      this.resolveHistory(id);
    }
    this.clearAllSlots();
  }

  /** Retract rendered slots while retaining pending/outstanding alerts and their history state. */
  clearRendered(): void {
    this.clearAllSlots();
  }

  private bumpGeneration(id: string): number {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    return generation;
  }

  private currentGeneration(id: string): number {
    return this.generations.get(id) ?? 0;
  }
  private trackPreview(id: string, generation: number): void {
    const active = this.inFlight.get(id) ?? new Set<number>();
    active.add(generation);
    this.inFlight.set(id, active);
  }

  private finishPreview(id: string, generation: number): void {
    const active = this.inFlight.get(id);
    if (!active) return;
    active.delete(generation);
    if (active.size === 0) this.inFlight.delete(id);
  }

  private startPreview(agent: AgentView, status: NotifiableStatus, generation: number): void {
    const id = agent.paneId;
    this.trackPreview(id, generation);
    const finish = (value: unknown): void => {
      try {
        if (this.currentGeneration(id) !== generation) return;
        if (!this.options.isNotifiable(status)) return;
        const work = workLabel(agent);
        const alert: Alert = {
          agent: cleanLabel(agent.agent) ?? "Agent",
          work,
          context: contextLabel(agent, work),
          status,
          preview: cleanPreview(value),
          historyRecorded: false,
        };
        this.outstanding.set(id, alert);
        this.emit(true, alert);
      } finally {
        this.finishPreview(id, generation);
      }
    };

    let result: unknown;
    try {
      result = this.options.preview(agent, status);
    } catch {
      finish(undefined);
      return;
    }
    if (result !== null && typeof result === "object" && "then" in result) {
      void Promise.resolve(result as Promise<unknown>).then(finish, () => finish(undefined));
      return;
    }
    // The public contract is Promise<string|undefined>; handling a sync value as well keeps a
    // provider failure/small fake from becoming an unhandled rejection in the bridge.
    finish(result);
  }

  private resolveHistory(paneId: string): void {
    if (!this.options.history) return;
    try {
      const result = this.options.history.resolve(paneId);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void (result as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // History is auxiliary; a persistence failure must never break lifecycle retraction.
    }
  }

  private recordHistory(paneId: string, alert: Alert): void {
    if (!this.options.history || alert.historyRecorded) return;
    alert.historyRecorded = true;
    const preview = this.allowedPreview(alert);
    const draft = {
      paneId,
      status: alert.status,
      work: alert.work,
      context: alert.context,
      ...(preview === undefined ? {} : { preview }),
    };
    try {
      const result = this.options.history.record(draft);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void (result as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // The alert was sent; a failed history write should not cause a duplicate push on retry.
    }
  }

  private allowedPreview(alert: Alert): string | undefined {
    const policy: NotifyPreview = this.lastPrefs.preview;
    if (policy === "all" || (policy === "blocked" && alert.status === "blocked")) {
      return alert.preview;
    }
    return undefined;
  }

  private singleSummary(paneId: string, alert: Alert, renotify: boolean): HerdSummary {
    const prefix = alert.status === "blocked" ? "Needs you" : "Done";
    const preview = this.allowedPreview(alert);
    const layout: NotifyLayout = this.lastPrefs.layout;
    let title: string;
    let body: string;
    if (layout === "context-first") {
      title = clampCopy(alert.context, MAX_TITLE_CHARS);
      body = clampCopy(
        preview === undefined ? `${prefix}: ${alert.work}` : `${prefix}: ${alert.work}${COPY_SEPARATOR}${preview}`,
        MAX_BODY_CHARS,
      );
    } else if (layout === "compact") {
      title = clampCopy(`${prefix} · ${alert.work}`, MAX_TITLE_CHARS);
      body = clampCopy(preview ?? alert.context, MAX_BODY_CHARS);
    } else {
      title = clampCopy(`${prefix}: ${alert.work}`, MAX_TITLE_CHARS);
      body = clampCopy(
        preview === undefined ? alert.context : `${preview}${COPY_SEPARATOR}${alert.context}`,
        MAX_BODY_CHARS,
      );
    }
    return withSummaryMeta({ title, body, paneId, renotify }, alert.status === "blocked");
  }

  /** Re-render the current mode from whatever's outstanding (or clear it when empty). */
  private emit(renotify: boolean, promoted?: Alert): void {
    if (this.outstanding.size === 0) {
      if (this.summaryRendered) {
        if (this.options.sink.clear()) this.summaryRendered = false;
      }
      return;
    }

    if (this.lastPrefs.mode === "summary") {
      const sent = this.options.sink.render(this.summarize(renotify));
      if (sent) {
        this.summaryRendered = true;
        for (const [paneId, alert] of this.outstanding) this.recordHistory(paneId, alert);
      }
      return;
    }

    if (promoted !== undefined) {
      const entry = [...this.outstanding.entries()].find(([, candidate]) => candidate === promoted);
      const paneId = entry?.[0];
      if (paneId === undefined) return;
      const sent = this.options.sink.renderPane(this.singleSummary(paneId, promoted, renotify));
      if (sent) {
        this.renderedPaneIds.add(paneId);
        this.recordHistory(paneId, promoted);
      }
      return;
    }

    this.renderOutstanding(renotify);
  }

  private renderOutstanding(renotify: boolean): void {
    if (this.lastPrefs.mode === "summary") {
      this.emit(renotify);
      return;
    }
    for (const [paneId, alert] of this.outstanding) {
      const sent = this.options.sink.renderPane(this.singleSummary(paneId, alert, renotify));
      if (sent) {
        this.renderedPaneIds.add(paneId);
        this.recordHistory(paneId, alert);
      }
    }
  }


  private summarize(renotify: boolean): HerdSummary {
    const entries = [...this.outstanding.entries()];
    if (entries.length === 1) {
      const [paneId, alert] = entries[0]!;
      return this.singleSummary(paneId, alert, renotify);
    }

    const alerts = entries.map(([, alert]) => alert);
    const n = alerts.length;
    const blocked = alerts.filter((alert) => alert.status === "blocked").length;
    const done = n - blocked;
    const allBlocked = blocked === n;
    const allDone = done === n;
    const title = allBlocked
      ? `${n} tasks need you`
      : allDone
        ? `${n} tasks done`
        : `${blocked} need you · ${done} done`;
    const visible = alerts.slice(-MAX_DIGEST_ITEMS);
    const hidden = n - visible.length;
    const prefix = hidden > 0 ? `+${hidden} earlier${DIGEST_SEPARATOR}` : "";
    const separatorChars = [...DIGEST_SEPARATOR].length * (visible.length - 1);
    const itemBudget = Math.max(
      1,
      Math.floor((MAX_BODY_CHARS - [...prefix].length - separatorChars) / visible.length),
    );
    const itemCodePointBudget = Math.max(
      1,
      Math.floor((MAX_COPY_CODE_POINTS - [...prefix].length - separatorChars) / visible.length),
    );
    const items = visible.map((alert) =>
      clampCopy(`${alert.work} (${alert.context})`, itemBudget, itemCodePointBudget),
    );
    const body = clampCopy(`${prefix}${items.join(DIGEST_SEPARATOR)}`, MAX_BODY_CHARS);
    return withSummaryMeta({ title, body, renotify }, blocked > 0);
  }

  private retract(id: string): void {
    const alert = this.outstanding.get(id);
    if (!alert) return;
    this.outstanding.delete(id);
    this.resolveHistory(id);

    if (this.lastPrefs.mode === "per-task") {
      this.clearPaneSlot(id);
      return;
    }
    this.emit(false);
  }

  private clearPaneSlot(paneId: string): void {
    if (!this.renderedPaneIds.has(paneId)) return;
    if (this.options.sink.clearPane(paneId)) this.renderedPaneIds.delete(paneId);
  }

  private clearSlotsForMode(mode: NotifyMode): void {
    if (mode === "summary") {
      if (this.summaryRendered && this.options.sink.clear()) this.summaryRendered = false;
      return;
    }
    for (const paneId of [...this.renderedPaneIds]) {
      if (this.options.sink.clearPane(paneId)) this.renderedPaneIds.delete(paneId);
    }
  }

  private clearAllSlots(): void {
    if (this.summaryRendered && this.options.sink.clear()) this.summaryRendered = false;
    for (const paneId of [...this.renderedPaneIds]) {
      if (this.options.sink.clearPane(paneId)) this.renderedPaneIds.delete(paneId);
    }
  }

  private cancelPending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.options.clock.cancel(pending.handle);
    this.pending.delete(id);
  }
}
