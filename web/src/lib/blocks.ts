// Semantic Block AST — the intermediate representation between the ANSI parse and the React
// renderer. `raw` mirrors terminal output verbatim; every other kind lifts a dialog into a typed
// payload the renderer draws as buttons. Those payloads are harness-NEUTRAL contracts, each in its
// own harness/*-model.ts (re-exported below): what ANY adapter promises when it emits that kind, so
// the renderers and the race guard are written against the model, never against a harness's
// internals. The discriminated union is shaped so further grammars (tool calls, …) are added as new
// `kind`s without disturbing these.
//
// The pipeline is: parseAnsi(text) → AnsiSegment[] → splitLines(segments) → StyledLine[] →
// buildBlocks(lines, ctx) → Block[]. splitLines (and the pure helpers below) live here; the
// block-BUILDING step is the harness DISPATCHER (harness/index) routing to a per-agent adapter, so
// this core module has NO dependency on the agent grammars — the edge is one-way, which is what lets
// an adapter import this AST without forming a cycle. These functions are PURE (no React) and,
// together with the parser, run once per unique text (memoised by the renderer), so they're off the
// hot polling path. The Claude grammars themselves (prompt-select detection, chrome stripping) live
// in harness/claude; which agents get them is decided by the adapter registry (harness/registry).
//
// Invariant (relied on by find-in-output): joining every RAW block's line text with "\n" reproduces
// the visible mirror text character-for-character. Find operates on global character offsets over
// that string; a prompt-select block is rendered as buttons, so its text is NOT part of that space
// (find covers the raw mirror only).

import type { AnsiSegment } from "./ansi";
import { PURE_HORIZONTAL_RULE_GLYPH_CLASS } from "./rule-glyphs";
import type { PromptModel } from "./harness/prompt-model";
import type { WizardModel } from "./harness/wizard-model";
import type { PreviewSelectModel } from "./harness/preview-model";
import type { MultiSelectModel } from "./harness/multi-select-model";
import type { MenuModel } from "./harness/menu-model";
import type { AutocompleteModel } from "./harness/autocomplete-model";

// Re-export every dialog model so consumers (the block components, the race guards) have one import
// site for the AST's typed payloads. All five are harness-NEUTRAL contracts (harness/*-model.ts):
// the payload an adapter promises when it emits that block kind, not a Claude internal — the
// dependency points at the shared modules, never at claude/. These are TYPE-ONLY re-exports (erased
// under verbatimModuleSyntax), so they add no runtime edge into harness/ either — the value
// dependency stays one-way (harness → blocks).
export type {
  PromptModel,
  PromptOption,
  PromptFamily,
  PromptFeedbackPurpose,
} from "./harness/prompt-model";
export type { WizardModel, WizardOption, WizardStepChip, WizardAnswer } from "./harness/wizard-model";
export type { PreviewSelectModel, PreviewOption, PreviewNote } from "./harness/preview-model";
export type {
  MultiSelectModel,
  MultiSelectOption,
  MultiSelectEscape,
  MultiPointer,
} from "./harness/multi-select-model";
export type { MenuModel, MenuAction, MenuNav, MenuLeftRight } from "./harness/menu-model";
export type { AutocompleteModel, AutocompleteEntry } from "./harness/autocomplete-model";

/** One visual line: the styled segments that make it up, with the line-terminating "\n" removed. */
export interface StyledLine {
  segments: AnsiSegment[];
  /** Keep this known terminal-width rule or framed grid row on one visual row when the mirror wraps. */
  noWrap?: true;
}

/** A run of raw terminal output. Renders as verbatim styled text (the T1 mirror). */
export interface RawBlock {
  kind: "raw";
  lines: StyledLine[];
}

/**
 * A single-choice Claude dialog lifted out of the raw mirror and rendered as native buttons. It
 * REPLACES the menu region ([firstOption … tail]) in place; the question and any preamble stay in
 * the raw block above it. `lines` is the raw region it replaced — retained for provenance only; it
 * is NOT rendered as text and NOT part of the find haystack (find runs over raw blocks only).
 */
export interface PromptSelectBlock {
  kind: "prompt-select";
  prompt: PromptModel;
  lines: StyledLine[];
}

/**
 * A multi-question AskUserQuestion wizard (the stepper dialog) lifted out of the raw mirror and
 * rendered as a native step-by-step form. Like `prompt-select` it REPLACES its region
 * ([stepper header … tail]) in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface WizardBlock {
  kind: "wizard";
  wizard: WizardModel;
  lines: StyledLine[];
}

/**
 * A preview-variant AskUserQuestion (options + preview pane + the per-question note affordance;
 * grammar/NOTES_NOTES.md) lifted out of the raw mirror. Like the other dialog blocks it REPLACES
 * its region in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface PreviewSelectBlock {
  kind: "preview-select";
  preview: PreviewSelectModel;
  lines: StyledLine[];
}

/**
 * A multi-select AskUserQuestion (the checkbox form + its review screen) lifted out of the raw
 * mirror and rendered as native checkboxes / a confirm screen. Like the other dialog blocks it
 * REPLACES its region in place; `lines` is provenance only — not rendered, not searchable.
 */
