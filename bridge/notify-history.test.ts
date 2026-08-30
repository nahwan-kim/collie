import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.ts";
import { NotificationHistoryStore } from "./notify-history.ts";

const dirs: string[] = [];

async function tempCfg() {
  const stateDir = await mkdtemp(join(tmpdir(), "collie-notify-history-"));
  dirs.push(stateDir);
  return { ...loadConfig(), stateDir };
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("NotificationHistoryStore", () => {
  test("records newest-first, caps history at 100, and returns defensive copies", async () => {
    let nextId = 0;
    const store = new NotificationHistoryStore(await tempCfg(), {
      id: () => `entry-${nextId++}`,
    });
    for (let i = 0; i < 105; i += 1) {
      await store.record({
        paneId: `pane-${i}`,
        status: "blocked",
        work: `work-${i}`,
        context: `context-${i}`,
        timestamp: i,
      });
    }

    const rows = store.list();
    expect(rows).toHaveLength(100);
    expect(rows[0]?.work).toBe("work-104");
    expect(rows.at(-1)?.work).toBe("work-5");
    rows[0]!.work = "changed";
    expect(store.list()[0]?.work).toBe("work-104");
  });

  test("uses injected id and clock when recording without optional fields", async () => {
    const store = new NotificationHistoryStore(await tempCfg(), {
      now: () => 1234,
      id: () => "fixed-id",
    });
    const row = await store.record({
      paneId: "pane",
      status: "done",
      work: "work",
      context: "context",
    });
    expect(row).toEqual({
      id: "fixed-id",
      timestamp: 1234,
      paneId: "pane",
      status: "done",
      work: "work",
      context: "context",
    });
  });

  test("loads valid rows, trims strings, and drops malformed rows", async () => {
    const cfg = await tempCfg();
    await writeFile(
      join(cfg.stateDir, "notification-history.json"),
      JSON.stringify([
        {
          id: " valid ",
          timestamp: 20,
          session: "session",
          paneId: " pane ",
          status: "done",
          work: " work ",
          context: " context ",
          preview: " preview ",
          resolvedAt: 30,
          title: "discard rendered title",
        },
        { id: "bad", timestamp: "20", paneId: "p", status: "done", work: "w", context: "c" },
        { id: "bad", timestamp: Number.NaN, paneId: "p", status: "done", work: "w", context: "c" },
        { id: "bad", timestamp: 1, paneId: "p", status: "working", work: "w", context: "c" },
        { id: "bad", timestamp: 1, paneId: "p", status: "done", work: "w", context: "c", session: "/tmp/session" },
        { id: "bad", timestamp: 1, paneId: "p", status: "done", work: " ", context: "c" },
        "not an object",
      ]),
    );
    const store = new NotificationHistoryStore(cfg);
    await store.load();
    expect(store.list()).toEqual([
      {
        id: "valid",
        timestamp: 20,
        session: "session",
        paneId: "pane",
        status: "done",
        work: "work",
        context: "context",
        preview: "preview",
        resolvedAt: 30,
      },
    ]);
  });

  test("sanitizes hostile strings, truncates visible fields, and ignores raw path fields", async () => {
    const cfg = await tempCfg();
    await writeFile(
      join(cfg.stateDir, "notification-history.json"),
      JSON.stringify([
        {
          id: "\u202E valid \u202C",
          timestamp: 8_640_000_000_000_000,
          session: " session\u0007name ",
          paneId: " pane\u0008id ",
          status: "blocked",
          work: "w".repeat(300),
          context: "c".repeat(300),
          preview: "p".repeat(600),
          resolvedAt: -8_640_000_000_000_000,
          path: "/private/should-never-leave-the-store",
        },
      ]),
    );

    const store = new NotificationHistoryStore(cfg);
    await store.load();
    const row = store.list()[0];
    expect(row).toMatchObject({
      id: "valid",
      timestamp: 8_640_000_000_000_000,
      session: "session name",
      paneId: "pane id",
      status: "blocked",
      resolvedAt: -8_640_000_000_000_000,
    });
    expect(row?.work).toHaveLength(256);
    expect(row?.context).toHaveLength(256);
    expect(row?.preview).toHaveLength(512);
    expect(row && "path" in row).toBe(false);
  });

  test("rejects unreadable values and timestamps outside the JavaScript Date range", async () => {
    const cfg = await tempCfg();
    const valid = {
      id: "entry",
      timestamp: 1,
      paneId: "pane",
      status: "done",
      work: "work",
      context: "context",
    };
    await writeFile(
      join(cfg.stateDir, "notification-history.json"),
      JSON.stringify([
        { ...valid, id: "\u200B" },
        { ...valid, id: "\u0301" },
        { ...valid, id: "\u0000" },
        { ...valid, session: "../x" },
        { ...valid, session: "..\\x" },
        { ...valid, timestamp: 8_640_000_000_000_001 },
        { ...valid, timestamp: -8_640_000_000_000_001 },
        { ...valid, resolvedAt: 8_640_000_000_000_001 },
      ]),
    );

    const store = new NotificationHistoryStore(cfg);
    await store.load();
    expect(store.list()).toEqual([]);
  });
  test("missing, corrupt, and non-array files load as empty", async () => {
    const cfg = await tempCfg();
    const store = new NotificationHistoryStore(cfg);
    await store.load();
    expect(store.list()).toEqual([]);
    await writeFile(join(cfg.stateDir, "notification-history.json"), "not json");
    await store.load();
    expect(store.list()).toEqual([]);
    await writeFile(join(cfg.stateDir, "notification-history.json"), JSON.stringify({ entries: [] }));
    await store.load();
    expect(store.list()).toEqual([]);
  });

  test("resolves the newest unresolved exact session and pane match", async () => {
    let now = 100;
    let nextId = 0;
    const store = new NotificationHistoryStore(await tempCfg(), {
      now: () => now,
      id: () => `entry-${nextId++}`,
    });
    await store.record({ session: "one", paneId: "pane", status: "blocked", work: "old", context: "c", timestamp: 1 });
    await store.record({ session: "one", paneId: "pane", status: "blocked", work: "new", context: "c", timestamp: 2 });
    await store.record({ session: "two", paneId: "pane", status: "blocked", work: "other-session", context: "c", timestamp: 3 });
    await store.record({ session: "one", paneId: "other", status: "blocked", work: "other-pane", context: "c", timestamp: 4 });
    await store.record({ paneId: "pane", status: "blocked", work: "primary", context: "c", timestamp: 5 });

    now = 99;
    await store.resolve("one", "pane");
    expect(store.list().find((row) => row.work === "new")?.resolvedAt).toBe(99);
    expect(store.list().find((row) => row.work === "old")?.resolvedAt).toBeUndefined();
    await store.resolve("one", "pane", 100);
    expect(store.list().find((row) => row.work === "old")?.resolvedAt).toBe(100);
    await store.resolve(undefined, "pane", 101);
    expect(store.list().find((row) => row.work === "primary")?.resolvedAt).toBe(101);
    expect(store.list().find((row) => row.work === "other-session")?.resolvedAt).toBeUndefined();
  });

  test("scrubs previews without changing structured work or context and persists", async () => {
    const cfg = await tempCfg();
    const store = new NotificationHistoryStore(cfg, { id: () => "entry" });
    await store.record({
      paneId: "pane",
      status: "blocked",
      work: "work",
      context: "context",
      preview: "assistant answer",
    });
    await store.scrubPreviews();
    expect(store.list()).toEqual([
      { id: "entry", timestamp: expect.any(Number), paneId: "pane", status: "blocked", work: "work", context: "context" },
    ]);

    const reloaded = new NotificationHistoryStore(cfg);
    await reloaded.load();
    expect(reloaded.list()[0]?.preview).toBeUndefined();
    expect(reloaded.list()[0]?.work).toBe("work");
  });
  test("scrubs previews for only the requested status", async () => {
    const store = new NotificationHistoryStore(await tempCfg(), {
      id: (() => {
        let next = 0;
        return () => `entry-${next++}`;
      })(),
    });
    await store.record({
      paneId: "blocked-pane",
      status: "blocked",
      work: "blocked work",
      context: "context",
      preview: "blocked question",
    });
    await store.record({
      paneId: "done-pane",
      status: "done",
      work: "done work",
      context: "context",
      preview: "assistant answer",
    });

    await store.scrubPreviews("done");

    expect(store.list().find((row) => row.status === "blocked")?.preview).toBe("blocked question");
    expect(store.list().find((row) => row.status === "done")?.preview).toBeUndefined();
  });
  test("reconciles loaded previews for the active privacy policy", async () => {
    const store = new NotificationHistoryStore(await tempCfg(), {
      id: (() => {
        let next = 0;
        return () => `entry-${next++}`;
      })(),
    });
    await store.record({
      paneId: "blocked-pane",
      status: "blocked",
      work: "blocked work",
      context: "context",
      preview: "question",
    });
    await store.record({
      paneId: "done-pane",
      status: "done",
      work: "done work",
      context: "context",
      preview: "answer",
    });

    await store.reconcilePrivacy("blocked");
    expect(store.list().find((row) => row.status === "blocked")?.preview).toBe("question");
    expect(store.list().find((row) => row.status === "done")?.preview).toBeUndefined();

    await store.reconcilePrivacy("hidden");
    expect(store.list().every((row) => row.preview === undefined)).toBe(true);
  });

  test("clear persists an empty history", async () => {
    const cfg = await tempCfg();
    const store = new NotificationHistoryStore(cfg, { id: () => "entry" });
    await store.record({ paneId: "pane", status: "done", work: "work", context: "context" });
    await store.clear();
    expect(store.list()).toEqual([]);
    const reloaded = new NotificationHistoryStore(cfg);
    await reloaded.load();
    expect(reloaded.list()).toEqual([]);
  });

  test("serializes concurrent writes and flush waits for persistence", async () => {
    const cfg = await tempCfg();
    let nextId = 0;
    const store = new NotificationHistoryStore(cfg, {
      id: () => `entry-${nextId++}`,
      now: () => 50,
    });
    const first = store.record({ paneId: "one", status: "blocked", work: "one", context: "c" });
    const second = store.record({ paneId: "two", status: "done", work: "two", context: "c" });
    await store.flush();
    await Promise.all([first, second]);
    const reloaded = new NotificationHistoryStore(cfg);
    await reloaded.load();
    expect(reloaded.list().map((row) => row.work).sort()).toEqual(["one", "two"]);
    expect(await readFile(join(cfg.stateDir, "notification-history.json"), "utf8")).toContain("entry-0");
  });

  test("persists history with owner-only (0600) permissions", async () => {
    const cfg = await tempCfg();
    const store = new NotificationHistoryStore(cfg);
    await store.record({ paneId: "pane", status: "done", work: "work", context: "context" });
    const mode = (await stat(join(cfg.stateDir, "notification-history.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
