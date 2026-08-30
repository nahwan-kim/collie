import { BellRing, Loader2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useNotifyPrefs } from "@/hooks/use-notify-prefs";
import { cn } from "@/lib/utils";

const PRIVACY_OPTIONS = [
  { value: "hidden", label: "Work only", hint: "No conversation content." },
  { value: "blocked", label: "Questions", hint: "Blocked questions only." },
  {
    value: "all",
    label: "Questions & answers",
    hint: "Warning: conversation content appears on every device lock screen and in history.",
  },
] as const;

const LAYOUT_OPTIONS = [
  { value: "task-first", label: "Task first" },
  { value: "context-first", label: "Context first" },
  { value: "compact", label: "Compact" },
] as const;

function SegmentButton({
  value,
  label,
  hint,
  selected,
  disabled,
  hintId,
  vertical = false,
  onClick,
}: {
  value: string;
  label: string;
  hint?: string;
  selected: boolean;
  disabled: boolean;
  hintId?: string;
  vertical?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-value={value}
      aria-label={label}
      aria-pressed={selected}
      aria-describedby={hintId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 flex-col justify-center rounded-md px-3 py-2 text-sm transition-colors",
        vertical ? "w-full items-start text-left" : "flex-1 items-center text-center",
        selected
          ? "bg-primary font-medium text-primary-foreground"
          : "text-muted-foreground active:bg-muted",
      )}
    >
      <span>{label}</span>
      {hint && (
        <span id={hintId} className="mt-0.5 text-xs font-normal leading-snug">
          {hint}
        </span>
      )}
    </button>
  );
}

/**
 * Bridge-wide notification delivery policy. Every choice is persisted with the same notification
 * preference endpoint and fans out to all devices; this card intentionally has no device-local or
 * free-form template setting.
 */
export function NotifyDeliveryControl() {
  const { prefs, busy, update } = useNotifyPrefs();
  const disabled = busy || !prefs;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <BellRing className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">Notification delivery</div>
            <p className="text-sm text-muted-foreground">
              Bridge-wide settings apply to all devices.
            </p>
          </div>
        </div>
        {!prefs && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      <section className="border-t border-border/60 p-3" aria-labelledby="notify-privacy-heading">
        <h3 id="notify-privacy-heading" className="text-sm font-medium">
          Privacy
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose how much conversation content notifications may show.
        </p>
        <div
          role="group"
          aria-label="Privacy"
          className="mt-2 flex flex-col gap-1 rounded-lg bg-muted/50 p-1"
        >
          {PRIVACY_OPTIONS.map((option) => (
            <SegmentButton
              key={option.value}
              value={option.value}
              label={option.label}
              hint={option.hint}
              hintId={`notify-privacy-${option.value}-hint`}
              vertical
              selected={prefs?.preview === option.value}
              disabled={disabled}
              onClick={() => void update({ preview: option.value })}
            />
          ))}
        </div>
      </section>

      <section className="border-t border-border/60 p-3" aria-labelledby="notify-mode-heading">
        <h3 id="notify-mode-heading" className="text-sm font-medium">
          Delivery mode
        </h3>
        <div className="mt-2 flex min-h-11 items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">Separate task notifications</div>
            <p className="text-xs text-muted-foreground">
              Off: summary notifications. On: per-task notifications.
            </p>
          </div>
          <Switch
            checked={prefs?.mode === "per-task"}
            disabled={disabled}
            onCheckedChange={(next) =>
              void update({ mode: next ? "per-task" : "summary" })
            }
            aria-label="Separate task notifications"
          />
        </div>
      </section>

      <section className="border-t border-border/60 p-3" aria-labelledby="notify-layout-heading">
        <h3 id="notify-layout-heading" className="text-sm font-medium">
          Layout
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose the order of task and context details.
        </p>
        <div role="group" aria-label="Layout" className="mt-2 flex gap-1 rounded-lg bg-muted/50 p-1">
          {LAYOUT_OPTIONS.map((option) => (
            <SegmentButton
              key={option.value}
              value={option.value}
              label={option.label}
              selected={prefs?.layout === option.value}
              disabled={disabled}
              onClick={() => void update({ layout: option.value })}
            />
          ))}
        </div>
      </section>
    </Card>
  );
}
