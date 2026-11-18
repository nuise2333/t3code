import type { Element, ElementContent, Properties } from "hast";

import { ATOM_TEXT, type ReaderFlow } from "./readerFlow";
import type { InlineRun, LinePiece, TextPiece, TypesetLine } from "./typeset";
import { faceSegments } from "./typeset/tracking";

// Layout honours 1/64 px; anything finer is rounding noise from the engine's arithmetic.
const STEP = 4096;
const px = (value: number) => `${Math.round(value * STEP) / STEP}px`;
const isSet = (value: number) => Math.abs(value) >= 1 / STEP;

function declarations(entries: ReadonlyArray<readonly [string, number]>) {
  return entries
    .filter(([, value]) => isSet(value))
    .map(([name, value]) => `${name}:${px(value)}`)
    .join(";");
}

function span(properties: Properties, style: string, children: Array<ElementContent>): Element {
  return {
    type: "element",
    tagName: "span",
    properties: style === "" ? properties : { ...properties, style },
    children,
  };
}

/** One face stretch of a text piece, drawn as one span. */
export interface PieceSpan {
  /** The stretch of `text`, in the order given. */
  readonly text: string;
  readonly className: "reader-lat" | "reader-han";
  readonly style: string;
}

/**
 * The spans a text piece is drawn as: one per face, with the engine's spacing and margins.
 * `text` is what the spans hold; the reader passes the piece's own text, the editor the source
 * the piece stands for, whose white space the browser collapses to the same.
 */
function pieceSpanStyles(
  piece: TextPiece,
  run: InlineRun | undefined,
  trackingOf: (font: string) => number,
  text: string = piece.text,
): Array<PieceSpan> {
  // The space a line was broken at is set at no width. Preserved, it survives at the end of its
  // line, where a collapsible one is dropped from `innerText`.
  const isBreakSpace = piece.text === " " && !isSet(piece.advance);
  const tracking = run?.kind === "text" && !isBreakSpace ? trackingOf(run.font) : 0;
  const segments = faceSegments(text);
  return segments.map((segment, index) => {
    const isFirst = index === 0;
    const isLast = index === segments.length - 1;
    const letterSpacing = piece.letterSpacing + (segment.face === "latin" ? tracking : 0);
    const style = declarations([
      ["word-spacing", piece.wordSpacing],
      ["letter-spacing", letterSpacing],
      ["margin-left", isFirst ? piece.marginLeft : 0],
      // CSS adds the letter spacing after the last character too; the engine's advance counts
      // the tracking there but not the justification spacing.
      ["margin-right", isLast ? piece.marginRight - piece.letterSpacing : 0],
    ]);
    // reader.css moves each face to its own baseline, the way the native reader snaps it.
    const className = segment.face === "cjk" ? "reader-han" : "reader-lat";
    return {
      text: segment.text,
      className,
      style: isBreakSpace ? `${style};white-space:pre` : style,
    };
  });
}

function leafOf(
  piece: LinePiece,
  flow: ReaderFlow,
  trackingOf: (font: string) => number,
): Array<ElementContent> {
  if (piece.kind === "atom") {
    const node = flow.sources[piece.run]?.node;
    if (node === undefined) return [];
    const style = declarations([
      ["margin-left", piece.marginLeft],
      ["margin-right", piece.marginRight],
    ]);
    return [span({ className: ["reader-atom"], dataReaderAtom: String(piece.run) }, style, [node])];
  }
  return pieceSpanStyles(piece, flow.runs[piece.run], trackingOf).map((segment) =>
    span({ className: [segment.className] }, segment.style, [
      { type: "text", value: segment.text },
    ]),
  );
}

/**
 * The typeset paragraph as hast, for a block that never wraps on its own: the pieces in order
 * inside one copy of each source wrapper, so the renderer's own components draw the links,
 * code and emphasis, with a `span.reader-eol` wherever the engine ended a line. That marker
 * breaks the line with generated content, which adds nothing to copied or searched text.
 */
