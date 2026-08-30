import { describe, expect, test } from "bun:test";

import {
  NotificationCoordinator,
  makeNotifySink,
  paneTagFor,
  reconcileStartupNotificationSlots,
  type HerdSummary,
  type NotifyClock,
  type NotifySink,
  type NotificationHistoryRecorder,
} from "./notifications.ts";
import type { NotifyLayout, NotifyMode, NotifyPreview } from "./notify-prefs.ts";
import { summaryTopicFor } from "./push.ts";
import type { PushMessage } from "./push.ts";
import type { AgentStatus, AgentView } from "./types.ts";

class FakeClock implements NotifyClock<number> {
  private readonly timers = new Map<number, () => void>();
  private next = 1;

  schedule(fn: () => void, _delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, fn);
    return id;
  }

  cancel(handle: number): void {
    this.timers.delete(handle);
  }

  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }

  get armed(): number {
    return this.timers.size;
  }
}

type Event =
  | { kind: "render"; summary: HerdSummary }
  | { kind: "clear" }
  | { kind: "renderPane"; summary: HerdSummary }
  | { kind: "clearPane"; paneId: string };

class RecordingSink implements NotifySink {
  readonly events: Event[] = [];
  muted = false;
  // Like the production sink, only renders are muted; lifecycle clears always get through.

  render(summary: HerdSummary): boolean {
    if (this.muted) return false;
    this.events.push({ kind: "render", summary });
    return true;
  }

  clear(): boolean {
    this.events.push({ kind: "clear" });
    return true;
  }

  renderPane(summary: HerdSummary): boolean {
    if (this.muted) return false;
    this.events.push({ kind: "renderPane", summary });
    return true;
  }

  clearPane(paneId: string): boolean {
    this.events.push({ kind: "clearPane", paneId });
    return true;
  }

  get last(): HerdSummary | undefined {
    const event = this.events.at(-1);
    return event?.kind === "render" || event?.kind === "renderPane" ? event.summary : undefined;
  }

  get renders(): HerdSummary[] {
    return this.events.flatMap((event) =>
      event.kind === "render" || event.kind === "renderPane" ? [event.summary] : [],
    );
  }

  get clears(): number {
    return this.events.filter((event) => event.kind === "clear").length;
  }
}

function agentNamed(
  paneId: string,
  name: string,
  status: AgentStatus,
  overrides: Partial<AgentView> = {},
): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: name,
    status,
    cwd: "/home/you/demo",
    focused: false,
    kind: "agent",
    ...overrides,
  };
}

const agent = (paneId: string, status: AgentStatus) => agentNamed(paneId, "claude", status);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

type TestPrefs = {
  blocked: boolean;
  done: boolean;
  preview: NotifyPreview;
  mode: NotifyMode;
  layout: NotifyLayout;
};

function setup(
  patch: Partial<TestPrefs> = {},
  provider: (pane: AgentView, status: "blocked" | "done") => Promise<string | undefined> =
    async () => undefined,
  history?: NotificationHistoryRecorder,
) {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const live: TestPrefs = {
    blocked: true,
    done: true,
    preview: "hidden",
    mode: "summary",
    layout: "task-first",
    ...patch,
  };
  const isNotifiable = (status: AgentStatus): boolean =>
    status === "blocked" ? live.blocked : status === "done" ? live.done : false;
  const coord = new NotificationCoordinator({
    clock,
    sink,
    delayMs: 30_000,
    isNotifiable,
    prefs: () => ({ preview: live.preview, mode: live.mode, layout: live.layout }),
    preview: provider,
    history,
  });
  return { clock, sink, coord, prefs: live };
}