export interface MultiSelectBlock {
  kind: "multi-select";
  multi: MultiSelectModel;
  lines: StyledLine[];
}

/**
 * A GENERIC modal menu (the `/model` picker and its kin) claimed by the last-resort footer grammar —
 * a screen no specific dialog grammar owns, driven by the keys it printed in its own footer. Unlike
 * the dialog blocks above, its region text IS rendered: the grammar understands the footer, not the
 * body, so the body has to stay readable for the buttons under it to mean anything. `lines` is that
 * region — still not part of the find haystack (find runs over raw blocks only).
 */
export interface MenuBlock {
  kind: "menu";
  menu: MenuModel;
  lines: StyledLine[];
}

/**
 * The agent's own COMPLETION POPUP while the operator types into its input box (Claude's slash-command
 * menu). Unlike every other non-`raw` kind this one is PRESENTATIONAL: it emits no keystrokes and has
 * no row in harness/dialog-contract.ts, because nothing on that screen owns the keyboard — the input
 * box is live underneath it and the composer must stay free to type. `lines` is the popup's own region
 * (provenance; the block renders the parsed entries, not the text) and is not part of the find
 * haystack.
 */
export interface AutocompleteBlock {
  kind: "autocomplete";
  autocomplete: AutocompleteModel;
  lines: StyledLine[];
}

/**
 * A semantic block. A discriminated union on `kind`; new members are added purely additively, so a
 * `switch (block.kind)` in the renderer stays exhaustive.
 */
export type Block =
  | RawBlock
  | PromptSelectBlock
  | WizardBlock
  | PreviewSelectBlock
  | MultiSelectBlock
  | MenuBlock
  | AutocompleteBlock;

/**
 * Split parsed segments into visual lines at "\n" boundaries. The newline characters become the
 * separators *between* lines and are dropped from segment text, so `lines.map(text).join("\n")`
 * reconstructs the original visible string exactly.
 *
 * A segment whose text has no newline is reused as-is (no allocation). A segment carrying newline(s)
 * is sliced into per-line pieces that each keep the original segment's style/flags — so a styled run
 * straddling a line break stays styled on both sides. Empty pieces (adjacent newlines, or a leading/
 * trailing newline) contribute no segment but still open/close a line, preserving blank lines.
 */
export function splitLines(segments: AnsiSegment[]): StyledLine[] {
  const lines: StyledLine[] = [];
  let current: AnsiSegment[] = [];

  for (const seg of segments) {
    const t = seg.text;
    if (t.indexOf("\n") === -1) {
      // Common case (parser flushes at every "\n", so most segments have none): reuse verbatim.
      current.push(seg);
      continue;
    }
    // Segment contains one or more newlines: distribute its text across the lines it spans, cloning
    // the style onto each non-empty piece.
    let start = 0;
    for (;;) {
      const idx = t.indexOf("\n", start);
      const end = idx === -1 ? t.length : idx;
      if (end > start) current.push({ ...seg, text: t.slice(start, end) });
      if (idx === -1) break;
      lines.push(styledLine(current));
      current = [];
      start = idx + 1;
    }
  }

  // The trailing run (after the last "\n", or the whole input if it had none) is the final line —
  // pushed even when empty so a trailing newline yields a terminating blank line.
  lines.push(styledLine(current));
  return lines;
}

