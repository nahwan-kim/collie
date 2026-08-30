// Text handling every adapter shares: the caps that keep one pathological log from ballooning the
// bridge, and the escape-stripping that keeps a terminal's colour codes out of a view that renders
// text nodes rather than interpreting them.

/** Per-tool-result cap. Tool output is unbounded (a 2 MB file read); the phone only needs a gist. */
export const MAX_RESULT_CHARS = 2000;

/** Per-text-part cap. Generous — assistant prose is the thing you actually came to read. */
export const MAX_TEXT_CHARS = 20_000;

/** Longest one-line tool summary. Past this the line stops being a summary. */
const MAX_SUMMARY_CHARS = 200;

// CSI/SGR and two-character escapes. Journal text is NOT a terminal mirror — nothing downstream
// interprets escapes, so a `\x1b[2m` left in place renders as garbage glyphs on the phone.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** Strip terminal escapes from log text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Cap a string, flagging the cut so the view can say so rather than silently lying. */
export function clamp(text: string, max: number): { text: string; truncated?: boolean } {
  if (text.length <= max) return { text };
  return { text: text.slice(0, max), truncated: true };
}

/** Collapse to a single capped line — what a tool-call summary is by definition. */
export function oneLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS)}…` : line;
}

/**
 * Collapse a tool call's input object into one readable line.
 *
 * The well-known arguments get picked by name (the path, the command, the pattern); anything else
 * falls back to the first string-ish value, so a tool this code has never heard of still reads as
 * something rather than "{...}". Shared across harnesses because tool vocabularies overlap heavily —
 * every one of them has a `read`, a `shell`, and a `grep` under some spelling.
 */
export function summarizeToolInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim() !== "") return v;
      // Codex spells a shell call's `command` as an ARGV ARRAY (["bash","-lc","ls -la"]), and pi
      // passes arrays for multi-file tools — join rather than skip, or the defining argument of the
      // most common call in any log goes missing.
      if (Array.isArray(v)) {
        const joined = v.filter((x): x is string => typeof x === "string").join(" ").trim();
        if (joined !== "") return joined;
      }
    }
    return undefined;
  };
  // Order matters, and it is load-bearing: Grep carries both `pattern` and `path`, and the pattern is
  // what you actually searched for, so `pattern` MUST outrank the bare `path` (a test pins this). A
  // subagent call carries both `description`/`task` and `prompt`, and the short one is already the
  // one-line form.
  const chosen = pick(
    "file_path",
    "command",
    "pattern",
    "query",
    "url",
    "path",
    "description",
    "task",
    "prompt",
  );
  if (chosen !== undefined) return oneLine(chosen);

  const questions = summarizeAskUserQuestions(o.questions);
  if (questions !== "") return oneLine(questions);

  // Unknown tool: first string value wins, so the line is never empty for no reason.
  const fallback = Object.values(o).find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  return fallback === undefined ? "" : oneLine(fallback);
}

const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 6;
const MAX_ASK_ITEMS_INSPECTED = 32;
const MAX_ASK_OPTIONS_INSPECTED = 24;

function boundedSummaryPart(value: string): { text: string; truncated: boolean } {
  let text = "";
  let pendingSpace = false;
  for (const character of value) {
    if (/\s/u.test(character)) {
      if (text !== "") pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      if (text.length + 1 > MAX_SUMMARY_CHARS) return { text, truncated: true };
      text += " ";
      pendingSpace = false;
    }
    if (text.length + character.length > MAX_SUMMARY_CHARS) return { text, truncated: true };
    text += character;
  }
  return { text, truncated: false };
}

function summarizeAskUserQuestions(value: unknown): string {
  if (!Array.isArray(value)) return "";

  let summary = "";
  let questionCount = 0;
  let omitted = false;
  let markerAdded = false;
  let stop = false;
  let inspectedQuestions = 0;

  const append = (fragment: string): boolean => {
    const remaining = MAX_SUMMARY_CHARS - summary.length;
    if (remaining <= 0) {
      omitted = true;
      return false;
    }
    if (fragment.length <= remaining) {
      summary += fragment;
      return true;
    }
    summary += fragment.slice(0, remaining);
    omitted = true;
    return false;
  };
  const appendMarker = (fragment: string): void => {
    if (append(fragment)) markerAdded = true;
  };

  for (const item of value) {
    inspectedQuestions++;
    if (inspectedQuestions > MAX_ASK_ITEMS_INSPECTED) {
      omitted = true;
      appendMarker(summary === "" ? "…" : "; …");
      break;
    }
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = record.question;
    if (typeof question !== "string") continue;
    const questionPart = boundedSummaryPart(question);
    if (questionPart.text === "") continue;
    if (questionCount >= MAX_ASK_QUESTIONS) {
      omitted = true;
      appendMarker(summary === "" ? "…" : "; …");
      break;
    }

    const prefix = summary === "" ? "" : "; ";
    if (!append(`${prefix}${questionPart.text}`)) {
      stop = true;
      break;
    }
    questionCount++;
    if (questionPart.truncated) {
      omitted = true;
      break;
    }

    const optionsValue = record.options;
    if (!Array.isArray(optionsValue)) continue;
    let labelCount = 0;
    let omittedLabels = false;
    let hasLabels = false;
    let inspectedOptions = 0;
    for (const option of optionsValue) {
      inspectedOptions++;
      if (inspectedOptions > MAX_ASK_OPTIONS_INSPECTED) {
        omittedLabels = true;
        break;
      }
      if (option === null || typeof option !== "object") continue;
      const label = (option as Record<string, unknown>).label;
      if (typeof label !== "string") continue;
      const labelPart = boundedSummaryPart(label);
      if (labelPart.text === "") continue;
      if (labelCount >= MAX_ASK_OPTIONS) {
        omittedLabels = true;
        break;
      }
      if (!hasLabels) {
        if (!append(" (")) {
          stop = true;
          break;
        }
        hasLabels = true;
      } else if (!append(", ")) {
        stop = true;
        break;
      }
      if (!append(labelPart.text)) {
        stop = true;
        break;
      }
      labelCount++;
      if (labelPart.truncated) {
        omitted = true;
        stop = true;
        break;
      }
    }
    if (stop) break;
    if (hasLabels) {
      if (omittedLabels) appendMarker(", …)");
      else if (!append(")")) break;
    }
  }

  if (summary === "") return "";
  if (omitted && !markerAdded) summary += "…";
  return summary;
}