export function readerLineNodes(
  lines: ReadonlyArray<TypesetLine>,
  flow: ReaderFlow,
  /** Per-glyph tracking of a run's Latin face, in px; see `readerTracking`. */
  trackingOf: (font: string) => number = () => 0,
): Array<ElementContent> {
  const nodes: Array<ElementContent> = [...flow.lead];
  const open: Array<{ readonly source: Element; readonly copy: Element }> = [];
  const pathOf = (run: number) => flow.sources[run]?.path ?? [];
  /** Appends inside the wrappers of `path`, closing and opening copies as the path changes. */
  const place = (path: ReadonlyArray<Element>, leaf: ElementContent) => {
    let depth = 0;
    while (depth < open.length && open[depth]?.source === path[depth]) depth += 1;
    open.length = depth;
    for (const source of path.slice(depth)) {
      const copy: Element = { ...source, children: [] };
      (open.at(-1)?.copy.children ?? nodes).push(copy);
      open.push({ source, copy });
    }
    (open.at(-1)?.copy.children ?? nodes).push(leaf);
  };

  const firstRunAfter: Array<number> = [];
  let upcoming = Number.POSITIVE_INFINITY;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    firstRunAfter[index] = upcoming;
    upcoming = lines[index]?.pieces[0]?.run ?? upcoming;
  }

  let nextRun = 0;
  lines.forEach((line, index) => {
    if (isSet(line.indent)) {
      place([], span({}, declarations([["margin-left", line.indent]]), []));
    }
    for (const piece of line.pieces) {
      for (const leaf of leafOf(piece, flow, trackingOf)) place(pathOf(piece.run), leaf);
      nextRun = Math.max(nextRun, piece.run + 1);
    }
    if (line.hyphen !== undefined) {
      const hyphen = span({ className: ["reader-hyphen"], ariaHidden: "true" }, "", []);
      place(pathOf(line.hyphen.run), hyphen);
    }
    if (index === lines.length - 1) return;

    // A hard break ends its line by itself, and keeps its newline in copied text.
    const limit = Math.min(firstRunAfter[index] ?? flow.runs.length, flow.runs.length);
    for (let run = nextRun; run < limit; run += 1) {
      const node = flow.sources[run]?.node;
      if (flow.runs[run]?.kind !== "break" || node === undefined) continue;
      place(pathOf(run), node);
      nextRun = run + 1;
      return;
    }
    // Inside the wrappers that carry on into the next line, so none of them is cut in two.
    const next = pathOf(firstRunAfter[index] ?? -1);
    const shared = open.findIndex((wrapper, depth) => wrapper.source !== next[depth]);
    place(
      next.slice(0, shared === -1 ? open.length : shared),
      span({ className: ["reader-eol"], ariaHidden: "true" }, "", []),
    );
  });

  // Hard breaks after the last line's text render nothing, but are still part of the source.
  for (let run = nextRun; run < flow.runs.length; run += 1) {
    const node = flow.sources[run]?.node;
    if (flow.runs[run]?.kind === "break" && node !== undefined) place(pathOf(run), node);
  }
  nodes.push(...flow.tail);
  return nodes;
}

export type ReaderLineDecoration =
  /** A face stretch of a piece, over `[start, end)` of its run's text. */
  | {
      readonly kind: "span";
      readonly run: number;
      readonly start: number;
      readonly end: number;
      readonly className: string;
      readonly style: string;
    }
  /** A line end or a broken word's hyphen, drawn after offset `at` of the run's text. */
  | { readonly kind: "eol" | "hyphen"; readonly run: number; readonly at: number }
  | { readonly kind: "indent"; readonly style: string };

/**
 * The same lines as `readerLineNodes`, as styles over the runs' own text and the line ends
 * between them, for text that stays where it is (the editor's): one span per face stretch of a
 * piece, an end after each line a hard break does not end, and a hyphen after a broken word.
 */
export function readerLineDecorations(
  lines: ReadonlyArray<TypesetLine>,
  runs: ReadonlyArray<InlineRun>,
  trackingOf: (font: string) => number = () => 0,
): Array<ReaderLineDecoration> {
  const out: Array<ReaderLineDecoration> = [];
  lines.forEach((line, index) => {
    if (isSet(line.indent))
      out.push({ kind: "indent", style: declarations([["margin-left", line.indent]]) });
    let last: TextPiece | undefined;
    for (const piece of line.pieces) {
      if (piece.kind !== "text") continue;
      const run = runs[piece.run];
      const source = run?.kind === "text" ? run.text.slice(piece.start, piece.end) : piece.text;
      let at = piece.start;
      for (const segment of pieceSpanStyles(piece, run, trackingOf, source)) {
        const end = at + segment.text.length;
        out.push({ kind: "span", run: piece.run, start: at, end, ...segment });
        at = end;
      }
      last = piece;
    }
    if (last === undefined) return;
    if (line.hyphen !== undefined) out.push({ kind: "hyphen", run: last.run, at: last.end });
    if (index === lines.length - 1) return;
    const nextRun = lines[index + 1]?.pieces[0]?.run ?? runs.length;
    // A hard break ends its line by itself.
    for (let run = last.run + 1; run < nextRun; run += 1) {
      if (runs[run]?.kind === "break") return;
    }
    out.push({ kind: "eol", run: last.run, at: last.end });
  });
  return out;
}

/** What the nodes read as when copied; compare with `readerFlowText` of the source runs. */
export function readerLinesText(nodes: ReadonlyArray<ElementContent>, flow: ReaderFlow): string {
  const outOfFlow = new Set<ElementContent>([...flow.lead, ...flow.tail]);
  const textOf = (node: ElementContent): string => {
    if (node.type === "text") return node.value;
    if (node.type !== "element" || outOfFlow.has(node)) return "";
    if (node.tagName === "br") return "\n";
    if (node.properties.dataReaderAtom !== undefined) return ATOM_TEXT;
    return node.children.map(textOf).join("");
  };
  return nodes.map(textOf).join("");
}
