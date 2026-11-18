import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { PhrasingContent, Root, RootContent } from "mdast";

import { type MarkdownSyntaxOptions, parseMarkdownSyntax } from "./markdownFileSyntax";

export type InlineStyleKind = "strong" | "em" | "del" | "code" | "mark" | "sup" | "sub" | "a";

/** Offsets are in the leaf's text: its text nodes joined, line prefixes left out. */
export interface InlineStyle {
  readonly kind: InlineStyleKind;
  /** The whole syntax, markers included. */
  readonly from: number;
  readonly to: number;
  /** What the reader draws inside the element. */
  readonly innerFrom: number;
  readonly innerTo: number;
  readonly href: string | null;
  readonly title: string | null;
}

export interface InlineMarker {
  readonly from: number;
  readonly to: number;
  /** Index of the style the marker belongs to, or -1 for an escape's backslash. */
  readonly style: number;
}

export interface InlineRange {
  readonly from: number;
  readonly to: number;
}

export interface InlineBreak {
  /** Offset of the line ending. */
  readonly at: number;
  readonly hard: boolean;
}

export interface InlineAnalysis {
  readonly styles: ReadonlyArray<InlineStyle>;
  readonly markers: ReadonlyArray<InlineMarker>;
  /** Whitespace the reader does not show as written. */
  readonly collapsed: ReadonlyArray<InlineRange>;
  readonly breaks: ReadonlyArray<InlineBreak>;
  /** The text no longer parses as one editable block of its kind: a structural trigger. */
  readonly kindMismatch: boolean;
}

/** `task` is the paragraph after a task box, whose text is never a block marker. */
export type EditableLeafKind = "paragraph" | "task" | "heading" | "setext";

export interface MarkdownDefinition {
  readonly identifier: string;
  readonly label: string;
  readonly url: string;
  readonly title: string | null;
  readonly footnote: boolean;
}

export type DefinitionLookup = ReadonlyMap<string, MarkdownDefinition>;

const EDITABLE_INLINE = new Set([
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "link",
  "linkReference",
  "break",
  "mark",
  "superscript",
  "subscript",
]);

const STYLE_OF: Record<string, InlineStyleKind> = {
  strong: "strong",
  emphasis: "em",
  delete: "del",
  inlineCode: "code",
  mark: "mark",
  superscript: "sup",
  subscript: "sub",
  link: "a",
  linkReference: "a",
};

const CHARACTER_REFERENCE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

const countMatches = (value: string, pattern: RegExp) => value.match(pattern)?.length ?? 0;

interface PositionedNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<PositionedNode>;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
}

const startOf = (node: PositionedNode) => node.position?.start.offset;
const endOf = (node: PositionedNode) => node.position?.end.offset;

/**
 * Why the inline tree cannot be edited as source text, or null when it can: every node must be in
 * the editable set, carry a position, and show its text as written.
 */
export function inlineBlocker(
  children: ReadonlyArray<PositionedNode>,
  source: string,
): "directive" | "other" | null {
  for (const child of children) {
    if (child.type === "textDirective") return "directive";
    if (!EDITABLE_INLINE.has(child.type)) return "other";
    const start = startOf(child);
    const end = endOf(child);
    if (start === undefined || end === undefined) return "other";
    if (child.type === "text") {
      const raw = source.slice(start, end);
      // A decoded character reference makes the value differ from the source, so ranges are unsafe.
      if (
        raw.includes("&") &&
        countMatches(raw, CHARACTER_REFERENCE) !==
          countMatches(child.value ?? "", CHARACTER_REFERENCE)
      ) {
        return "other";
      }
    }
    if (child.children) {
      const blocker = inlineBlocker(child.children, source);
      if (blocker) return blocker;
    }
  }
  return null;
}

interface AnalysisInput {
  /** The leaf's text, which the offsets index. */
  readonly text: string;
  /** Maps an offset in the parsed source to one in `text`. */
  readonly toLeaf: (offset: number) => number;
  readonly definitions: DefinitionLookup;
}

