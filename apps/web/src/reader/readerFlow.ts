import type { Element, ElementContent } from "hast";

import type { InlineRun } from "./typeset";

export interface InlineStyle {
  /** A canvas font string that resolves like the element's own font. */
  readonly font: string;
  readonly fontSize: number;
  readonly isItalic: boolean;
}

export type InlineBox =
  /** Flows with the text and adds no width of its own. */
  | { readonly kind: "wrapper"; readonly style: InlineStyle }
  /** Stays in one piece of the given width. */
  | { readonly kind: "atom"; readonly advance: number }
  /** Positioned away from the text, so it takes no part in the lines. */
  | { readonly kind: "outOfFlow" }
  | { readonly kind: "unsupported" };

/** The paragraph as the browser rendered it, walked in step with its hast. */
export interface InlineView<Rendered> {
  readonly children: (parent: Rendered) => ArrayLike<Rendered>;
  /** The data of a text node, undefined for any other node. */
  readonly text: (node: Rendered) => string | undefined;
  readonly box: (node: Rendered, tagName: string) => InlineBox;
}

interface FlowSource {
  /** The elements around the run, outermost first. */
  readonly path: ReadonlyArray<Element>;
  /** The run's own element, for an atom or a line break. */
  readonly node: Element | undefined;
}

export interface ReaderFlow {
  readonly runs: ReadonlyArray<InlineRun>;
  /** One entry per run. */
  readonly sources: ReadonlyArray<FlowSource>;
  /** Out-of-flow elements before the text, such as a task checkbox. */
  readonly lead: ReadonlyArray<Element>;
  /** Out-of-flow elements after the text, such as a footnote's back link. */
  readonly tail: ReadonlyArray<Element>;
  readonly hasAtoms: boolean;
}

