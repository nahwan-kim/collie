import { describe, expect, test } from "vitest";

import { decidePush, tagFor, visibleClientCoversPush } from "@/lib/push-decision";

describe("decidePush", () => {
  test("a clear retracts the slot regardless of client visibility", () => {
    const expected = { kind: "clear", tag: "collie:herd" };
    expect(decidePush({ type: "clear", tag: "collie:herd" }, false)).toEqual(expected);
    expect(decidePush({ type: "clear", tag: "collie:herd" }, true)).toEqual(expected);
  });

  test("suppresses a show when a Collie tab is visible", () => {
    expect(
      decidePush(
        {
          title: "claude needs you",
          tag: "collie:herd",
          silent: false,
          vibrate: [200, 100, 200],
        },
        true,
      ),
    ).toEqual({
      kind: "suppress",
    });
  });

  test("shows with the bridge-provided tag, renotify, status policy, and deep-link paneId", () => {
    const decision = decidePush(
      {
        title: "2 agents need you",
        body: "claude, codex",
        tag: "collie:herd",
        renotify: true,
        silent: false,
        vibrate: [200, 100, 200],
        data: { paneId: "p1" },
      },
      false,
    );
    expect(decision).toEqual({
      kind: "show",
      title: "2 agents need you",
      body: "claude, codex",
      tag: "collie:herd",
      paneId: "p1",
      renotify: true,
      silent: false,
      vibrate: [200, 100, 200],
    });
    expect(Object.prototype.hasOwnProperty.call(decision, "vibrate")).toBe(true);
  });

  test("omits vibration for quiet done notifications", () => {
    const decision = decidePush(
      {
        title: "Done: Review auth",
        body: "claude",
        tag: "collie:herd",
        renotify: false,
        silent: true,
        vibrate: [],
        data: { paneId: "p1" },
      },
      false,
    );
    expect(decision).toEqual({
      kind: "show",
      title: "Done: Review auth",
      body: "claude",
      tag: "collie:herd",
      paneId: "p1",
      renotify: false,
      silent: true,
    });
    expect(Object.prototype.hasOwnProperty.call(decision, "vibrate")).toBe(false);
  });

  test("omits vibration for legacy payloads", () => {
    const decision = decidePush({ data: { paneId: "test" } }, false);
    expect(decision).toEqual({
      kind: "show",
      title: "Collie",
      body: "",
      tag: "collie:test",
      paneId: "test",
      renotify: false,
      silent: undefined,
    });
    expect(Object.prototype.hasOwnProperty.call(decision, "vibrate")).toBe(false);
  });

  test("a push with no paneId and no tag shares the generic 'collie' slot", () => {
    expect(decidePush({ title: "hi" }, false)).toMatchObject({
      kind: "show",
      tag: "collie",
      paneId: undefined,
    });
  });

  test("carries a settings target through so the tap can route there", () => {
    expect(
      decidePush(
        {
          title: "Collie 0.12.0 available",
          body: "collie-ctl.sh update",
          data: { target: "settings" },
        },
        false,
      ),
    ).toMatchObject({
      kind: "show",
      title: "Collie 0.12.0 available",
      target: "settings",
      paneId: undefined,
    });
  });

  test("an agent push carries no target (defaults to the pane deep-link path)", () => {
    const decision = decidePush({ title: "claude needs you", data: { paneId: "p1" } }, false);
    expect(decision).toMatchObject({ kind: "show", paneId: "p1" });
    expect((decision as { target?: string }).target).toBeUndefined();
  });
});

describe("tagFor", () => {
  test("per-pane vs generic slot", () => {
    expect(tagFor("p1")).toBe("collie:p1");
    expect(tagFor(undefined)).toBe("collie");
  });
});
describe("visibleClientCoversPush", () => {
  const origin = "https://collie.example";
  const covers = (
    payload: Parameters<typeof visibleClientCoversPush>[0],
    clientUrl: string,
    visibilityState = "visible",
    controlled = true,
  ) => visibleClientCoversPush(payload, clientUrl, visibilityState, controlled, origin);

  test("requires a visible controlled client in the matching session", () => {
    const payload = { data: { paneId: "p1", session: "alpha" } };
    expect(covers(payload, `${origin}/` + "?s=alpha")).toBe(true);
    expect(covers(payload, `${origin}/pane/other?s=beta`)).toBe(false);
    expect(covers(payload, `${origin}/pane/other?s=alpha`, "hidden")).toBe(false);
    expect(covers(payload, `${origin}/pane/other?s=alpha`, "visible", false)).toBe(false);
  });

  test("treats an absent session as primary and does not require the exact pane", () => {
    const payload = { data: { paneId: "p1" } };
    expect(covers(payload, `${origin}/space/demo`)).toBe(true);
    expect(covers(payload, `${origin}/pane/other`)).toBe(true);
    expect(covers(payload, `${origin}/pane/other?s=alpha`)).toBe(false);
  });

  test("rejects malformed and cross-origin clients", () => {
    const payload = { data: { paneId: "p1" } };
    expect(covers(payload, `${origin.replace("https://", "http://")}/pane/p1`)).toBe(false);
    expect(covers(payload, "not a URL")).toBe(false);
  });

  test("requires a Settings route for settings-targeted pushes", () => {
    const payload = { type: "update" as const, data: { target: "settings", session: "alpha" } };
    expect(covers(payload, `${origin}/settings?s=alpha`)).toBe(true);
    expect(covers(payload, `${origin}/settings/notifications?s=alpha`)).toBe(true);
    expect(covers(payload, `${origin}/?s=alpha`)).toBe(false);
    expect(covers(payload, `${origin}/pane/p1?s=alpha`)).toBe(false);
  });
});