/** Style, marker, whitespace and break ranges of a parsed inline tree. */
export function analyzeInlineTree(
  children: ReadonlyArray<PositionedNode>,
  input: AnalysisInput,
): Omit<InlineAnalysis, "kindMismatch"> {
  const { text, toLeaf } = input;
  const styles: InlineStyle[] = [];
  const markers: InlineMarker[] = [];
  const hardBreaks: InlineRange[] = [];
  const textRanges: InlineRange[] = [];
  const codeRanges: InlineRange[] = [];

  const visit = (nodes: ReadonlyArray<PositionedNode>) => {
    for (const node of nodes) {
      const from = toLeaf(startOf(node)!);
      const to = toLeaf(endOf(node)!);
      if (node.type === "text") {
        textRanges.push({ from, to });
        continue;
      }
      if (node.type === "break") {
        if (text[from] === "\\") markers.push({ from, to: from + 1, style: -1 });
        hardBreaks.push({ from, to });
        continue;
      }
      const kind = STYLE_OF[node.type]!;
      const index = styles.length;
      let innerFrom = from;
      let innerTo = to;
      if (node.type === "inlineCode") {
        let ticks = 0;
        while (text[from + ticks] === "`") ticks++;
        const padded =
          /[ \n]/.test(text[from + ticks] ?? "") &&
          /[ \n]/.test(text[to - ticks - 1] ?? "") &&
          to - ticks - 1 > from + ticks &&
          text.slice(from + ticks, to - ticks).trim() !== "";
        innerFrom = from + ticks + (padded ? 1 : 0);
        innerTo = to - ticks - (padded ? 1 : 0);
        codeRanges.push({ from: innerFrom, to: innerTo });
      } else if (node.children && node.children.length > 0) {
        innerFrom = toLeaf(startOf(node.children[0]!)!);
        innerTo = toLeaf(endOf(node.children.at(-1)!)!);
      } else if (node.type === "link" || node.type === "linkReference") {
        innerFrom = innerTo = from + 1;
      }
      const reference =
        node.type === "linkReference"
          ? input.definitions.get((node as { identifier?: string }).identifier ?? "")
          : undefined;
      const link = node as { url?: string; title?: string | null };
      styles.push({
        kind,
        from,
        to,
        innerFrom,
        innerTo,
        href: kind === "a" ? (reference?.url ?? link.url ?? "") : null,
        title: kind === "a" ? ((reference ? reference.title : link.title) ?? null) : null,
      });
      if (innerFrom > from) markers.push({ from, to: innerFrom, style: index });
      if (to > innerTo) markers.push({ from: innerTo, to, style: index });
      if (node.children) visit(node.children);
    }
  };
  visit(children);

  // Zones: 0 shown text, 1 code, 2 marker or hard break; escapes only count in shown text.
  const zone = new Uint8Array(text.length);
  for (const range of codeRanges) zone.fill(1, range.from, range.to);
  for (const marker of markers) zone.fill(2, marker.from, marker.to);
  for (const range of textRanges) {
    for (let at = range.from; at < range.to; at++) {
      if (text[at] !== "\\" || zone[at] !== 0) continue;
      if (ASCII_PUNCTUATION.test(text[at + 1] ?? "")) {
        markers.push({ from: at, to: at + 1, style: -1 });
        zone[at] = 2;
        at++;
      }
    }
  }

  const breaks: InlineBreak[] = [];
  const hardAt = new Set<number>();
  for (const range of hardBreaks) {
    const lineEnd = text.slice(range.from, range.to).search(/\r?\n|\r/);
    if (lineEnd === -1) continue;
    const at = range.from + lineEnd;
    breaks.push({ at, hard: true });
    hardAt.add(at);
    const width = text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1;
    zone.fill(2, at, at + width);
  }

  const collapsed: InlineRange[] = [];
  const isSpace = (char: string | undefined) =>
    char === " " || char === "\t" || char === "\n" || char === "\r";
  let at = 0;
  while (at < text.length) {
    if (!isSpace(text[at]) || zone[at] === 2) {
      at++;
      continue;
    }
    const kind = zone[at];
    const from = at;
    while (at < text.length && isSpace(text[at]) && zone[at] === kind) at++;
    const run = text.slice(from, at);
    const lineEnding = /[\r\n]/.test(run);
    if (kind === 0 && lineEnding) {
      for (const match of run.matchAll(/\r\n|\r|\n/g)) {
        breaks.push({ at: from + match.index, hard: false });
      }
    }
    const nextToHardBreak = hardAt.has(at) || hardAt.has(from - 1) || hardAt.has(from - 2);
    if (
      run.length >= 2 ||
      run.includes("\t") ||
      lineEnding ||
      (kind === 0 && (from === 0 || at === text.length || nextToHardBreak))
    ) {
      collapsed.push({ from, to: at });
    }
  }
  breaks.sort((a, b) => a.at - b.at);
  markers.sort((a, b) => a.from - b.from);
  return { styles, markers, collapsed, breaks };
}

