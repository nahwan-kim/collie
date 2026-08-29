import type { PushMessage } from "./push.ts";
import type { AgentStatus, AgentView } from "./types.ts";

// A notification shouldn't be fire-and-forget. This coordinator gives every blocked/done alert a
// lifecycle and collapses the herd into a single, always-accurate notification:
//
//   • Debounce + cancel — an agent that blocks and unblocks within the window (you handled it at your
//     desk) never reaches your phone. Herdr exposes no "user present" signal (only a `focused` pane,
//     no activity timestamp), so we infer presence: a quickly-resolved transition is an at-desk one.
//   • Coalesce — instead of N stacked notifications, we keep ONE summary of everything currently
//     outstanding. Its copy leads with the work name, not the generic harness name, and each change
//     re-renders that single summary; when the last one resolves, we clear it.
//   • Retract — clearing an agent at the PC (or its pane closing) updates or removes the summary, so
//     handled work never lingers on your lock screen.
//
// Pure and clock-injected so `bun test` drives it without real timers: the bridge passes
// setTimeout/clearTimeout (see server.ts); tests pass a fake clock they fire on demand.

type NotifiableStatus = "blocked" | "done";

const MAX_TITLE_CHARS = 96;
const MAX_BODY_CHARS = 160;
const COPY_SEPARATOR = " · ";

function cleanLabel(value: string | null | undefined): string | undefined {
  const clean = value?.replace(/\s+/g, " ").trim();
  return clean || undefined;
}

