import { http, HttpResponse } from "msw";

import type {
  AgentView,
  NotificationHistoryEntry,
  NotifyPrefs,
  PaneAnswerResponse,
  SessionSummary,
  SnapshotResponse,
  TabView,
  TranscriptEntry,
  WorkspaceView,
} from "@/lib/types";

// A couple of fixture agents covering the triage groups, reused across tests.
export const fixtureAgents: AgentView[] = [
  {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "blocked",
    cwd: "/home/you/webapp",
    focused: false,
  },
  {
    paneId: "w2:p1",
    workspaceId: "w2",
    workspaceLabel: "collie",
    workspaceNumber: 2,
    tabId: "w2:t1",
    agent: "codex",
    status: "working",
    cwd: "/home/you/collie",
    focused: true,
  },
];

export const fixtureShellPanes: AgentView[] = [
  {
    paneId: "w2:p2",
    workspaceId: "w2",
    workspaceLabel: "collie",
    workspaceNumber: 2,
    tabId: "w2:t2",
    agent: "shell",
    status: "unknown",
    cwd: "/home/you/collie",
    focused: false,
    kind: "shell",
  },
];

export const fixtureWorkspaces: WorkspaceView[] = [
  {
    workspaceId: "w1",
    number: 1,
    label: "webapp",
    focused: false,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 1,
  },
  {
    workspaceId: "w2",
    number: 2,
    label: "collie",
    focused: true,
    activeTabId: "w2:t1",
    tabCount: 2,
    paneCount: 2,
  },
];

export const fixtureTabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "1", focused: false, paneCount: 1 },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "code", focused: true, paneCount: 1 },
  { tabId: "w2:t2", workspaceId: "w2", number: 2, label: "shell", focused: false, paneCount: 1 },
];

// A two-session registry: the primary "default" plus a named "collie-demo". Order is primary-first,
// then alphabetical — matching the bridge contract.
export const fixtureSessions: SessionSummary[] = [
  { name: "default", isPrimary: true, reachable: true, agents: 2, working: 1, blocked: 1 },
  { name: "collie-demo", isPrimary: false, reachable: true, agents: 1, working: 1, blocked: 0 },
];

export const fixtureSnapshot: SnapshotResponse = {
  bridge: "connected",
  agents: fixtureAgents,
  shellPanes: fixtureShellPanes,
  workspaces: fixtureWorkspaces,
  tabs: fixtureTabs,
  notifications: { snoozedUntil: null },
  sessions: fixtureSessions,
  ts: 0,
};

/** A minimal two-turn transcript: a human ask and the agent's tool-call-plus-answer reply. */
export const fixtureTranscript: TranscriptEntry[] = [
  {
    uuid: "t1",
    ts: "2026-07-25T06:22:21.253Z",
    role: "user",
    parts: [{ kind: "text", text: "what changed today?" }],
  },
  {
    uuid: "t2",
    ts: "2026-07-25T06:22:24.093Z",
    role: "assistant",
    parts: [
      { kind: "tool", name: "Bash", summary: "git log --oneline", result: { text: "abc1234 fix" } },
      { kind: "text", text: "One commit: abc1234." },
    ],
  },
];
export const fixtureNotifyPrefs: NotifyPrefs = {
  blocked: true,
  done: false,
  updates: true,
  preview: "hidden",
  mode: "summary",
  layout: "task-first",
};

export const fixturePaneAnswer: PaneAnswerResponse = {
  paneId: "w1:p1",
  available: true,
  uuid: "t2",
  ts: "2026-07-25T06:22:24.093Z",
  text: "One commit: abc1234.",
  truncated: false,
};

export const fixtureNotificationHistory: NotificationHistoryEntry[] = [
  {
    id: "notification-primary",
    timestamp: 2,
    paneId: "w1:p1",
    status: "blocked",
    work: "what changed today?",
    context: "webapp",
    preview: "Choose how to continue",
  },
  {
    id: "notification-demo",
    timestamp: 1,
    session: "collie-demo",
    paneId: "w2:p1",
    status: "done",
    work: "Review notification changes",
    context: "collie",
    preview: "One commit: abc1234.",
    resolvedAt: 3,
  },
];