export function definitionLookup(definitions: ReadonlyArray<MarkdownDefinition>): DefinitionLookup {
  const lookup = new Map<string, MarkdownDefinition>();
  for (const definition of definitions) {
    const key = `${definition.footnote ? "^" : ""}${definition.identifier}`;
    if (!lookup.has(key)) lookup.set(key, definition);
  }
  return lookup;
}

/**
 * Definitions a piece of source mentions, as source to append after it: micromark resolves a
 * reference only against a definition in the same input.
 */
export function definitionsSuffix(
  source: string,
  definitions: ReadonlyArray<MarkdownDefinition>,
): string {
  if (definitions.length === 0 || !source.includes("[")) return "";
  const lower = source.toLowerCase();
  let suffix = "";
  for (const definition of definitions) {
    if (!lower.includes(definition.label.toLowerCase())) continue;
    // A blank line after each: a definition cannot interrupt a footnote's paragraph.
    suffix += definition.footnote
      ? `[^${definition.label}]: x\n\n`
      : `[${definition.label}]: #\n\n`;
  }
  return suffix === "" ? "" : `\n\n${suffix}`;
}

/** Definitions in a tree, outermost first, with offsets below `limit`. */
export function collectDefinitions(tree: Root, limit = Infinity): MarkdownDefinition[] {
  const found: MarkdownDefinition[] = [];
  const visit = (nodes: ReadonlyArray<RootContent>) => {
    for (const node of nodes) {
      if ((node.position?.start.offset ?? 0) >= limit) return;
      if (node.type === "definition") {
        found.push({
          identifier: node.identifier,
          label: node.label ?? node.identifier,
          url: node.url,
          title: node.title ?? null,
          footnote: false,
        });
      } else if (node.type === "footnoteDefinition") {
        found.push({
          identifier: node.identifier,
          label: node.label ?? node.identifier,
          url: "",
          title: null,
          footnote: true,
        });
      }
      if ("children" in node && node.type !== "paragraph" && node.type !== "heading") {
        visit(node.children as RootContent[]);
      }
    }
  };
  visit(tree.children);
  return found;
}

/** The source a leaf parses alone as, and where its text starts in it. */
export function leafParseInput(
  text: string,
  kind: EditableLeafKind,
  definitions: ReadonlyArray<MarkdownDefinition>,
): { readonly source: string; readonly offset: number; readonly end: number } {
  const head = kind === "heading" ? "# " : kind === "task" ? "- [ ] " : "";
  const body = head + text + (kind === "setext" ? "\n===" : "");
  return {
    source: body + definitionsSuffix(text, definitions),
    offset: head.length,
    end: body.length,
  };
}