const WRAPPER_TAGS = new Set([
  "a",
  "b",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "mark",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
]);
// Their size can change after layout (a load, a decode), which an atom's fixed advance cannot follow.
const MEDIA_TAGS = new Set(["audio", "iframe", "img", "picture", "svg", "video"]);
// What ends a stretch of text set directly in a list item. A task checkbox sits in the marker slot.
const LIST_ITEM_BLOCK_TAGS = new Set([
  "blockquote",
  "details",
  "div",
  "dl",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);
// The engine sets left to right only.
const RIGHT_TO_LEFT = /[\u0590-\u08ff\u200f\u202b\u202e\u2067\ufb1d-\ufdff\ufe70-\ufeff]/u;
const COLLAPSIBLE_SPACE = /[ \t\n\r\f]+/gu;
const BLANK = /^[ \t\n\r\f]*$/u;
export const ATOM_TEXT = "\ufffc";

/** The engine sets left to right only; text with any right-to-left character stays with the browser. */
export const hasRightToLeftText = (text: string) => RIGHT_TO_LEFT.test(text);

function hasMedia(node: ElementContent): boolean {
  if (node.type !== "element") return false;
  return MEDIA_TAGS.has(node.tagName) || node.children.some(hasMedia);
}

const isBlankRun = (run: InlineRun) => run.kind === "text" && BLANK.test(run.text);

/**
 * Reads a paragraph's inline content as runs for the engine, or returns null when any part of
 * it cannot be set safely: the caller then leaves the paragraph to the browser.
 */
export function collectReaderFlow<Rendered>(
  nodes: ReadonlyArray<ElementContent>,
  rendered: Rendered,
  base: InlineStyle,
  view: InlineView<Rendered>,
): ReaderFlow | null {
  const runs: Array<InlineRun> = [];
  const sources: Array<FlowSource> = [];
  const floats: Array<{ readonly node: Element; readonly at: number }> = [];
  let hasAtoms = false;

  const walk = (
    children: ReadonlyArray<ElementContent>,
    parent: Rendered,
    path: ReadonlyArray<Element>,
    style: InlineStyle,
    isCode: boolean,
  ): boolean => {
    const renderedChildren = view.children(parent);
    let cursor = 0;
    for (const child of children) {
      if (child.type === "comment") continue;
      if (child.type === "text") {
        // React renders no node for an empty string.
        if (child.value === "") continue;
        const node = renderedChildren[cursor];
        cursor += 1;
        if (node === undefined || view.text(node) !== child.value) return false;
        if (hasRightToLeftText(child.value)) return false;
        runs.push({
          kind: "text",
          text: child.value,
          font: style.font,
          fontSize: style.fontSize,
          isCode,
          isItalic: style.isItalic,
        });
        sources.push({ path, node: undefined });
        continue;
      }
      if (child.type !== "element") return false;
      const node = renderedChildren[cursor];
      cursor += 1;
      if (node === undefined || view.text(node) !== undefined) return false;
      if (child.tagName === "br") {
        runs.push({ kind: "break" });
        sources.push({ path, node: child });
        continue;
      }
      const box = view.box(node, child.tagName);
      if (box.kind === "outOfFlow") {
        if (path.length > 0) return false;
        floats.push({ node: child, at: runs.length });
      } else if (box.kind === "atom") {
        if (hasMedia(child)) return false;
        hasAtoms = true;
        runs.push({ kind: "atom", advance: box.advance });
        sources.push({ path, node: child });
      } else if (box.kind === "wrapper" && WRAPPER_TAGS.has(child.tagName)) {
        const inside = walk(
          child.children,
          node,
          [...path, child],
          box.style,
          isCode || child.tagName === "code",
        );
        if (!inside) return false;
      } else {
        return false;
      }
    }
    return cursor === renderedChildren.length;
  };

  if (!walk(nodes, rendered, [], base, false)) return null;

  const lead: Array<Element> = [];
  const tail: Array<Element> = [];
  for (const float of floats) {
    if (runs.slice(0, float.at).every(isBlankRun)) lead.push(float.node);
    else if (runs.slice(float.at).every(isBlankRun)) tail.push(float.node);
    else return null;
  }
  return { runs, sources, lead, tail, hasAtoms };
}

/**
 * The text a reader copies from the flow: white space collapsed as the browser collapses it,
 * hard breaks as newlines, one placeholder per atom.
 */
export function readerFlowText(runs: ReadonlyArray<InlineRun>): string {
  const lines: Array<string> = [];
  let line = "";
  for (const run of runs) {
    if (run.kind === "text") line += run.text;
    else if (run.kind === "atom") line += ATOM_TEXT;
    else {
      lines.push(line);
      line = "";
    }
  }
  lines.push(line);
  return lines.map((text) => text.replace(COLLAPSIBLE_SPACE, " ").trim()).join("\n");
}

interface ListItemPart {
  readonly start: number;
  readonly end: number;
  /** Item text that sits directly in the `li`, to be set as a paragraph. */
  readonly isFlow: boolean;
}

/**
 * Splits a list item's children into stretches of direct text and what lies between them.
 * White space at the ends of a stretch stays outside it, where it still separates the item's
 * text from a nested block when the item is copied.
 */
export function readerListItemParts(children: ReadonlyArray<ElementContent>): Array<ListItemPart> {
  const parts: Array<ListItemPart> = [];
  const push = (start: number, end: number, isFlow: boolean) => {
    if (end > start) parts.push({ start, end, isFlow });
  };
  const isBlank = (index: number) => {
    const child = children[index];
    return child?.type === "comment" || (child?.type === "text" && BLANK.test(child.value));
  };
  let start = 0;
  const closeText = (end: number) => {
    let first = start;
    while (first < end && isBlank(first)) first += 1;
    let last = end;
    while (last > first && isBlank(last - 1)) last -= 1;
    push(start, first, false);
    push(first, last, true);
    push(last, end, false);
    start = end;
  };
  children.forEach((child, index) => {
    if (child.type !== "element" || !LIST_ITEM_BLOCK_TAGS.has(child.tagName)) return;
    closeText(index);
    push(index, index + 1, false);
    start = index + 1;
  });
  closeText(children.length);
  return parts;
}

/** Upright and italic Han sit further apart beside a Hei face than beside a Song face. */
export function readerHanItalicSeam(typography: string | null | undefined): number {
  return typography === "sans" || typography === "sans-avenir" ? 0.04 : 0.02;
}
