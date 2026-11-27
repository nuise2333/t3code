export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

export const PLAN_REVISION_PROMPT =
  "YOUR PLAN WAS NOT APPROVED. Revise the plan to address ALL of the feedback below, then present the complete revised plan again. Do not implement it yet, do not resubmit it unchanged, and start it with the same \`# Title\` heading unless the feedback asks otherwise.";

const PLAN_IMPLEMENTATION_NOTES_HEADING =
  "REVIEWER NOTES. The plan is approved: implement it now without re-presenting it. Where a note below conflicts with the plan above, the note wins (skip deleted parts, use replacements):";

/** Where a quote sits in the plan as rendered: its text and which repeat of that text it is. */
export interface PlanTextAnchor {
  readonly text: string;
  readonly occurrence: number;
}

export interface PlanAnnotationDraft {
  readonly id: string;
  readonly action: "delete" | "replace" | "comment";
  readonly quote: string;
  /** 1-based line of the plan's Markdown the quote starts on, when it could be found. */
  readonly line?: number;
  readonly replacement?: string;
  readonly comment?: string;
  readonly anchor?: PlanTextAnchor;
}

export interface PlanReviewDraft {
  readonly annotations: ReadonlyArray<PlanAnnotationDraft>;
  readonly general: string;
}

export const EMPTY_PLAN_REVIEW_DRAFT: PlanReviewDraft = { annotations: [], general: "" };

/** A replacement needs its new text and a comment its words; a deletion stands on its own. */
export function isPlanAnnotationComplete(annotation: PlanAnnotationDraft): boolean {
  if (!annotation.quote.trim()) return false;
  if (annotation.action === "replace") return Boolean(annotation.replacement?.trim());
  if (annotation.action === "comment") return Boolean(annotation.comment?.trim());
  return true;
}

export function hasPlanReviewFeedback(draft: PlanReviewDraft): boolean {
  return draft.general.trim().length > 0 || draft.annotations.some(isPlanAnnotationComplete);
}

export type StoredPlanReviewDrafts = Readonly<
  Record<string, PlanReviewDraft & { readonly updatedAt: number }>
>;

const MAX_STORED_PLAN_REVIEW_DRAFTS = 200;

function isAnnotationDraft(value: unknown): value is PlanAnnotationDraft {
  if (typeof value !== "object" || value === null) return false;
  const annotation = value as Partial<PlanAnnotationDraft>;
  return (
    typeof annotation.id === "string" &&
    typeof annotation.quote === "string" &&
    (annotation.action === "delete" ||
      annotation.action === "replace" ||
      annotation.action === "comment")
  );
}

/** Reads a client's saved `{ drafts }`, keeping only well-formed drafts and notes. */
export function decodePlanReviewDrafts(persisted: unknown): StoredPlanReviewDrafts {
  const drafts = (persisted as { drafts?: unknown } | null)?.drafts;
  if (typeof drafts !== "object" || drafts === null) return {};
  return Object.fromEntries(
    Object.entries(
      drafts as Record<string, Partial<StoredPlanReviewDrafts[string]> | null>,
    ).flatMap(([key, draft]) =>
      draft && Array.isArray(draft.annotations)
        ? [
            [
              key,
              {
                annotations: draft.annotations.filter(isAnnotationDraft),
                general: typeof draft.general === "string" ? draft.general : "",
                updatedAt: typeof draft.updatedAt === "number" ? draft.updatedAt : 0,
              },
            ],
          ]
        : [],
    ),
  );
}

/** Stores a draft, drops it once it is empty, and keeps only the most recently edited ones. */
export function withPlanReviewDraft(
  drafts: StoredPlanReviewDrafts,
  key: string,
  draft: PlanReviewDraft,
  now: number,
): StoredPlanReviewDrafts {
  const { [key]: _previous, ...others } = drafts;
  if (draft.annotations.length === 0 && draft.general === "") return others;
  const kept = Object.entries(others)
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_STORED_PLAN_REVIEW_DRAFTS - 1);
  return {
    ...Object.fromEntries(kept),
    [key]: { annotations: draft.annotations, general: draft.general, updatedAt: now },
  };
}

const NOTE_HEADINGS = { delete: "Remove", replace: "Replace", comment: "Comment" } as const;

// The blank line ends the quote; Markdown would otherwise read the next line as part of it.
function quoteBlock(text: string): string {
  const quoted = text.split(/\r?\n/).map((line) => (line.trim() ? `> ${line}` : ">"));
  return `${quoted.join("\n")}\n`;
}

