import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ActivityLedger } from "./activity.ts";
import { AuditLog, fileAuditAppender } from "./audit.ts";
import { loadConfig, type Config } from "./config.ts";
import { EventPoker } from "./event-poker.ts";
import { DEFAULT_TIMEOUT_MS, HerdrClient } from "./herdr-client.ts";
import {
  NotificationCoordinator,
  makeNotifySink,
  reconcileStartupNotificationSlots,
  type NotifyClock,
} from "./notifications.ts";
import { adapterFor, buildJournalRegistry } from "./journal/registry.ts";
import { latestAssistantAnswer, latestBlockedQuestion, TranscriptStore } from "./journal/store.ts";
import { NotificationHistoryStore } from "./notify-history.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import { Push } from "./push.ts";
import { startServer } from "./server.ts";
import {
  deriveConfigRoot,
  herdTagFor,
  SessionRegistry,
  type SessionFactory,
} from "./sessions.ts";
import { Snooze } from "./snooze.ts";
import { StateEngine } from "./state-engine.ts";
import type { AgentView } from "./types.ts";
import {
  bridgeStampSync,
  githubTagsFetcher,
  UpdateMonitor,
  UpdateStateStore,
} from "./update.ts";
import { SWEEP_INTERVAL_MS, sweepUploads } from "./uploads.ts";

// How often the registry rescans the filesystem for sessions that appeared/disappeared after boot.
const SESSION_REFRESH_MS = 15_000;
// Upstream release check cadence. Releases are rare, so poll every few hours; the first check is
// delayed so we never probe the network mid-boot.
const UPDATE_FIRST_DELAY_MS = 90_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PREVIEW_TIMEOUT_MS = 1500;
// Entry point: resolve config, wire the pieces, start polling and serving.
// loadConfig throws on a config that would be unsafe to serve (a non-loopback bind). Print the
// reason alone — a stack trace here buries the one line the operator needs.
let cfg: Config;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`[bridge] FATAL: ${(err as Error).message}`);
  process.exit(1);
}

// Ensure the state dir exists with private (0700) perms before push/snooze/uploads write into it —
// it holds push subscription endpoints and uploaded images, so keep it owner-only.
await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });

// ── Process-global services, shared across every session ─────────────────────
const push = new Push(cfg);
await push.init();

const snooze = new Snooze(cfg);
await snooze.load();

const notifyPrefs = new NotifyPrefsStore(cfg);
await notifyPrefs.load();

const history = new NotificationHistoryStore(cfg);
await history.load();
// A restart under a stricter current policy must not resurrect preview text persisted by an older
// configuration. Reconcile before the history API or any coordinator can observe the rows.
await history.reconcilePrivacy(notifyPrefs.current().preview);
await reconcileStartupNotificationSlots(push, history.list());

// Transcript readers are process-global so every session shares one bounded parse cache. Keep both
// references null when the feature is disabled, preserving the cheap no-transcript path.
const journals = cfg.transcript ? buildJournalRegistry(cfg.journalRoots) : null;
const transcripts = cfg.transcript ? new TranscriptStore() : null;

// When each pane last moved, and when you last looked at it — the two numbers the dashboard sorts
// and triages by (see activity.ts). Process-global and keyed by session name, because pane ids are
// session-scoped and collide across sessions.
const activity = new ActivityLedger(cfg);
await activity.load();

// Append-only audit trail of write-level actions (see audit.ts). A write failure here is swallowed
// inside record() so it can never break the user action it's auditing.
const audit = new AuditLog(fileAuditAppender(join(cfg.stateDir, "audit.log")), {
  content: cfg.auditContent,
});

// ── Update-availability monitor ───────────────────────────────────────────────
// The running plugin version, captured NOW at module load — never re-read from disk later, or a
// post-pull package.json would mask the very update we detect (same class of bug as the buildId gap).
// The bridge-source stamp is snapshotted here too, so a rebuilt-but-not-restarted process reads stale.
const bridgeDir = import.meta.dir;
const rootDir = join(bridgeDir, "..");
const currentVersion = (
  JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as { version: string }
).version;

const updateStore = new UpdateStateStore(cfg);
await updateStore.load();