describe("NotificationCoordinator — debounce and provider lifecycle", () => {
  test("keeps the default copy byte-equivalent and attempts a hidden preview", async () => {
    let calls = 0;
    const { clock, sink, coord } = setup({}, async () => {
      calls += 1;
      return "secret question";
    });
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    expect(clock.armed).toBe(1);
    clock.fireAll();
    await flush();
    expect(calls).toBe(1);
    expect(sink.last).toEqual({
      title: "Needs you: demo",
      body: "claude",
      paneId: "p1",
      renotify: true,
    });
  });

  test("provider rejection degrades to no preview instead of dropping the alert", async () => {
    const { clock, sink, coord } = setup({}, async () => {
      throw new Error("journal unavailable");
    });
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    await flush();
    expect(sink.last?.body).toBe("claude");
  });

  test("resolve invalidates an in-flight provider and cannot emit stale copy", async () => {
    let resolvePreview!: (value: string) => void;
    const provider = () => new Promise<string>((resolve) => (resolvePreview = resolve));
    const { clock, sink, coord } = setup({ preview: "all" }, provider);
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.onRemove("p1");
    resolvePreview("stale question");
    await flush();
    expect(sink.events).toEqual([]);
  });

  test("a status flip invalidates the old provider and only promotes the latest status", async () => {
    const pending: Array<(value: string) => void> = [];
    const provider = (_pane: AgentView, status: "blocked" | "done") =>
      new Promise<string>((resolve) => {
        pending.push((value) => resolve(`${status}: ${value}`));
      });
    const { clock, sink, coord } = setup({ done: true, preview: "all" }, provider);
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.onTransition(agent("p1", "done"), "blocked", "done");
    pending[0]!('old');
    await flush();
    expect(sink.events).toEqual([]);
    clock.fireAll();
    pending[1]!('new');
    await flush();
    expect(sink.last?.title).toBe("Done: demo");
    expect(sink.last?.body).toContain("done: new");
  });

  test("clearAll invalidates pending async work and retracts rendered slots", async () => {
    let resolvePreview!: (value: string) => void;
    const provider = () => new Promise<string>((resolve) => (resolvePreview = resolve));
    const { clock, sink, coord } = setup({ preview: "all" }, provider);
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.clearAll();
    resolvePreview("stale");
    await flush();
    expect(sink.events).toEqual([]);
  });
  test("clearAll invalidates an unresolved preview before a same-pane transition starts a new generation", async () => {
    const pending: Array<(value: string) => void> = [];
    const provider = (_pane: AgentView, status: "blocked" | "done") =>
      new Promise<string>((resolve) => {
        pending.push((value) => resolve(`${status}: ${value}`));
      });
    const { clock, sink, coord } = setup({ preview: "all" }, provider);
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    coord.clearAll();
    coord.onTransition(agent("p1", "done"), "blocked", "done");
    clock.fireAll();

    pending[1]!('new');
    await flush();
    expect(sink.last).toMatchObject({
      title: "Done: demo",
      body: "done: new · claude",
    });
    pending[0]!('old');
    await flush();
    expect(sink.events).toHaveLength(1);
  });
});

