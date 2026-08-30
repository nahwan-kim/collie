// Pure decision logic for the service worker's `push` handler, split out of sw.ts so it's
// unit-testable without service-worker globals (sw.ts itself can't run under Vitest-on-Node — it
// touches `self`, workbox, and `__WB_MANIFEST`). The SW keeps only the glue: parse the event, read
// client visibility, then perform the side effect this returns. Everything *decided* — suppress vs
// show vs clear, tag derivation, title/renotify defaults — is plain data in, plain data out.

// Payload shape is whatever bridge/push.ts sends: a render → { title, body, tag, renotify, silent,
// vibrate, data: { paneId } }; an update is `{ type: "update", target: "settings" }`; a retraction
// is `{ type: "clear", tag }`.
export interface PushPayload {
  type?: "clear" | "update";
  title?: string;
  body?: string;
  /** Notification slot. The bridge sends one shared "collie:herd" tag so the herd coalesces. */
  tag?: string;
  /** Re-alert when replacing the slot (a new agent arrived) vs. update it silently (a retraction). */
  renotify?: boolean;
  /** Whether the notification should be quiet; status policy is decided by the bridge. */
  silent?: boolean;
  /** Optional vibration pattern; status policy is decided by the bridge. */
  vibrate?: number[];
  /**
   * `session` is the registry name the pane lives in — carried so the click deep-links into it.
   * `target` names a non-pane destination for the tap (e.g. "settings" for an update notification);
   * absent = the default agent deep-link path.
   */
  data?: { paneId?: string; session?: string; target?: string };
}

export type PushDecision =
  /** Close any notification on this tag (retraction) — runs regardless of client visibility. */
  | { kind: "clear"; tag: string }
  /** A Collie tab is already visible and showing this; don't raise a redundant system notification. */
  | { kind: "suppress" }
  /** Show (or replace) the notification on this tag. */
  | {
      kind: "show";
      title: string;
      body: string;
      tag: string;
      paneId?: string;
      /** Registry name of the pane's session (undefined = primary) — for the click deep-link. */
      session?: string;
      /** Non-pane tap destination (e.g. "settings"); undefined = the default agent deep-link. */
      target?: string;
      renotify: boolean;
      silent?: boolean;
      vibrate?: number[];
    };

// Notifications share a slot so a replacement updates rather than stacks. The bridge sets the tag
// explicitly ("collie:herd"); we only fall back to a per-pane tag for direct/manual pushes.
export const tagFor = (paneId?: string): string => (paneId ? `collie:${paneId}` : "collie");

/**
 * Decide what the SW should do with a push. `hasVisibleClient` = a Collie tab is open and visible
 * (the in-app status already surfaces the alert, so the redundant system notification is suppressed
 * — but a clear still runs, since a retraction must close regardless).
 */
export function decidePush(payload: PushPayload, hasVisibleClient: boolean): PushDecision {
  const paneId = payload.data?.paneId;
  const session = payload.data?.session;
  const target = payload.data?.target;
  const tag = payload.tag ?? tagFor(paneId);
  if (payload.type === "clear") return { kind: "clear", tag };
  if (hasVisibleClient) return { kind: "suppress" };
  return {
    kind: "show",
    title: payload.title ?? "Collie",
    body: payload.body ?? "",
    tag,
    paneId,
    session,
    target,
    renotify: payload.renotify ?? false,
    silent: payload.silent,
    ...(Array.isArray(payload.vibrate) && payload.vibrate.length > 0
      ? { vibrate: payload.vibrate }
      : {}),
  };
}
function normalizeSession(session: string | null | undefined): string | undefined {
  const normalized = session?.trim();
  return normalized || undefined;
}

function colliePath(pathname: string): string | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (
    normalized === "/" ||
    normalized === "/index.html" ||
    normalized === "/settings" ||
    normalized === "/settings/notifications" ||
    /^\/space\/[^/]+$/.test(normalized) ||
    /^\/pane\/[^/]+(?:\/history)?$/.test(normalized)
  ) {
    return normalized;
  }
  return undefined;
}

/**
 * Whether a visible, controlled Collie client already covers a push.
 *
 * `appOrigin` is supplied by the service worker because a pure helper has no ambient origin. When it
 * is omitted, only origin-relative URLs are accepted; this keeps standalone callers from treating an
 * arbitrary absolute URL as same-origin. Agent pushes may be covered by any Collie route in the same
 * session. Settings-targeted pushes require a Settings route, and no client covers a clear.
 */
export function visibleClientCoversPush(
  payload: PushPayload,
  clientUrl: string,
  visibilityState: string,
  controlled: boolean,
  appOrigin?: string,
): boolean {
  if (payload.type === "clear" || visibilityState !== "visible" || !controlled) return false;

  let url: URL;
  try {
    if (appOrigin === undefined) {
      if (!clientUrl.startsWith("/")) return false;
      url = new URL(clientUrl, "https://collie.invalid");
      if (url.origin !== "https://collie.invalid") return false;
    } else {
      const origin = new URL(appOrigin).origin;
      url = new URL(clientUrl, origin);
      if (url.origin !== origin) return false;
    }
  } catch {
    return false;
  }

  const path = colliePath(url.pathname);
  if (path === undefined) return false;
  if (normalizeSession(url.searchParams.get("s")) !== normalizeSession(payload.data?.session)) {
    return false;
  }
  if (payload.data?.target === "settings") {
    return path === "/settings" || path === "/settings/notifications";
  }
  return true;
}