// The repo the release check + release links point at. Defaults to Collie's own; overridable for a
// fork (or a synthetic test target) via COLLIE_UPDATE_REPO.
const updateRepo = process.env.COLLIE_UPDATE_REPO?.trim() || "AltanS/collie";
const updateMonitor = new UpdateMonitor({
  repo: updateRepo,
  current: currentVersion,
  startupStamp: bridgeStampSync(bridgeDir, rootDir),
  fetchTags: githubTagsFetcher(updateRepo),
  bridgeStamp: () => bridgeStampSync(bridgeDir, rootDir),
  store: updateStore,
  now: Date.now,
  // The `updates` notify pref is the off-switch — update pushes bypass snooze, so this is their gate.
  updatesEnabled: () => notifyPrefs.current().updates,
  notify: (latest) =>
    void push.send({
      type: "update",
      tag: "collie:update",
      // No command in the body — the tap opens Settings (target below), and the update banner / linked
      // release page carry the location-independent Herdr actions. Keeps this off the cwd-dependent path.
      title: "Collie update available",
      body: `Version ${latest} is available`,
      target: "settings",
    }),
});

// First check delayed (don't probe mid-boot); then every few hours. unref() so neither timer holds
// the process open; both cleared on shutdown.
const updateFirstCheck = setTimeout(() => void updateMonitor.checkRelease(), UPDATE_FIRST_DELAY_MS);
updateFirstCheck.unref();
const updateTimer = setInterval(() => void updateMonitor.checkRelease(), UPDATE_INTERVAL_MS);
updateTimer.unref();

// ── Per-session runtime factory ──────────────────────────────────────────────
// One HerdrClient + StateEngine + EventPoker + NotificationCoordinator per herdr session. The
// registry calls this for the primary at construction and for each session discovered later. Push,
// snooze, notify-prefs, history, journal readers, the audit log and uploads dir stay process-global.
const makeSession: SessionFactory = (name, socketPath, isPrimary) => {
  const herdr = new HerdrClient(socketPath, DEFAULT_TIMEOUT_MS, cfg.dialMode);
  const engine = new StateEngine(herdr, cfg.pollMs);

  // Event-poked polling: a long-lived events.subscribe stream pokes an immediate re-poll on any herd
  // change, and while it's healthy the interval relaxes to the safety-net cadence. Events are ONLY a
  // poke — the snapshot poll stays the source of truth — so a missed event costs one interval, not
  // correctness. The fresh snapshot after any pane lifecycle change re-scopes the subscriptions.
  const poker = new EventPoker(herdr);
  poker.onPoke(() => engine.pokeNow());
  poker.onHealth((h) => engine.setCadence(h ? cfg.pollIdleMs : cfg.pollMs));
  engine.onUpdate((s) => poker.setAgentPanes(s.agents.map((a) => a.paneId)));

  // Activity bookkeeping. A status change stamps `activeAt` (the only thing that can make a pane
  // read as unseen); every successful poll reconciles the ledger against the panes that exist, which
  // seeds first sightings as already-seen and reaps closed ones. Reconciling covers bare shells too,
  // which the engine's agent-derived removal event never reports.
  engine.onTransition((agent) => activity.noteActive(name, agent.paneId));
  engine.onUpdate((s) =>
    activity.reconcile(name, [...s.agents, ...s.shellPanes].map((p) => p.paneId)),
  );

  // Background notifications on lifecycle transitions (foreground toasts are computed client-side by
  // diffing snapshots). Each session gets its own coordinator + notification slot: the primary keeps
  // the bare `collie:herd` tag (so pre-feature notifications don't orphan) and omits the session name
  // from the payload; every other session tags `collie:herd:<name>` and carries the name for deep-links.
  const clock: NotifyClock<ReturnType<typeof setTimeout>> = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h),
  };
  const sink = makeNotifySink(push, snooze, herdTagFor(isPrimary, name), isPrimary ? undefined : name);
  const notifications = new NotificationCoordinator({
    clock,
    sink,
    delayMs: cfg.notifyDelayMs,
    isNotifiable: (status) => notifyPrefs.isNotifiable(status),
    prefs: () => notifyPrefs.current(),
    preview: async (
      transitioned: AgentView,
      status: "blocked" | "done",
    ): Promise<string | undefined> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutResult = new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), PREVIEW_TIMEOUT_MS);
      });
      const read = (async (): Promise<string | undefined> => {
        if (journals === null || transcripts === null) return undefined;
        const current = engine.current();
        const pane = [...current.agents, ...current.shellPanes].find(
          (candidate) => candidate.paneId === transitioned.paneId,
        );
        if (!pane?.agentSession) return undefined;
        const adapter = adapterFor(journals, pane.agent);
        if (adapter === undefined) return undefined;
        const page = await transcripts.page(adapter, pane.agentSession, {
          limit: Number.MAX_SAFE_INTEGER,
        });
        if (page === null) return undefined;
        const selection =
          status === "blocked"
            ? latestBlockedQuestion(page.entries)
            : latestAssistantAnswer(page.entries);
        return selection?.text;
      })();
      try {
        return await Promise.race([read, timeoutResult]);
      } catch {
        return undefined;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
    history: {
      record: (draft) => history.record(isPrimary ? draft : { ...draft, session: name }),
      resolve: (paneId) => history.resolve(isPrimary ? undefined : name, paneId),
    },
  });
  engine.onTransition((agent, from, to) => notifications.onTransition(agent, from, to));
  engine.onRemove((paneId) => notifications.onRemove(paneId));

  engine.start();
  poker.start();
  return { herdr, engine, poker, notifications };
};