// Notes go in the message itself, whole: every server and provider delivers its text.
function planReviewNotes(draft: PlanReviewDraft): string[] {
  const notes = draft.annotations.filter(isPlanAnnotationComplete).map((annotation) => {
    const heading = NOTE_HEADINGS[annotation.action];
    const lines = [
      annotation.line === undefined ? heading : `${heading} (line ${annotation.line})`,
      quoteBlock(annotation.quote.trim()),
    ];
    if (annotation.action === "delete") lines.push("The user wants this part left out.");
    if (annotation.action === "replace") {
      lines.push("Replace with:", annotation.replacement?.trim() ?? "");
    }
    if (annotation.comment?.trim()) lines.push(`Comment: ${annotation.comment.trim()}`);
    return lines.join("\n");
  });
  const general = draft.general.trim();
  if (general) notes.push(`General feedback\n${general}`);
  return notes.map((note, index) => `## ${index + 1}. ${note}`);
}

export function countPlanReviewNotes(draft: PlanReviewDraft): number {
  return planReviewNotes(draft).length;
}

/** The message that sends a plan back; null when the reviewer has given no feedback to act on. */
export function buildPlanRevisionMessage(draft: PlanReviewDraft): string | null {
  const notes = planReviewNotes(draft);
  return notes.length === 0 ? null : [PLAN_REVISION_PROMPT, ...notes].join("\n\n");
}

