import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_NOTIFY_PREFS, NotifyPrefsStore, coerceNotifyPrefs } from "./notify-prefs.ts";
import { loadConfig } from "./config.ts";

// Notify-type prefs own which agent statuses push. The coercion is pure; the merge + disk round-trip
// is verified through a throwaway temp state dir (mirrors snooze.test.ts / push.test.ts).

const dirs: string[] = [];
async function tempCfg() {
  const stateDir = await mkdtemp(join(tmpdir(), "collie-notify-prefs-"));
  dirs.push(stateDir);
  return { ...loadConfig(), stateDir };
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("coerceNotifyPrefs", () => {
  test("fills missing, non-boolean, and invalid enum keys from defaults", () => {
    expect(coerceNotifyPrefs(undefined)).toEqual({
      blocked: true,
      done: false,
      updates: true,
      preview: "hidden",
      mode: "summary",
      layout: "task-first",
    });
    expect(coerceNotifyPrefs(null)).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(coerceNotifyPrefs({})).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(coerceNotifyPrefs({ blocked: false })).toEqual({
      ...DEFAULT_NOTIFY_PREFS,
      blocked: false,
    });
    expect(coerceNotifyPrefs({ done: true })).toEqual({
      ...DEFAULT_NOTIFY_PREFS,
      done: true,
    });
    // `updates` is a first-class key: an explicit false sticks, non-booleans fall back to the default.
    expect(coerceNotifyPrefs({ updates: false })).toEqual({
      ...DEFAULT_NOTIFY_PREFS,
      updates: false,
    });
    expect(coerceNotifyPrefs({ blocked: "yes", done: 1, updates: 0 })).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("accepts every supported enum value", () => {
    expect(
      coerceNotifyPrefs({
        preview: "all",
        mode: "per-task",
        layout: "context-first",
      }),
    ).toEqual({
      ...DEFAULT_NOTIFY_PREFS,
      preview: "all",
      mode: "per-task",
      layout: "context-first",
    });
  });

  test("replaces invalid enum values with safe defaults", () => {
    expect(
      coerceNotifyPrefs({
        preview: "full",
        mode: "per_task",
        layout: "wide",
      }),
    ).toEqual(DEFAULT_NOTIFY_PREFS);
  });
});

describe("NotifyPrefsStore", () => {
  test("defaults to blocked-on / done-off with hidden summary task-first", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    expect(store.current()).toEqual({
      blocked: true,
      done: false,
      updates: true,
      preview: "hidden",
      mode: "summary",
      layout: "task-first",
    });
  });

  test("isNotifiable follows the current prefs; other statuses are never notifiable", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    expect(store.isNotifiable("blocked")).toBe(true);
    expect(store.isNotifiable("done")).toBe(false);
    expect(store.isNotifiable("working")).toBe(false);
    expect(store.isNotifiable("idle")).toBe(false);
    await store.set({ done: true });
    expect(store.isNotifiable("done")).toBe(true);
  });

  test("set merges a partial patch, persists, and returns the updated prefs", async () => {
    const cfg = await tempCfg();
    const store = new NotifyPrefsStore(cfg);
    const updated = await store.set({
      done: true,
      updates: false,
      preview: "blocked",
      mode: "per-task",
      layout: "compact",
    });
    expect(updated).toEqual({
      blocked: true,
      done: true,
      updates: false,
      preview: "blocked",
      mode: "per-task",
      layout: "compact",
    });

    // Round-trips through disk: a fresh store reloads the same values (survives a restart).
    const reloaded = new NotifyPrefsStore(cfg);
    await reloaded.load();
    expect(reloaded.current()).toEqual(updated);
  });

  test("set ignores invalid enum values at runtime", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    const updated = await store.set({
      preview: "full" as never,
      mode: "per_task" as never,
      layout: "wide" as never,
    });
    expect(updated).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("current() returns a copy — callers can't mutate the store's state", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    const snap = store.current();
    snap.blocked = false;
    expect(store.current()).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("persists with owner-only (0600) permissions", async () => {
    const cfg = await tempCfg();
    const store = new NotifyPrefsStore(cfg);
    await store.set({ blocked: false });
    const mode = (await stat(join(cfg.stateDir, "notify-prefs.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("a partial saved file fills the missing key from defaults", async () => {
    const cfg = await tempCfg();
    await writeFile(join(cfg.stateDir, "notify-prefs.json"), JSON.stringify({ blocked: false }));
    const store = new NotifyPrefsStore(cfg);
    await store.load();
    expect(store.current()).toEqual({ ...DEFAULT_NOTIFY_PREFS, blocked: false });
  });

  test("load tolerates a missing file (keeps defaults)", async () => {
    const store = new NotifyPrefsStore(await tempCfg());
    await store.load();
    expect(store.current()).toEqual(DEFAULT_NOTIFY_PREFS);
  });
});