// ── The fake pane's input box ────────────────────────────────────────────────────────────────────
// A guarded reply (lib/reply-action.ts) types with submit:false and then polls pane reads until the
// adapter can see that text on the "❯" line — only then does it send the submit key. So the fake
// pane has to behave like a real TUI (text typed → it appears on the prompt line; submit → the line
// clears) or no guarded send would ever verify and every send test would stall.
let typedDraft = "";
/** Reset between tests (setup.ts afterEach) so a draft can't leak into the next case. */
export function resetTypedDraft(): void {
  typedDraft = "";
}
/** Record what a reply POST did to the input line — exported so tests that override the reply
 *  handler with their own can keep the fake pane honest. */
export function recordReply(body: { text?: string; submit?: boolean }): void {
  typedDraft = body.submit ? "" : body.text ?? "";
}
// 40 box glyphs is comfortably above isBoxBorder's BARE_BORDER_MIN floor (8, harness/claude/markers.ts).
const BOX_RULE = "─".repeat(40);
/**
 * `base` output with the current draft rendered inside a Claude-shaped input box below it. The box is
 * ALWAYS drawn, empty draft included — that is what a real idle Claude pane looks like, and the reply
 * path's pre-flight (`composerReady`) now reads it: a fake pane that only grew a box once text had
 * been typed would report "no input box" and refuse every send before it started.
 */
export function paneTextWithDraft(base = "hello from the pane"): string {
  return `${base}\n${BOX_RULE}\n❯ ${typedDraft}\n${BOX_RULE}`;
}

// Default happy-path handlers; individual tests can override via server.use(...).
export const handlers = [
  http.get("/api/snapshot", () => HttpResponse.json(fixtureSnapshot)),
  http.get(/\/api\/pane\/[^/]+$/, () =>
    HttpResponse.json({ paneId: "w1:p1", text: paneTextWithDraft(), truncated: false, revision: 1 }),
  ),
  http.get(/\/api\/pane\/[^/]+\/answer$/, () => HttpResponse.json(fixturePaneAnswer)),
  // Pane transcript history. Two turns, newest-anchored, with nothing older behind them.
  http.get(/\/api\/pane\/[^/]+\/history/, () =>
    HttpResponse.json({
      paneId: "w1:p1",
      available: true,
      entries: fixtureTranscript,
      hasMore: false,
      total: fixtureTranscript.length,
      fileTruncated: false,
    }),
  ),
  http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
    recordReply((await request.json()) as { text?: string; submit?: boolean });
    return HttpResponse.json({ ok: true });
  }),
  http.post(/\/api\/pane\/[^/]+\/keys$/, () => HttpResponse.json({ ok: true })),
  http.post(/\/api\/pane\/[^/]+\/close$/, () => HttpResponse.json({ ok: true })),
  http.post(/\/api\/pane\/[^/]+\/rename$/, () => HttpResponse.json({ ok: true })),
  http.post("/api/tab", () =>
    HttpResponse.json({
      ok: true,
      pane: {
        paneId: "w2:p9",
        workspaceId: "w2",
        workspaceLabel: "collie",
        tabId: "w2:t9",
        cwd: "/home/you/collie",
      },
    }),
  ),
  http.post("/api/workspace", () =>
    HttpResponse.json({
      ok: true,
      pane: {
        paneId: "w9:p1",
        workspaceId: "w9",
        workspaceLabel: "new-space",
        tabId: "w9:t1",
        cwd: "/home/you",
      },
    }),
  ),
  http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })),
  http.post("/api/notifications/snooze", async ({ request }) => {
    const { snoozedUntil } = (await request.json()) as { snoozedUntil: number | null };
    return HttpResponse.json({ snoozedUntil });
  }),
  http.get("/api/notifications/history", () =>
    HttpResponse.json({ entries: fixtureNotificationHistory }),
  ),
  http.delete("/api/notifications/history", () => new HttpResponse(null, { status: 204 })),
  http.get("/api/notifications/prefs", () => HttpResponse.json(fixtureNotifyPrefs)),
  http.post("/api/notifications/prefs", async ({ request }) => {
    const patch = (await request.json()) as Partial<NotifyPrefs>;
    return HttpResponse.json({ ...fixtureNotifyPrefs, ...patch });
  }),
  http.post("/api/update/check", () =>
    HttpResponse.json({
      current: "0.11.0",
      latest: "0.11.0",
      latestUrl: null,
      releaseAvailable: false,
      majorAvailable: null,
      majorUrl: null,
      bridgeStale: false,
      checkedAt: Date.now(),
    }),
  ),
];
