import { describe, expect, test } from "bun:test";

import { latestAssistantAnswer, latestBlockedQuestion, pageEntries, TranscriptStore } from "./store.ts";
import type { JournalAdapter, TranscriptEntry, TranscriptSource } from "./types.ts";

// The store is harness-BLIND: it resolves through whatever adapter it's handed, caches by absolute
// path, and pages. So it's tested with a fake adapter rather than any real grammar — if a test here
// needs to know what Claude writes, the seam has leaked.

const entry = (uuid: string): TranscriptEntry => ({
  uuid,
  ts: "",
  role: "user",
  parts: [{ kind: "text", text: uuid }],
});

const turn = (
  uuid: string,
  role: TranscriptEntry["role"],
  parts: TranscriptEntry["parts"],
  ts = "",
): TranscriptEntry => ({ uuid, ts, role, parts });

/** Fake adapter over one in-memory log, counting stat/load so caching is observable. */
function fakeAdapter(lines: string[], opts: { complete?: boolean } = {}) {
  let text = lines.join("\n");
  let mtimeMs = 1000;
  const calls = { resolve: 0, stat: 0, load: 0, parse: 0 };
  const source: TranscriptSource = {
    async resolve(ref) {
      calls.resolve++;
      return ref.kind === "id" && ref.value !== "unknown" ? `/fake/${ref.value}.jsonl` : null;
    },
    async stat() {
      calls.stat++;
      return { size: text.length, mtimeMs };
    },
    async load() {
      calls.load++;
      return { text, complete: opts.complete ?? true, size: text.length, mtimeMs };
    },
  };
  const adapter: JournalAdapter = {
    agent: "fake",
    source,
    parse: (t) => {
      calls.parse++;
      return t.split("\n").filter(Boolean).map(entry);
    },
  };
  return {
    adapter,
    calls,
    /** Simulate the agent appending a turn — new size AND mtime, as a real write would give. */
    append: (uuid: string) => {
      text = `${text}\n${uuid}`;
      mtimeMs += 1;
    },
  };
}

const REF = { kind: "id", value: "s1" } as const;
describe("journal selectors", () => {
  test("filters roles and non-speech parts, then skips a blank/tool-only newest assistant turn", () => {
    const entries: TranscriptEntry[] = [
      turn("old", "assistant", [
        { kind: "text", text: "the answer" },
        { kind: "thinking", text: "private reasoning" },
        { kind: "tool", name: "Read", summary: "/tmp/a" },
      ]),
      turn("user", "user", [{ kind: "text", text: "not an answer" }]),
      turn("summary", "summary", [{ kind: "text", text: "compaction" }]),
      turn("note", "note", [{ kind: "text", text: "machine note" }]),
      turn("new", "assistant", [
        { kind: "text", text: "   \n\t" },
        { kind: "thinking", text: "more private reasoning" },
        { kind: "tool", name: "Bash", summary: "make changes" },
      ]),
    ];

    expect(latestAssistantAnswer(entries)).toEqual({
      uuid: "old",
      ts: "",
      text: "the answer",
      truncated: false,
    });
  });

  test("joins every nonblank text part in order and ignores blanks", () => {
    expect(
      latestAssistantAnswer([
        turn("a1", "assistant", [
          { kind: "text", text: "first" },
          { kind: "thinking", text: "hidden" },
          { kind: "text", text: "  second  " },
          { kind: "text", text: "\n" },
          { kind: "tool", name: "Read", summary: "file" },
        ], "2026-08-30T01:02:03Z"),
      ]),
    ).toEqual({
      uuid: "a1",
      ts: "2026-08-30T01:02:03Z",
      text: "first\n\n  second  ",
      truncated: false,
    });
  });

  test("propagates part truncation and clamps the aggregate answer to 64 KiB", () => {
    const propagated = latestAssistantAnswer([
      turn("a1", "assistant", [{ kind: "text", text: "short", truncated: true }]),
    ]);
    expect(propagated).toEqual({
      uuid: "a1",
      ts: "",
      text: "short",
      truncated: true,
    });

    const first = "a".repeat(40_000);
    const second = "b".repeat(40_000);
    const clamped = latestAssistantAnswer([
      turn("a2", "assistant", [
        { kind: "text", text: first },
        { kind: "text", text: second },
      ]),
    ]);
    expect(clamped).not.toBeNull();
    expect(clamped!.text).toHaveLength(64 * 1024);
    expect(clamped!.text).toBe(`${first}\n\n${second}`.slice(0, 64 * 1024));
    expect(clamped!.truncated).toBe(true);
  });

  test("prefers newest assistant speech for a blocked preview and flattens it", () => {
    expect(
      latestBlockedQuestion([
        turn("a1", "assistant", [
          { kind: "tool", name: "AskUserQuestion", summary: "old question (Yes, No)" },
        ]),
        turn("a2", "assistant", [
          { kind: "text", text: "Need approval?\n\nChoose the safe path." },
          { kind: "tool", name: "AskUserQuestion", summary: "ignored tool fallback" },
        ], "2026-08-30T01:02:03Z"),
      ]),
    ).toEqual({
      uuid: "a2",
      ts: "2026-08-30T01:02:03Z",
      text: "Need approval? Choose the safe path.",
      truncated: false,
    });
  });

  test("uses an AskUserQuestion tool summary when the newest assistant turn has no speech", () => {
    expect(
      latestBlockedQuestion([
        turn("a1", "assistant", [
          { kind: "thinking", text: "hidden" },
          { kind: "tool", name: "ask_user_question", summary: "Which mode? (Fast, Safe)" },
        ]),
      ]),
    ).toEqual({
      uuid: "a1",
      ts: "",
      text: "Which mode? (Fast, Safe)",
      truncated: false,
    });
  });

  test("rejects unrelated tool summaries and does not fall back to an older question", () => {
    expect(
      latestBlockedQuestion([
        turn("a1", "assistant", [
          { kind: "tool", name: "AskUserQuestion", summary: "old question" },
        ]),
        turn("a2", "assistant", [
          { kind: "tool", name: "Bash", summary: "rm -rf /" },
        ]),
      ]),
    ).toBeNull();
  });

  test("clamps blocked previews to 512 source characters", () => {
    const summary = latestBlockedQuestion([
      turn("a1", "assistant", [{ kind: "text", text: "x".repeat(600) }]),
    ]);
    expect(summary).not.toBeNull();
    expect(summary!.text).toHaveLength(512);
    expect(summary!.truncated).toBe(true);
  });
});