// List the session directory names under `<configRoot>/sessions` (empty if the dir doesn't exist).
const listSessionDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const registry = new SessionRegistry({
  configRoot: deriveConfigRoot(cfg.socketPath),
  primarySocketPath: cfg.socketPath,
  factory: makeSession,
  multiSession: cfg.multiSession,
  listSessionDirs,
  exists: (p) => existsSync(p),
});

// Fail soft with a clear message if the PRIMARY Herdr isn't reachable at startup. Other sessions come
// up lazily via refresh(); an unreachable one just reads `reachable:false` in the sessions list.
const primary = registry.get();
if (primary && !(await primary.herdr.ping())) {
  console.warn(
    `[bridge] cannot reach Herdr socket at ${cfg.socketPath} yet — ` +
      `will keep retrying on the poll loop. Is the Herdr server running?`,
  );
}

// Discover any already-running named sessions now, then rescan on an interval so a session
// started/stopped after boot is picked up (or disposed) within SESSION_REFRESH_MS. A no-op when
// multi-session is off. unref() so the timer never keeps the process alive; cleared on shutdown.
await registry.refresh();
const refreshTimer = setInterval(() => void registry.refresh(), SESSION_REFRESH_MS);
refreshTimer.unref();

// Prune uploaded images past their TTL: once at startup, then on an interval. Uploads are single-use
// (Herdr reads them by path when the message is sent), so nothing else reclaims them. unref() so the
// timer never keeps the process alive; it's also cleared on shutdown.
const uploadsDir = join(cfg.stateDir, "uploads");
void sweepUploads(uploadsDir).then((removed) => {
  if (removed.length) console.log(`[uploads] swept ${removed.length} expired image(s) at startup`);
});
const sweepTimer = setInterval(() => {
  void sweepUploads(uploadsDir).then((removed) => {
    if (removed.length) console.log(`[uploads] swept ${removed.length} expired image(s)`);
  });
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

const server = startServer({
  cfg,
  registry,
  push,
  snooze,
  notifyPrefs,
  updateMonitor,
  audit,
  activity,
  journals,
  transcripts,
  history,
});

const shutdown = async () => {
  console.log("\n[bridge] shutting down");
  // Stop every producer before the final push flush. Otherwise an update/session timer can enqueue
  // after flush observes an empty queue and immediately before process exit.
  clearInterval(refreshTimer);
  clearInterval(sweepTimer);
  clearTimeout(updateFirstCheck);
  clearInterval(updateTimer);
  // Stop accepting new connections and let in-flight requests drain briefly (non-forced stop). A
  // release check can already be awaiting the network when its timer is cleared, so quiesce the monitor
  // before session disposal and the final push flush. SessionRegistry.refresh has no asynchronous
  // continuation: its scan/spawn/dispose work finishes synchronously before its promise is returned.
  await server.stop();
  await updateMonitor.flush();
  registry.disposeAll();
  await push.flush();
  // Writes are debounced, so the last few seconds of "you looked at this" live only in memory —
  // persist them before exiting, or every restart quietly resurrects alerts you'd already cleared.
  activity.stop();
  await activity.flush();
  await history.flush();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
