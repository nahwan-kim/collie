import { useCallback, useEffect, useRef, useState } from "react";

import { getNotifyPrefs, setNotifyPrefs, type NotifyPrefs } from "@/lib/api";

// Only the three boolean notification-type keys can drive switches. Enum preferences belong to the
// delivery controls and must not accidentally become boolean toggles as NotifyPrefs grows.
export type BooleanNotifyPrefKey = {
  [K in keyof NotifyPrefs]: NotifyPrefs[K] extends boolean ? K : never;
}[keyof NotifyPrefs];

// Settings-page controller for the bridge-wide notification preferences. It loads once on mount,
// applies one optimistic partial update at a time, reconciles with the complete server response, and
// restores the complete pre-update snapshot if the request fails. These preferences live on the
// bridge and fan out to every device (like the snooze), so there's nothing per-device to persist.
export function useNotifyPrefs() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const prefsRef = useRef<NotifyPrefs | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let alive = true;
    getNotifyPrefs()
      .then((loaded) => {
        if (!alive) return;
        prefsRef.current = loaded;
        setPrefs(loaded);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback(async (patch: Partial<NotifyPrefs>) => {
    // Controls are disabled while a request is in flight, but keep this guard in the hook too so
    // callers cannot create overlapping snapshots whose late responses would overwrite each other.
    if (inFlightRef.current) return;
    const previous = prefsRef.current;
    if (!previous) return;

    const optimistic = { ...previous, ...patch };
    inFlightRef.current = true;
    prefsRef.current = optimistic;
    setPrefs(optimistic);
    setBusy(true);

    try {
      const updated = await setNotifyPrefs(patch);
      // The bridge returns its merged, complete view. It wins over the optimistic values.
      prefsRef.current = updated;
      setPrefs(updated);
    } catch {
      // Restore every field from the snapshot, not just the key that happened to trigger the update.
      prefsRef.current = previous;
      setPrefs(previous);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }, []);

  const toggle = useCallback(
    (key: BooleanNotifyPrefKey, next: boolean) => update({ [key]: next } as Partial<NotifyPrefs>),
    [update],
  );

  return { prefs, busy, update, toggle };
}