describe("TranscriptStore", () => {
  test("pages the newest turns and reports the total", async () => {
    const { adapter } = fakeAdapter(["u1", "u2", "u3"]);
    const page = await new TranscriptStore().page(adapter, REF, { limit: 2 });
    expect(page).not.toBeNull();
    expect(page!.entries.map((e) => e.uuid)).toEqual(["u2", "u3"]);
    expect(page!.hasMore).toBe(true);
    expect(page!.total).toBe(3);
    expect(page!.fileTruncated).toBe(false);
  });

  test("an unresolvable ref is null, not an error", async () => {
    const { adapter } = fakeAdapter(["u1"]);
    const page = await new TranscriptStore().page(adapter, { kind: "id", value: "unknown" }, {
      limit: 10,
    });
    expect(page).toBeNull();
  });

  // The regression this guards: the store used to read the file BEFORE consulting its cache, so
  // every "load older" tap on a multi-megabyte journal paid a full re-read to discover it already
  // had the parse. Validity is a stat; only a moved size/mtime may cost a read.
  test("a repeat read stats but does not re-read or re-parse", async () => {
    const { adapter, calls } = fakeAdapter(["u1", "u2", "u3"]);
    const store = new TranscriptStore();
    await store.page(adapter, REF, { limit: 10 });
    await store.page(adapter, REF, { limit: 10 });
    expect(calls.load).toBe(1);
    expect(calls.parse).toBe(1);
    expect(calls.stat).toBe(2);
  });

  test("a moved file is re-read and re-parsed", async () => {
    const { adapter, calls, append } = fakeAdapter(["u1", "u2"]);
    const store = new TranscriptStore();
    await store.page(adapter, REF, { limit: 10 });
    append("u3");
    const after = await store.page(adapter, REF, { limit: 10 });
    expect(calls.load).toBe(2);
    expect(after!.total).toBe(3);
    expect(after!.entries.map((e) => e.uuid)).toEqual(["u1", "u2", "u3"]);
  });

  test("a log that vanishes between resolve and read is null, not a throw", async () => {
    const { adapter } = fakeAdapter(["u1"]);
    const gone: JournalAdapter = {
      ...adapter,
      source: { ...adapter.source, stat: async () => null },
    };
    expect(await new TranscriptStore().page(gone, REF, { limit: 10 })).toBeNull();
  });

  test("a byte-capped file reports fileTruncated and keeps hasMore at its head", async () => {
    const { adapter } = fakeAdapter(["u1", "u2"], { complete: false });
    const page = await new TranscriptStore().page(adapter, REF, { limit: 10 });
    expect(page!.fileTruncated).toBe(true);
    // The window covers every parsed entry, but the log itself was clipped — there IS more behind it.
    expect(page!.hasMore).toBe(true);
  });
});

describe("pageEntries", () => {
  const entries = ["e1", "e2", "e3", "e4", "e5"].map(entry);

  test("with no cursor, anchors at the NEWEST turns", () => {
    const { window, hasMore } = pageEntries(entries, { limit: 2 });
    expect(window.map((e) => e.uuid)).toEqual(["e4", "e5"]);
    expect(hasMore).toBe(true);
  });

  test("a limit past the start yields everything and stops offering more", () => {
    expect(pageEntries(entries, { limit: 10 }).window.map((e) => e.uuid)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
      "e5",
    ]);
    expect(pageEntries(entries, { limit: 10 }).hasMore).toBe(false);
  });

  test("a cursor walks backwards from the turn the client already holds", () => {
    const { window, hasMore } = pageEntries(entries, { limit: 2, before: "e4" });
    expect(window.map((e) => e.uuid)).toEqual(["e2", "e3"]);
    expect(hasMore).toBe(true);
  });

  // An unknown cursor is expected in normal operation — a rewritten log, a stale client, or a
  // synthesised Codex cursor whose row fell out of the window. Degrading to "newest" re-renders;
  // degrading to empty would look like the history had been lost.
  test("an unknown cursor degrades to the newest page, never to empty", () => {
    const { window } = pageEntries(entries, { limit: 2, before: "gone" });
    expect(window.map((e) => e.uuid)).toEqual(["e4", "e5"]);
  });

  test("an empty journal pages to nothing without erroring", () => {
    expect(pageEntries([], { limit: 10 })).toEqual({ window: [], hasMore: false });
  });
});