/** Parses one leaf's text alone, as it is re-analyzed after an edit. */
export function analyzeLeafInline(
  text: string,
  kind: EditableLeafKind,
  definitions: ReadonlyArray<MarkdownDefinition>,
  options: MarkdownSyntaxOptions,
): InlineAnalysis {
  const input = leafParseInput(text, kind, definitions);
  const tree = parseMarkdownSyntax(input.source, options);
  const blocks = tree.children.filter((node) => (node.position?.start.offset ?? 0) < input.end);
  let block = blocks[0];
  if (kind === "task") {
    const item = block?.type === "list" && block.children.length === 1 ? block.children[0] : null;
    block = item?.checked != null && item.children.length === 1 ? item.children[0] : undefined;
  }
  const expected = kind === "heading" || kind === "setext" ? "heading" : "paragraph";
  const children: ReadonlyArray<PhrasingContent> =
    block && (block.type === "paragraph" || block.type === "heading") ? block.children : [];
  const mismatch =
    blocks.length !== 1 ||
    block?.type !== expected ||
    (kind === "setext" && text.trim() === "") ||
    inlineBlocker(children, input.source) !== null;
  const analysis = analyzeInlineTree(mismatch ? [] : children, {
    text,
    toLeaf: (offset) => offset - input.offset,
    definitions: definitionLookup(definitions),
  });
  return { ...analysis, kindMismatch: mismatch };
}

const AFTER_TASK_BOX = /(?:^|[ \t>])(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\](?:[ \t]+|$)/;

export function editableLeafKind(node: ProseMirrorNode): EditableLeafKind | null {
  if (node.type.name === "paragraph") {
    return AFTER_TASK_BOX.test(node.attrs.before as string) ? "task" : "paragraph";
  }
  if (node.type.name === "heading") return node.attrs.setext ? "setext" : "heading";
  return null;
}

// Nodes are immutable, so an analysis stays valid for the node it was made for.
const analyses = new WeakMap<ProseMirrorNode, InlineAnalysis>();

/** The analysis already made for this node, without making one. */
export const rememberedInlineAnalysis = (node: ProseMirrorNode) => analyses.get(node);

export function rememberInlineAnalysis(node: ProseMirrorNode, analysis: InlineAnalysis) {
  analyses.set(node, analysis);
}

const sameAnalysis = (a: InlineAnalysis, b: InlineAnalysis) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether `kept` can stand in for the equal node `fresh`: every analysis it already has matches
 * the fresh one, and it takes those it lacks. A changed definition changes how references parse,
 * and the old node must keep its own analysis for the documents (undo history) that hold it.
 */
export function adoptInlineAnalyses(kept: ProseMirrorNode, fresh: ProseMirrorNode): boolean {
  if (kept === fresh) return true;
  if (editableLeafKind(kept)) {
    const analysis = analyses.get(fresh);
    const own = analyses.get(kept);
    if (!analysis) return true;
    if (own) return sameAnalysis(own, analysis);
    analyses.set(kept, analysis);
    return true;
  }
  if (kept.isTextblock) return true;
  for (let index = 0; index < kept.childCount; index++) {
    if (!adoptInlineAnalyses(kept.child(index), fresh.child(index))) return false;
  }
  return true;
}

export function inlineAnalysisFor(
  node: ProseMirrorNode,
  definitions: ReadonlyArray<MarkdownDefinition>,
  options: MarkdownSyntaxOptions,
): InlineAnalysis | null {
  const kind = editableLeafKind(node);
  if (!kind) return null;
  let analysis = analyses.get(node);
  if (!analysis) {
    let text = "";
    node.forEach((child) => {
      if (child.isText) text += child.text;
    });
    analysis = analyzeLeafInline(text, kind, definitions, options);
    analyses.set(node, analysis);
  }
  return analysis;
}

// Packed layout per editable leaf, in document order:
// styles (count, then kind, from, to, innerFrom, innerTo, href, title), markers (count, then from,
// to, style), collapsed (count, then from, to), breaks (count, then at, hard). Strings index into
// a shared table, -1 for none.
const STYLE_KINDS: ReadonlyArray<InlineStyleKind> = [
  "strong",
  "em",
  "del",
  "code",
  "mark",
  "sup",
  "sub",
  "a",
];

export class InlinePacker {
  private readonly values: number[] = [];
  readonly strings: string[] = [];
  private readonly stringIndex = new Map<string, number>();

  private string(value: string | null) {
    if (value === null) return -1;
    let index = this.stringIndex.get(value);
    if (index === undefined) {
      index = this.strings.length;
      this.strings.push(value);
      this.stringIndex.set(value, index);
    }
    return index;
  }