/** Clamp by Unicode code point so an ellipsis never leaves half a surrogate pair behind. */
function clampCopy(value: string, maxChars: number): string {
  const chars = [...value];
  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars - 1).join("")}…`;
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
  for (const candidate of [agent.agent, agent.workspaceLabel, agent.tabLabel, pathTail(agent.cwd)]) {
    const label = cleanLabel(candidate);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(label);
  }
  return clampCopy(parts.join(COPY_SEPARATOR) || cleanLabel(agent.agent) || "Agent", MAX_BODY_CHARS);
}

/** The timer primitive the coordinator schedules against — real setTimeout in the bridge, fake in tests. */
export interface NotifyClock<H> {
  schedule(fn: () => void, delayMs: number): H;
  cancel(handle: H): void;
}

/** The current state of the herd's single notification, derived from everything outstanding. */
export interface HerdSummary {
  /** Headline: "Done: Review auth" for one, or "3 tasks need you" for several. */
  title: string;
  /** Compact agent/workspace context for one alert, or named work items for a digest. */
  body: string;
  /** Deep-link target when exactly one alert is outstanding; undefined for a multi-agent digest. */
  paneId?: string;
  /** Re-alert (buzz) the device — true when a new alert arrived, false on a silent retraction update. */
  renotify: boolean;
}

export interface NotifySink {
  /** Render (or replace) the herd's single notification. */
  render(summary: HerdSummary): void;
  /** Close the herd notification — nothing is outstanding any more. */
  clear(): void;
}

/** Just the transport the sink needs — "deliver this message to the devices". */
export interface PushSender {
  send(msg: PushMessage): unknown;
}
/** Just the quiet-hours check the sink needs — "are we muted right now?". */
export interface MuteGate {
  isMuted(): boolean;
}

/**
 * Build the {@link NotifySink} the coordinator drives. One session's whole herd shares one
 * notification slot (`herdTag`), so a render replaces rather than stacks; an active snooze mutes both
 * render and clear (nothing is shown, so there's nothing to close). `sessionName` (the registry name)
 * is stamped into the push payload so the service worker can deep-link to the right session — omit it
 * (undefined) for the primary, keeping its payload byte-identical to the single-session case. Kept
 * here, decoupled from `Push`/`Snooze`, so the gating + summary→message mapping is unit-testable.
 */
export function makeNotifySink(
  push: PushSender,
  mute: MuteGate,
  herdTag: string,
  sessionName?: string,
): NotifySink {
  return {
    render: (s) => {
      if (mute.isMuted()) return;
      const msg: PushMessage = { title: s.title, body: s.body, tag: herdTag, paneId: s.paneId, renotify: s.renotify };
      if (sessionName !== undefined) msg.session = sessionName;
      void push.send(msg);
    },
    clear: () => {
      if (mute.isMuted()) return;
      void push.send({ type: "clear", tag: herdTag });
    },
  };
}

interface Alert {
  agent: string;
  work: string;
  context: string;
  status: NotifiableStatus;
}

export class NotificationCoordinator<H = unknown> {
  /** paneId → debouncing alert (timer + its kind) that hasn't entered the summary yet. */
  private readonly pending = new Map<string, { handle: H; status: NotifiableStatus }>();
  /** paneId → alert that has fired and is reflected in the current summary (insertion-ordered). */
  private readonly outstanding = new Map<string, Alert>();

  constructor(
    private readonly clock: NotifyClock<H>,
    private readonly sink: NotifySink,
    private readonly delayMs: number,
    // Whether a transition into a status should notify, read live from the prefs store so a runtime
    // change is honoured. A disabled kind behaves exactly like a non-notifiable status (idle/working).
    private readonly isNotifiable: (status: AgentStatus) => boolean,
  ) {}

  /** Wire to `StateEngine.onTransition`. */
  onTransition(agent: AgentView, _from: AgentStatus, to: AgentStatus): void {
    const id = agent.paneId;
    if (!this.isNotifiable(to)) {
      // Resolved to a non-notifiable (or preference-disabled) state: drop a still-pending alert,
      // retract a delivered one.
      this.resolve(id);
      return;
    }
    // (Re)arm the debounce. A blocked→done flip lands here too, so only the latest verb survives.
    this.cancelPending(id);
    const work = workLabel(agent);
    const alert: Alert = {
      agent: cleanLabel(agent.agent) ?? "Agent",
      work,
      context: contextLabel(agent, work),
      status: to as NotifiableStatus,
    };
    const handle = this.clock.schedule(() => {
      this.pending.delete(id);
      this.outstanding.set(id, alert);
      this.emit(true);
    }, this.delayMs);
    this.pending.set(id, { handle, status: alert.status });
  }

  /** Wire to `StateEngine.onRemove` — a vanished pane is implicitly resolved. */
  onRemove(paneId: string): void {
    this.resolve(paneId);
  }

  /**
   * Re-evaluate every pending + outstanding alert against the current prefs after they change,
   * dropping any whose kind is now disabled: cancel a still-debouncing timer, retract a delivered
   * alert. Retractions re-emit the shrunk summary (or a clear) once, silently. Call after the prefs
   * store is updated (see the /api/notifications/prefs route).
   */
  applyPrefs(): void {
    // Drop pending timers for a now-disabled kind — nothing was shown yet, so no re-emit is needed.
    for (const [id, p] of [...this.pending]) {
      if (!this.isNotifiable(p.status)) this.cancelPending(id);
    }
    // Retract delivered alerts of a now-disabled kind; re-emit the shrunk summary once if any went.
    let removed = false;
    for (const [id, a] of [...this.outstanding]) {
      if (!this.isNotifiable(a.status)) {
        this.outstanding.delete(id);
        removed = true;
      }
    }
    if (removed) this.emit(false);
  }

  /**
   * Tear down this session's notifications: cancel every pending timer and retract everything
   * outstanding, closing the herd slot. Called when a session is disposed (its socket vanished) so
   * its alerts never linger on the lock screen with no live session behind them.
   */
  clearAll(): void {
    for (const id of [...this.pending.keys()]) this.cancelPending(id);
    const had = this.outstanding.size > 0;
    this.outstanding.clear();
    if (had) this.sink.clear();
  }

  private resolve(id: string): void {
    this.cancelPending(id);
    if (this.outstanding.delete(id)) this.emit(false);
  }

  /** Re-render the single herd summary from whatever's outstanding (or clear it when empty). */
  private emit(renotify: boolean): void {
    if (this.outstanding.size === 0) {
      this.sink.clear();
      return;
    }
    this.sink.render(this.summarize(renotify));
  }

  private summarize(renotify: boolean): HerdSummary {
    const entries = [...this.outstanding.entries()];
    if (entries.length === 1) {
      const [paneId, a] = entries[0]!;
      const prefix = a.status === "blocked" ? "Needs you" : "Done";
      // One outstanding task → deep-link straight to its pane on tap.
      return {
        title: clampCopy(`${prefix}: ${a.work}`, MAX_TITLE_CHARS),
        body: a.context,
        paneId,
        renotify,
      };
    }
    const alerts = entries.map(([, a]) => a);
    const n = alerts.length;
    const allBlocked = alerts.every((a) => a.status === "blocked");
    const allDone = alerts.every((a) => a.status === "done");
    const title = allBlocked
      ? `${n} tasks need you`
      : allDone
        ? `${n} tasks done`
        : `${n} tasks need attention`;
    const items = alerts.map((a) =>
      a.work.toLowerCase() === a.agent.toLowerCase() ? a.work : `${a.work} (${a.agent})`,
    );
    const body = clampCopy(items.join("; "), MAX_BODY_CHARS);
    return { title, body, renotify };
  }

  private cancelPending(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.clock.cancel(p.handle);
    this.pending.delete(id);
  }
}