// A terminal-width rule or framed grid row is visually useless when browser wrapping turns it into
// several rows. The latter is worse: a boxed composer body becomes one text row followed by screens of
// wrapped padding, while its top/bottom borders repeat across the viewport. Keep those rows intact and
// clip them at the phone edge; ordinary prose still wraps.
//
// Twenty stands on two facts of its own, and deliberately cites no other threshold. (1) Nothing in prose,
// markdown or code runs to twenty identical rule glyphs, so the rule-run probes do not fire on real content.
// (2) A framed row shorter than roughly twenty columns already fits the narrowest mirror, so clipping it
// would buy nothing — the only rows worth clipping are the ones wide enough to wrap.
//
// An earlier revision derived this number from the Claude grammar's own 20-glyph box-border run. That run
// no longer exists: it was a hidden assumption that the pane is at least twenty columns wide, which is
// exactly what stalled the reply guard on a 19-column pane (issue #76), and markers.ts replaced it with a
// display-cell floor. Do not re-couple the two. They classify borders for different consumers with
// opposite failure costs — a false positive there types Enter into the wrong screen, a false positive here
// crops a visual row — so they share the rule-run alphabet in rule-glyphs.ts and nothing else.
const MIN_NO_WRAP_ROW_LENGTH = 20;
const PURE_HORIZONTAL_BORDER = new RegExp(
  `^([${PURE_HORIZONTAL_RULE_GLYPH_CLASS}])\\1{${MIN_NO_WRAP_ROW_LENGTH - 1},}$`,
);
const INTERNAL_LAYOUT_RULE = new RegExp(
  `([${PURE_HORIZONTAL_RULE_GLYPH_CLASS}])\\1{${MIN_NO_WRAP_ROW_LENGTH - 1},}.*[^\\s\\u2500-\\u257f]`,
  "u",
);
const BOX_DRAWING_GLYPH = /^[\u2500-\u257f]$/u;
const STATUS_COLUMN_GLYPH = /[│┃║]/u;
const HORIZONTAL_RULE_GLYPH = new RegExp(`^[${PURE_HORIZONTAL_RULE_GLYPH_CLASS}]$`, "u");
const DIAGONAL_BOX_GLYPH = /^[╱╲╳]$/u;
const STRUCTURAL_INNER_GLYPH = new RegExp(
  `[^\\u2500-\\u257f]|[${PURE_HORIZONTAL_RULE_GLYPH_CLASS}]`,
  "u",
);

/** A box endpoint with a vertical connection: corners, verticals, tees, or junctions — never a
 * horizontal-only rule or diagonal. Requiring one at BOTH ends keeps labelled rules wrappable. */
function isBoxEdge(glyph: string): boolean {
  return (
    BOX_DRAWING_GLYPH.test(glyph) &&
    !HORIZONTAL_RULE_GLYPH.test(glyph) &&
    !DIAGONAL_BOX_GLYPH.test(glyph)
  );
}

function isFramedTerminalRow(row: string): boolean {
  if (row.length < MIN_NO_WRAP_ROW_LENGTH) return false;

  const first = row[0]!;
  const last = row[row.length - 1]!;
  if (!isBoxEdge(first) || !isBoxEdge(last)) return false;

  // Reject contrived runs such as `┌┌┌…`: a real frame has content/padding or a horizontal stroke
  // between its two structural edges. This keeps the visual classifier narrow without coupling it
  // to any harness's safety-sensitive input-box grammar. The endpoints cannot satisfy this regex,
  // so testing the whole row avoids another substring allocation.
  return STRUCTURAL_INNER_GLYPH.test(row);
}

function hasInternalLayoutRule(row: string): boolean {
  if (row.length < MIN_NO_WRAP_ROW_LENGTH) return false;

  // A plain labelled rule starts with its rule and remains wrappable so its label cannot be cropped.
  // Terminal status rows instead put content first and use a long rule as layout filler before later
  // fields; wrapping that filler is what scatters one status row over several phone rows. Requiring
  // non-box content after the run avoids mistaking a side-by-side preview's right-hand border for filler.
  return (
    !BOX_DRAWING_GLYPH.test(row[0]!) &&
    !HORIZONTAL_RULE_GLYPH.test(row[0]!) &&
    STATUS_COLUMN_GLYPH.test(row) &&
    INTERNAL_LAYOUT_RULE.test(row)
  );
}

function styledLine(segments: AnsiSegment[]): StyledLine {
  const text = segments.map((segment) => segment.text).join("");
  const row = text.trim();
  return (
    PURE_HORIZONTAL_BORDER.test(row) ||
    isFramedTerminalRow(row) ||
    hasInternalLayoutRule(row)
  )
    ? { segments, noWrap: true }
    : { segments };
}

// The two generic StyledLine probes. They live HERE, in the core AST module that imports nothing
// from harness/, because they are properties of a StyledLine and of no grammar: the renderer
// (components/ansi-output.tsx) and every harness adapter need them, and a second copy in a
// harness-specific module would make a neutral consumer import a harness. harness/claude/markers
// re-exports them so the Claude grammars keep their one import site.

/** The visible text of a line: its segments' text concatenated (the "\n" separator lives between
 *  lines, so a single line's text never contains one). */
export function lineText(line: StyledLine): string {
  return line.segments.map((s) => s.text).join("");
}

/** True when a line is empty or only whitespace. */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** Drop a trailing run of blank lines (keeps the raw block above the buttons tight). Exported for the
 *  harness adapters, whose pipelines tighten the raw region above a lifted dialog with it. */
export function trimTrailingBlank(lines: StyledLine[]): StyledLine[] {
  let end = lines.length;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  return end === lines.length ? lines : lines.slice(0, end);
}