export function buildPlanApprovalMessage(planMarkdown: string, draft: PlanReviewDraft): string {
  const text = `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
  const notes = planReviewNotes(draft);
  return notes.length === 0
    ? text
    : [text, PLAN_IMPLEMENTATION_NOTES_HEADING, ...notes].join("\n\n");
}

function occurrenceStarts(text: string, needle: string): number[] {
  const starts: number[] = [];
  if (!needle) return starts;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    starts.push(index);
  }
  return starts;
}

/** Anchors the `[start, end)` slice of the rendered plan's text. */
export function planTextAnchor(text: string, start: number, end: number): PlanTextAnchor {
  const quote = text.slice(start, end);
  const occurrence = occurrenceStarts(text, quote).indexOf(start);
  return { text: quote, occurrence: Math.max(0, occurrence) };
}

/** Finds an anchor again; a repeat that no longer exists falls back to the last one that does. */
export function resolvePlanTextAnchor(
  text: string,
  anchor: PlanTextAnchor,
): { readonly start: number; readonly end: number } | null {
  const starts = occurrenceStarts(text, anchor.text);
  const start = starts[Math.min(anchor.occurrence, starts.length - 1)];
  return start === undefined ? null : { start, end: start + anchor.text.length };
}

// Rendered text has no Markdown markers, so the source is compared with them stripped.
export function plainMarkdownLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort 1-based Markdown line a quote selected from the rendered plan starts on. */
export function findPlanQuoteLine(
  markdown: string,
  quote: string,
  occurrence = 0,
): number | undefined {
  const needle = plainMarkdownLine(quote.split("\n").find((line) => line.trim()) ?? "");
  if (!needle) return undefined;
  const lineStarts: number[] = [];
  let flat = "";
  for (const line of markdown.split("\n")) {
    lineStarts.push(flat.length);
    flat += `${plainMarkdownLine(line)} `;
  }
  const matches = occurrenceStarts(flat, needle);
  const match = matches[Math.min(occurrence, matches.length - 1)];
  if (match === undefined) return undefined;
  return lineStarts.findLastIndex((start) => start <= match) + 1;
}

export interface PlanDiffSegment {
  readonly text: string;
  /** Part of the line that differs from its counterpart in the other version. */
  readonly changed: boolean;
}

export type PlanDiffLine =
  | {
      readonly kind: "context";
      readonly text: string;
      readonly oldLine: number;
      readonly newLine: number;
    }
  | {
      readonly kind: "removed";
      readonly segments: ReadonlyArray<PlanDiffSegment>;
      readonly oldLine: number;
    }
  | {
      readonly kind: "added";
      readonly segments: ReadonlyArray<PlanDiffSegment>;
      readonly newLine: number;
    };

export interface PlanDiff {
  readonly lines: ReadonlyArray<PlanDiffLine>;
  readonly added: number;
  readonly removed: number;
}

type SequenceOp = { readonly kind: "same" | "removed" | "added"; readonly value: string };

// Above this the table would cost more memory than a plan diff is worth; the middle is replaced.
const MAX_DIFF_CELLS = 4_000_000;

function diffSequence(before: ReadonlyArray<string>, after: ReadonlyArray<string>): SequenceOp[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const ops: SequenceOp[] = before.slice(0, start).map((value) => ({ kind: "same", value }));
  const rows = endBefore - start;
  const columns = endAfter - start;
  let row = 0;
  let column = 0;
  if (rows * columns <= MAX_DIFF_CELLS) {
    const width = columns + 1;
    // lengths[row * width + column] is the longest common run of the two remainders.
    const lengths = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = columns - 1; j >= 0; j -= 1) {
        lengths[i * width + j] =
          before[start + i] === after[start + j]
            ? lengths[(i + 1) * width + j + 1]! + 1
            : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    while (row < rows && column < columns) {
      if (before[start + row] === after[start + column]) {
        ops.push({ kind: "same", value: before[start + row]! });
        row += 1;
        column += 1;
      } else if (lengths[(row + 1) * width + column]! >= lengths[row * width + column + 1]!) {
        ops.push({ kind: "removed", value: before[start + row]! });
        row += 1;
      } else {
        ops.push({ kind: "added", value: after[start + column]! });
        column += 1;
      }
    }
  }
  for (; row < rows; row += 1) ops.push({ kind: "removed", value: before[start + row]! });
  for (; column < columns; column += 1) ops.push({ kind: "added", value: after[start + column]! });
  for (const value of before.slice(endBefore)) ops.push({ kind: "same", value });
  return ops;
}

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
// CJK has no spaces between words, so each character is its own token.
const WORD_TOKEN = new RegExp(String.raw`\s+|[${CJK}]|(?:(?![${CJK}])[\p{L}\p{N}_])+|[^\s]`, "gu");

function mergeSegments(segments: ReadonlyArray<PlanDiffSegment>): PlanDiffSegment[] {
  const merged: PlanDiffSegment[] = [];
  segments.forEach((segment, index) => {
    // Whitespace between two changed words reads as part of the change.
    const bridges =
      !segment.changed &&
      !segment.text.trim() &&
      segments[index - 1]?.changed === true &&
      segments[index + 1]?.changed === true;
    const changed = segment.changed || bridges;
    const last = merged.at(-1);
    if (last?.changed === changed)
      merged[merged.length - 1] = { text: last.text + segment.text, changed };
    else merged.push({ text: segment.text, changed });
  });
  return merged;
}

// Lines with little in common read better as a whole-line change than as scattered words.
const MIN_SHARED_WORD_RATIO = 0.4;

function diffWords(
  before: string,
  after: string,
): { readonly removed: PlanDiffSegment[]; readonly added: PlanDiffSegment[] } {
  const ops = diffSequence(before.match(WORD_TOKEN) ?? [], after.match(WORD_TOKEN) ?? []);
  const shared = ops
    .filter((op) => op.kind === "same" && op.value.trim())
    .reduce((total, op) => total + op.value.length, 0);
  const longest = Math.max(before.replace(/\s/g, "").length, after.replace(/\s/g, "").length);
  if (longest === 0 || shared / longest < MIN_SHARED_WORD_RATIO) {
    return {
      removed: [{ text: before, changed: false }],
      added: [{ text: after, changed: false }],
    };
  }
  const side = (kind: "removed" | "added") =>
    mergeSegments(
      ops
        .filter((op) => op.kind === "same" || op.kind === kind)
        .map((op) => ({ text: op.value, changed: op.kind === kind })),
    );
  return { removed: side("removed"), added: side("added") };
}

/** Line diff of two plan versions; a changed line paired with its rewrite marks the words that differ. */
export function diffPlanMarkdown(previous: string, next: string): PlanDiff {
  const ops = diffSequence(previous.trimEnd().split(/\r?\n/), next.trimEnd().split(/\r?\n/));
  const lines: PlanDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let added = 0;
  let removed = 0;
  for (let index = 0; index < ops.length;) {
    const op = ops[index]!;
    if (op.kind === "same") {
      oldLine += 1;
      newLine += 1;
      lines.push({ kind: "context", text: op.value, oldLine, newLine });
      index += 1;
      continue;
    }
    const hunk: SequenceOp[] = [];
    for (; index < ops.length && ops[index]!.kind !== "same"; index += 1) hunk.push(ops[index]!);
    const removedLines = hunk
      .filter((entry) => entry.kind === "removed")
      .map((entry) => entry.value);
    const addedLines = hunk.filter((entry) => entry.kind === "added").map((entry) => entry.value);
    const pairs = removedLines.map((line, pairIndex) =>
      pairIndex < addedLines.length ? diffWords(line, addedLines[pairIndex]!) : null,
    );
    removedLines.forEach((text, pairIndex) => {
      oldLine += 1;
      lines.push({
        kind: "removed",
        segments: pairs[pairIndex]?.removed ?? [{ text, changed: false }],
        oldLine,
      });
    });
    addedLines.forEach((text, pairIndex) => {
      newLine += 1;
      lines.push({
        kind: "added",
        segments: pairs[pairIndex]?.added ?? [{ text, changed: false }],
        newLine,
      });
    });
    removed += removedLines.length;
    added += addedLines.length;
  }
  return { lines, added, removed };
}