describe("NotificationCoordinator — privacy and layouts", () => {
  for (const preview of ["hidden", "blocked", "all"] as const) {
    test(`privacy ${preview} gates blocked and done previews`, async () => {
      const { clock, sink, coord } = setup(
        { preview },
        async (_pane, status) => `${status} preview`,
      );
      coord.onTransition(agent("blocked", "blocked"), "working", "blocked");
      clock.fireAll();
      await flush();
      expect(sink.last?.body).toBe(
        preview === "hidden" ? "claude" : "blocked preview · claude",
      );

      const done = setup({ preview, done: true }, async () => "done preview");
      done.coord.onTransition(agent("done", "done"), "working", "done");
      done.clock.fireAll();
      await flush();
      expect(done.sink.last?.body).toBe(preview === "all" ? "done preview · claude" : "claude");
    });
  }

  test("task-first retains the historical title and puts allowed preview before context", async () => {
    const { clock, sink, coord } = setup(
      { preview: "all", layout: "task-first" },
      async () => "Question?\n1. Yes",
    );
    coord.onTransition(
      agentNamed("p1", "claude", "blocked", { terminalTitle: "Review auth" }),
      "working",
      "blocked",
    );
    clock.fireAll();
    await flush();
    expect(sink.last).toEqual({
      title: "Needs you: Review auth",
      body: "Question? 1. Yes · claude · demo",
      paneId: "p1",
      renotify: true,
    });
  });

  test("context-first leads with context and places status/work in the body", async () => {
    const { clock, sink, coord } = setup(
      { preview: "all", layout: "context-first" },
      async () => "Question?",
    );
    coord.onTransition(
      agentNamed("p1", "claude", "blocked", { terminalTitle: "Review auth" }),
      "working",
      "blocked",
    );
    clock.fireAll();
    await flush();
    expect(sink.last).toEqual({
      title: "claude · demo",
      body: "Needs you: Review auth · Question?",
      paneId: "p1",
      renotify: true,
    });
  });

  test("compact uses status/work in the title and preview-or-context in the body", async () => {
    const { clock, sink, coord } = setup(
      { preview: "all", layout: "compact" },
      async () => "Question?",
    );
    coord.onTransition(
      agentNamed("p1", "claude", "done", { terminalTitle: "Ship release" }),
      "working",
      "done",
    );
    clock.fireAll();
    await flush();
    expect(sink.last).toEqual({
      title: "Done · Ship release",
      body: "Question?",
      paneId: "p1",
      renotify: true,
    });
  });

  test("multi summary never includes conversational preview and mixed title has exact counts", async () => {
    const { clock, sink, coord } = setup({ preview: "all" }, async () => "secret");
    coord.onTransition(agentNamed("p1", "claude", "blocked", { paneLabel: "Review" }), "working", "blocked");
    coord.onTransition(agentNamed("p2", "codex", "done", { paneLabel: "Ship" }), "working", "done");
    clock.fireAll();
    await flush();
    expect(sink.last?.title).toBe("1 need you · 1 done");
    expect(sink.last?.body).toBe("Review (claude · demo); Ship (codex · demo)");
    expect(sink.last?.body).not.toContain("secret");
  });
  test("clearRendered clears the summary slot without resolving outstanding history", async () => {
    const records: unknown[] = [];
    const resolves: string[] = [];
    const history: NotificationHistoryRecorder = {
      record: (draft) => records.push(draft),
      resolve: (paneId) => resolves.push(paneId),
    };
    const { clock, sink, coord, prefs } = setup(
      { mode: "summary", preview: "all" },
      async () => "question",
      history,
    );
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    await flush();

    coord.clearRendered();
    coord.clearRendered();
    expect(sink.clears).toBe(1);
    expect(resolves).toEqual([]);
    expect(records).toHaveLength(1);

    prefs.layout = "compact";
    coord.applyPrefs();
    expect(sink.last).toMatchObject({
      title: "Needs you · demo",
      body: "question",
      renotify: false,
    });
    expect(records).toHaveLength(1);
    expect(resolves).toEqual([]);
  });

  test("applyPrefs silently re-renders preview/layout changes and mode switch clears old slots", async () => {
    const { clock, sink, coord, prefs } = setup({ preview: "hidden" }, async () => "question");
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    await flush();
    prefs.preview = "all";
    prefs.layout = "compact";
    coord.applyPrefs();
    expect(sink.last).toMatchObject({ title: "Needs you · demo", body: "question", renotify: false });

    prefs.preview = "hidden";
    coord.applyPrefs();
    expect(sink.events.at(-2)).toEqual({ kind: "clear" });
    expect(sink.events.at(-1)).toMatchObject({
      kind: "render",
      summary: { body: "claude", renotify: false },
    });

    prefs.mode = "per-task";
    coord.applyPrefs();
    expect(sink.events.at(-2)).toEqual({ kind: "clear" });
    expect(sink.events.at(-1)).toMatchObject({ kind: "renderPane" });

    prefs.preview = "all";
    coord.applyPrefs();
    prefs.preview = "hidden";
    coord.applyPrefs();
    expect(sink.events.at(-2)).toEqual({ kind: "clearPane", paneId: "p1" });
    expect(sink.events.at(-1)).toMatchObject({ kind: "renderPane" });

    prefs.mode = "summary";
    coord.applyPrefs();
    expect(sink.events.at(-2)).toMatchObject({ kind: "clearPane", paneId: "p1" });
    expect(sink.events.at(-1)).toMatchObject({ kind: "render", summary: { renotify: false } });
  });
});

