import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { NotifyPreview } from "./notify-prefs.ts";
import type { NotificationHistoryEntry } from "./types.ts";

const MAX_ENTRIES = 100;
const MAX_ID_LENGTH = 128;
const MAX_SESSION_LENGTH = 128;
const MAX_PANE_ID_LENGTH = 256;
const MAX_WORK_LENGTH = 256;
const MAX_CONTEXT_LENGTH = 256;
const MAX_PREVIEW_LENGTH = 512;
/** ECMAScript TimeClip accepts epoch milliseconds in this inclusive range. */
const MAX_DATE_MS = 8_640_000_000_000_000;
const CONTROL_CHARACTERS = /\p{Cc}+/gu;
const BIDI_CONTROLS = /\p{Bidi_Control}+/gu;
/** Values made only from whitespace, default-ignorables, or combining marks have no readable copy. */
const UNREADABLE_VALUE = /^[\s\p{Default_Ignorable_Code_Point}\p{M}]+$/u;

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

/**
 * Normalize a persisted string while keeping controls and layout whitespace out of the wire shape.
 * Identifier fields reject overlong values; user-visible fields pass `truncate=true` so one hostile
 * field cannot discard an otherwise valid history row.
 */
function boundedString(value: unknown, maxLength: number, truncate = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(BIDI_CONTROLS, " ")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || UNREADABLE_VALUE.test(normalized)) return undefined;

  const codePoints = [...normalized];
  if (codePoints.length <= maxLength) return normalized;
  if (!truncate) return undefined;

  return codePoints.slice(0, maxLength).join("");
}

function validDateMilliseconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_DATE_MS
  );
}

function coerceEntry(value: unknown): NotificationHistoryEntry | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const id = boundedString(raw.id, MAX_ID_LENGTH);
  const paneId = boundedString(raw.paneId, MAX_PANE_ID_LENGTH);
  const work = boundedString(raw.work, MAX_WORK_LENGTH, true);
  const context = boundedString(raw.context, MAX_CONTEXT_LENGTH, true);
  const timestamp = raw.timestamp;
  const status = raw.status;
  if (
    !id ||
    !paneId ||
    !work ||
    !context ||
    !validDateMilliseconds(timestamp) ||
    (status !== "blocked" && status !== "done")
  ) {
    return null;
  }

  let session: string | undefined;
  if (raw.session !== undefined) {
    session = boundedString(raw.session, MAX_SESSION_LENGTH);
    if (!session || /[\\/]/.test(session)) return null;
  }

  let preview: string | undefined;
  if (raw.preview !== undefined) {
    preview = boundedString(raw.preview, MAX_PREVIEW_LENGTH, true);
    if (!preview) return null;
  }

  let resolvedAt: number | undefined;
  if (raw.resolvedAt !== undefined) {
    if (!validDateMilliseconds(raw.resolvedAt)) return null;
    resolvedAt = raw.resolvedAt;
  }

  const entry: NotificationHistoryEntry = {
    id,
    timestamp,
    paneId,
    status,
    work,
    context,
  };
  if (session !== undefined) entry.session = session;
  if (preview !== undefined) entry.preview = preview;
  if (resolvedAt !== undefined) entry.resolvedAt = resolvedAt;
  return entry;
}

function copyEntry(entry: NotificationHistoryEntry): NotificationHistoryEntry {
  return { ...entry };
}

export interface NotificationHistoryDeps {
  now?: () => number;
  id?: () => string;
}

/**
 * Owner-only, bounded history of structured notification content. The store never accepts rendered
 * title/body strings or session references/paths, so preview privacy changes can remove only the
 * optional preview field without parsing old notification copy.
 */
export class NotificationHistoryStore {
  private entries: NotificationHistoryEntry[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(
    private readonly cfg: Pick<Config, "stateDir">,
    deps: NotificationHistoryDeps = {},
  ) {
    this.file = join(cfg.stateDir, "notification-history.json");
    this.now = deps.now ?? Date.now;
    this.idFactory = deps.id ?? randomUUID;
  }

  async load(): Promise<void> {
    await this.writing.catch(() => {});
    this.entries = [];
    try {
      const raw = await Bun.file(this.file).json();
      if (!Array.isArray(raw)) return;
      const parsed = raw
        .map((row) => coerceEntry(row))
        .filter((row): row is NotificationHistoryEntry => row !== null);
      parsed.sort((a, b) => b.timestamp - a.timestamp);
      this.entries = parsed.slice(0, MAX_ENTRIES);
    } catch {
      /* none saved yet, corrupt, or unreadable — start empty */
    }
  }

  async record(
    entry: Omit<NotificationHistoryEntry, "id" | "timestamp"> & { timestamp?: number },
  ): Promise<NotificationHistoryEntry> {
    const raw = asRecord(entry);
    const candidate = raw
      ? {
          id: this.idFactory(),
          timestamp: raw.timestamp === undefined ? this.now() : raw.timestamp,
          session: raw.session,
          paneId: raw.paneId,
          status: raw.status,
          work: raw.work,
          context: raw.context,
          preview: raw.preview,
          resolvedAt: raw.resolvedAt,
        }
      : null;
    const normalized = coerceEntry(candidate);
    if (!normalized) throw new TypeError("invalid notification history entry");

    this.entries.unshift(normalized);
    this.entries.sort((a, b) => b.timestamp - a.timestamp);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    await this.enqueueSave();
    return copyEntry(normalized);
  }

  async resolve(session: string | undefined, paneId: string, resolvedAt?: number): Promise<void> {
    const normalizedPaneId = boundedString(paneId, MAX_PANE_ID_LENGTH);
    const normalizedSession =
      session === undefined ? undefined : boundedString(session, MAX_SESSION_LENGTH);
    if (
      !normalizedPaneId ||
      (session !== undefined && (!normalizedSession || /[\\/]/.test(normalizedSession)))
    ) {
      return;
    }

    const at = resolvedAt === undefined ? this.now() : resolvedAt;
    if (!validDateMilliseconds(at)) return;
    const index = this.entries.findIndex(
      (entry) =>
        entry.resolvedAt === undefined &&
        entry.paneId === normalizedPaneId &&
        entry.session === normalizedSession,
    );
    if (index === -1) return;
    const match = this.entries[index];
    if (!match) return;
    this.entries[index] = { ...match, resolvedAt: at };
    await this.enqueueSave();
  }

  list(): NotificationHistoryEntry[] {
    return this.entries.map(copyEntry);
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.enqueueSave();
  }

  async scrubPreviews(status?: NotificationHistoryEntry["status"]): Promise<void> {
    let changed = false;
    for (const entry of this.entries) {
      if (status !== undefined && entry.status !== status) continue;
      if (entry.preview === undefined) continue;
      delete entry.preview;
      changed = true;
    }
    if (changed) await this.enqueueSave();
  }
  /**
   * Remove legacy previews that are not allowed by the currently loaded privacy policy. Startup calls
   * this after loading preferences and history so an old file cannot briefly expose a downgraded value.
   */
  async reconcilePrivacy(previewPolicy: NotifyPreview): Promise<void> {
    if (previewPolicy === "hidden") {
      await this.scrubPreviews();
    } else if (previewPolicy === "blocked") {
      await this.scrubPreviews("done");
    }
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  private enqueueSave(): Promise<void> {
    const payload = JSON.stringify(this.entries.map(copyEntry), null, 2);
    const next = this.writing.catch(() => {}).then(async () => {
      await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
      await chmod(this.cfg.stateDir, 0o700);
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, payload, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    });
    this.writing = next;
    return next;
  }
}