  push(analysis: Omit<InlineAnalysis, "kindMismatch">) {
    const values = this.values;
    values.push(analysis.styles.length);
    for (const style of analysis.styles) {
      values.push(
        STYLE_KINDS.indexOf(style.kind),
        style.from,
        style.to,
        style.innerFrom,
        style.innerTo,
        this.string(style.href),
        this.string(style.title),
      );
    }
    values.push(analysis.markers.length);
    for (const marker of analysis.markers) values.push(marker.from, marker.to, marker.style);
    values.push(analysis.collapsed.length);
    for (const range of analysis.collapsed) values.push(range.from, range.to);
    values.push(analysis.breaks.length);
    for (const lineBreak of analysis.breaks) values.push(lineBreak.at, lineBreak.hard ? 1 : 0);
  }

  finish(): Int32Array {
    return Int32Array.from(this.values);
  }
}

export function unpackInlineAnalyses(
  packed: Int32Array,
  strings: ReadonlyArray<string>,
): InlineAnalysis[] {
  const result: InlineAnalysis[] = [];
  let at = 0;
  const next = () => packed[at++]!;
  const string = (index: number) => (index === -1 ? null : strings[index]!);
  while (at < packed.length) {
    const styles: InlineStyle[] = [];
    for (let count = next(); count > 0; count--) {
      styles.push({
        kind: STYLE_KINDS[next()]!,
        from: next(),
        to: next(),
        innerFrom: next(),
        innerTo: next(),
        href: string(next()),
        title: string(next()),
      });
    }
    const markers: InlineMarker[] = [];
    for (let count = next(); count > 0; count--) {
      markers.push({ from: next(), to: next(), style: next() });
    }
    const collapsed: InlineRange[] = [];
    for (let count = next(); count > 0; count--) collapsed.push({ from: next(), to: next() });
    const breaks: InlineBreak[] = [];
    for (let count = next(); count > 0; count--) breaks.push({ at: next(), hard: next() === 1 });
    result.push({ styles, markers, collapsed, breaks, kindMismatch: false });
  }
  return result;
}

/** What a selection shows of a leaf's syntax; offsets are in the leaf's text. */
export interface InlineReveal {
  /** Indexes into `markers` of the markers drawn, muted. The rest are hidden. */
  readonly markers: ReadonlySet<number>;
  /** Indexes into `collapsed` of the white space shown as written. */
  readonly spaces: ReadonlySet<number>;
  /** Equal for equal reveals of one analysis. */
  readonly key: string;
}

export const NOTHING_REVEALED: InlineReveal = { markers: new Set(), spaces: new Set(), key: "" };

const touches = (from: number, to: number, start: number, end: number) =>
  from <= end && to >= start;

/**
 * The markers of every styled range the selection intersects or is next to, the backslash of an
 * escape it touches, and collapsed spaces it touches, so a typed space always moves the caret.
 * Line endings stay collapsed: shown as written they would break a line. Null shows nothing.
 */
export function inlineReveal(
  analysis: InlineAnalysis,
  selection: { readonly from: number; readonly to: number } | null,
  text: string,
): InlineReveal {
  if (selection === null) return NOTHING_REVEALED;
  const { from, to } = selection;
  const styles = new Set<number>();
  analysis.styles.forEach((style, index) => {
    if (touches(from, to, style.from, style.to)) styles.add(index);
  });
  const markers = new Set<number>();
  analysis.markers.forEach((marker, index) => {
    const shown =
      marker.style >= 0 ? styles.has(marker.style) : touches(from, to, marker.from, marker.to + 1);
    if (shown) markers.add(index);
  });
  const spaces = new Set<number>();
  analysis.collapsed.forEach((range, index) => {
    if (
      touches(from, to, range.from, range.to) &&
      !/[\r\n]/.test(text.slice(range.from, range.to))
    ) {
      spaces.add(index);
    }
  });
  if (markers.size === 0 && spaces.size === 0) return NOTHING_REVEALED;
  return { markers, spaces, key: `${[...markers].join(",")}|${[...spaces].join(",")}` };
}