describe("NotificationCoordinator — lifecycle, mode and history", () => {
  test("per-task mode renders and clears only its pane", async () => {
    const { clock, sink, coord } = setup({ mode: "per-task" });
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    coord.onTransition(agent("p2", "blocked"), "working", "blocked");
    clock.fireAll();
    await flush();
    expect(sink.events.filter((event) => event.kind === "renderPane")).toHaveLength(2);
    coord.onRemove("p1");
    expect(sink.events.at(-1)).toEqual({ kind: "clearPane", paneId: "p1" });
    expect(sink.events.filter((event) => event.kind === "clearPane")).toHaveLength(1);
  });
  test("clearRendered clears every pane slot and display changes restore them silently", async () => {
    const { clock, sink, coord, prefs } = setup({ mode: "per-task" });
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    coord.onTransition(agent("p2", "blocked"), "working", "blocked");
    clock.fireAll();
    await flush();
    expect(sink.events.filter((event) => event.kind === "renderPane")).toHaveLength(2);

    coord.clearRendered();
    coord.clearRendered();
    expect(sink.events.filter((event) => event.kind === "clearPane")).toEqual([
      { kind: "clearPane", paneId: "p1" },
      { kind: "clearPane", paneId: "p2" },
    ]);

    prefs.layout = "compact";
    coord.applyPrefs();
    const renders = sink.events.filter((event) => event.kind === "renderPane");
    expect(renders).toHaveLength(4);
    expect(renders.slice(-2)).toEqual([
      expect.objectContaining({ summary: expect.objectContaining({ paneId: "p1", renotify: false }) }),
      expect.objectContaining({ summary: expect.objectContaining({ paneId: "p2", renotify: false }) }),
    ]);
  });

  test("kind disable retracts an outstanding alert and clearAll removes every old slot", async () => {
    const { clock, sink, coord, prefs } = setup({ mode: "per-task" });
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    coord.onTransition(agent("p2", "blocked"), "working", "blocked");
    clock.fireAll();
    await flush();
    prefs.blocked = false;
    coord.applyPrefs();
    expect(sink.events.at(-1)).toEqual({ kind: "clearPane", paneId: "p2" });
    coord.clearAll();
    expect(sink.events.filter((event) => event.kind === "clearPane")).toHaveLength(2);
  });

  test("history records only a render accepted by an unmuted sink and applies privacy", async () => {
    const records: unknown[] = [];
    const history: NotificationHistoryRecorder = {
      record: (draft) => records.push(draft),
      resolve: () => undefined,
    };
    const { clock, sink, coord, prefs } = setup({ preview: "blocked" }, async () => "question", history);
    coord.onTransition(agent("p1", "blocked"), "working", "blocked");
    clock.fireAll();
    await flush();
    expect(records).toEqual([
      { paneId: "p1", status: "blocked", work: "demo", context: "claude", preview: "question" },
    ]);
    prefs.preview = "hidden";
    coord.applyPrefs();
    expect(records).toHaveLength(1);

    const muted = setup({ preview: "all" }, async () => "not recorded", history);
    muted.sink.muted = true;
    muted.coord.onTransition(agent("p2", "blocked"), "working", "blocked");
    muted.clock.fireAll();
    await flush();
    expect(records).toHaveLength(1);
    expect(sink.events.length).toBeGreaterThan(0);
  });
});

