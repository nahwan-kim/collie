import { useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useLoaderData, useNavigate } from "react-router";

import { StatusArea } from "@/components/status-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { clearNotificationHistory } from "@/lib/api";
import { type NotificationHistoryData } from "@/lib/loaders";
import { panePath, settingsPath } from "@/lib/nav";
import { setStatus } from "@/lib/status";
import type { NotificationHistoryEntry } from "@/lib/types";

export function NotificationHistoryRoute() {
  const data = useLoaderData() as NotificationHistoryData;
  const navigate = useNavigate();
  const [entries, setEntries] = useState(data.entries);
  const [busy, setBusy] = useState(false);
  const { confirm } = usePendingConfirm();

  const empty = entries.length === 0;

  async function clear() {
    if (busy || empty) return;
    if (!confirm("notification-history")) {
      setStatus("Tap again to clear notification history", "info");
      return;
    }

    setBusy(true);
    try {
      await clearNotificationHistory();
      setEntries([]);
      setStatus("Notification history cleared", "success");
    } catch {
      setStatus("Couldn't clear notification history", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 py-2 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          onClick={() => navigate(settingsPath(data.session))}
          aria-label="Back"
        >
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="min-w-0 flex-1 text-lg font-semibold tracking-tight">Notifications</h1>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          onClick={() => void clear()}
          disabled={empty || busy}
          aria-label="Clear notification history"
        >
          {busy ? <Loader2 className="size-5 animate-spin" /> : <Trash2 className="size-5" />}
        </Button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {data.error ? (
          <p className="py-16 text-center text-sm text-status-blocked">
            Couldn't load notification history.
          </p>
        ) : empty ? (
          <p className="py-16 text-center text-sm text-muted-foreground">No notifications yet.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            {entries.map((entry) => (
              <NotificationRow key={entry.id} entry={entry} onOpen={() => navigate(panePath(entry.paneId, entry.session))} />
            ))}
          </div>
        )}
      </main>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-screen-sm px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]">
        <StatusArea />
      </div>
    </div>
  );
}

function NotificationRow({
  entry,
  onOpen,
}: {
  entry: NotificationHistoryEntry;
  onOpen: () => void;
}) {
  const blocked = entry.status === "blocked";
  const StatusIcon = blocked ? TriangleAlert : CheckCircle2;
  const statusLabel = blocked ? "Blocked" : "Done";
  const secondary = entry.preview || entry.context;
  const date = dateForTimestamp(entry.timestamp);
  const timestamp = formatTimestamp(entry.timestamp);

  return (
    <button
      type="button"
      data-notification-id={entry.id}
      onClick={onOpen}
      className="flex min-h-11 w-full items-start gap-3 border-b border-border/60 p-4 text-left transition-colors last:border-b-0 active:bg-muted/60"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span
            className={blocked ? "flex items-center gap-1 text-status-blocked" : "flex items-center gap-1 text-status-done"}
          >
            <StatusIcon className="size-3.5 shrink-0" aria-hidden />
            <span>{statusLabel}</span>
          </span>
          {entry.resolvedAt !== undefined && (
            <Badge variant="outline" className="border-status-done/30 text-status-done">
              Handled
            </Badge>
          )}
          <time className="text-muted-foreground" dateTime={date?.toISOString()}>
            {timestamp}
          </time>
        </div>
        <div className="mt-1 break-words font-medium">{entry.work}</div>
        <div className="mt-0.5 break-words text-sm text-muted-foreground">{secondary}</div>
      </div>
      <ChevronRight className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

const MAX_TIMESTAMP = 8_640_000_000_000_000;

function dateForTimestamp(timestamp: number): Date | undefined {
  if (!Number.isFinite(timestamp) || timestamp < -MAX_TIMESTAMP || timestamp > MAX_TIMESTAMP) {
    return undefined;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatTimestamp(timestamp: number): string {
  const date = dateForTimestamp(timestamp);
  return (
    date?.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }) ?? "Unknown time"
  );
}