describe("makeNotifySink", () => {
  const summary: HerdSummary = {
    title: "Needs you: Ship release",
    body: "claude · demo",
    paneId: "w1:p1",
    renotify: true,
  };

  class RecordingPush {
    readonly sent: PushMessage[] = [];
    send(msg: PushMessage): void {
      this.sent.push(msg);
    }
  }

  test("summary render maps urgency/silent while preserving the herd tag", () => {
    const push = new RecordingPush();
    const sink = makeNotifySink(push, { isMuted: () => false }, "collie:herd");
    expect(sink.render(summary)).toBe(true);
    expect(push.sent).toEqual([
      {
        title: "Needs you: Ship release",
        body: "claude · demo",
        tag: "collie:herd",
        paneId: "w1:p1",
        renotify: true,
        silent: false,
        vibrate: [200, 100, 200],
        urgency: "high",
      },
    ]);
  });

  test("per-task render/clear use stable collision-safe tag and hashed topic", () => {
    const push = new RecordingPush();
    const sink = makeNotifySink(push, { isMuted: () => false }, "collie:herd", "session/a");
    expect(sink.renderPane(summary)).toBe(true);
    expect(sink.clearPane("w1:p1")).toBe(true);
    expect(push.sent[0]!.tag).toBe(paneTagFor("collie:herd", "w1:p1"));
    expect(push.sent[0]!.topic).toMatch(/^[A-Za-z0-9_-]{18}$/);
    expect(push.sent[0]!.topic).toBe(push.sent[1]!.topic);
    expect(push.sent[0]).toMatchObject({
      silent: false,
      vibrate: [200, 100, 200],
      urgency: "high",
    });
    expect(push.sent[1]).toMatchObject({ type: "clear", urgency: "high" });
  });
  test("done renders are silent, normal urgency, and do not vibrate", () => {
    const push = new RecordingPush();
    const sink = makeNotifySink(push, { isMuted: () => false }, "collie:herd");
    const done: HerdSummary = {
      title: "Done: Ship release",
      body: "claude · demo",
      paneId: "w1:p1",
      renotify: true,
    };

    expect(sink.render(done)).toBe(true);
    expect(sink.renderPane(done)).toBe(true);
    expect(push.sent[0]).toMatchObject({
      tag: "collie:herd",
      paneId: "w1:p1",
      silent: true,
      urgency: "normal",
    });
    expect(push.sent[1]).toMatchObject({
      tag: paneTagFor("collie:herd", "w1:p1"),
      paneId: "w1:p1",
      silent: true,
      urgency: "normal",
    });
    expect("vibrate" in push.sent[0]!).toBe(false);
    expect("vibrate" in push.sent[1]!).toBe(false);
  });
  test("named summary render and clear share a deterministic session topic", () => {
    const push = new RecordingPush();
    const session = "session/with:hostile-id";
    const sink = makeNotifySink(push, { isMuted: () => false }, "collie:herd:session", session);

    expect(sink.render(summary)).toBe(true);
    expect(sink.clear()).toBe(true);

    expect(push.sent[0]).toMatchObject({
      tag: "collie:herd:session",
      session,
      topic: summaryTopicFor(session),
    });
    expect(push.sent[1]).toMatchObject({
      type: "clear",
      tag: "collie:herd:session",
      topic: summaryTopicFor(session),
    });
    expect(push.sent[0]!.topic).toBe(push.sent[1]!.topic);
  });

  test("primary summary keeps the legacy collapse topic", () => {
    const push = new RecordingPush();
    const sink = makeNotifySink(push, { isMuted: () => false }, "collie:herd");

    sink.render(summary);
    sink.clear();

    expect(push.sent[0]!.topic).toBeUndefined();
    expect(push.sent[1]!.topic).toBeUndefined();
  });

  test("fire-and-forget push rejection is handled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const push = { send: () => Promise.reject(new Error("delivery failed")) };
      const sink = makeNotifySink(push, { isMuted: () => false }, "collie:herd");
      expect(sink.render(summary)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("muted sinks suppress renders but still deliver lifecycle clears", () => {
    const push = new RecordingPush();
    const sink = makeNotifySink(push, { isMuted: () => true }, "collie:herd");
    expect(sink.render(summary)).toBe(false);
    expect(sink.renderPane(summary)).toBe(false);
    expect(sink.clear()).toBe(true);
    expect(sink.clearPane("p1")).toBe(true);
    expect(push.sent).toHaveLength(2);
    expect(push.sent[0]).toEqual({
      type: "clear",
      tag: "collie:herd",
      urgency: "high",
    });
    expect(push.sent[1]).toMatchObject({
      type: "clear",
      tag: paneTagFor("collie:herd", "p1"),
      urgency: "high",
    });
  });
});


describe("startup notification slot reconciliation", () => {
  test("clears resolved and unresolved primary/named slots once, then flushes", async () => {
    const sent: PushMessage[] = [];
    let flushes = 0;
    const entry = (
      paneId: string,
      session?: string,
      resolvedAt?: number,
    ): import("./types.ts").NotificationHistoryEntry => ({
      id: `${session ?? "default"}:${paneId}:${resolvedAt ?? "open"}`,
      timestamp: 1,
      paneId,
      status: "done",
      work: "work",
      context: "context",
      ...(session === undefined ? {} : { session }),
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
    });

    await reconcileStartupNotificationSlots(
      {
        send(message) {
          sent.push(message);
        },
        async flush() {
          flushes++;
        },
      },
      [entry("p1"), entry("p1", undefined, 2), entry("p2", "alpha", 3)],
    );

    expect(flushes).toBe(1);
    expect(sent).toHaveLength(5);
    expect(sent.every((message) => message.type === "clear")).toBe(true);
    expect(sent.filter((message) => message.tag === "collie:herd")).toHaveLength(1);
    expect(sent.filter((message) => message.tag === paneTagFor("collie:herd", "p1"))).toHaveLength(1);
    expect(sent.filter((message) => message.tag === "collie:herd:alpha")).toHaveLength(2);
    expect(
      sent.filter((message) => message.tag === paneTagFor("collie:herd:alpha", "p2")),
    ).toHaveLength(1);
  });

  test("still flushes an empty reconciliation batch", async () => {
    let flushed = false;
    await reconcileStartupNotificationSlots(
      {
        send() {
          throw new Error("not called");
        },
        async flush() {
          flushed = true;
        },
      },
      [],
    );
    expect(flushed).toBe(true);
  });
});
