import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { isMacPlatform } from "~/lib/utils";

import { styleTag } from "./editorFlow";
import { documentDefinitions } from "./markdownFileEdits";
import {
  editableLeafKind,
  type InlineAnalysis,
  inlineAnalysisFor,
  inlineReveal,
  type InlineReveal,
  NOTHING_REVEALED,
  rememberedInlineAnalysis,
} from "./markdownFileInline";
import type { MarkdownSyntaxOptions } from "./markdownFileSyntax";
import type { LeafLayout, TypesetController } from "./typesetPlugin";

/** A leaf's text and the document positions of its offsets around the line prefix atoms. */
export interface LeafText {
  readonly text: string;
  /** Text offsets at which a line prefix atom stands, before that offset's character. */
  readonly atoms: ReadonlyArray<number>;
  /** The position of offset `offset` as a range start: after an atom standing there. */
  readonly startPos: (offset: number) => number;
  /** The position of offset `offset` as a range end: before an atom standing there. */
  readonly endPos: (offset: number) => number;
  /** The text offset of a position inside the leaf. */
  readonly offsetAt: (pos: number) => number;
}

export function leafTextOf(node: ProseMirrorNode, pos: number): LeafText {
  let text = "";
  const atoms: number[] = [];
  node.forEach((child) => {
    if (child.isText) text += child.text;
    else atoms.push(text.length);
  });
  const atomsUpTo = (offset: number, inclusive: boolean) => {
    let count = 0;
    for (const at of atoms) {
      if (at < offset || (inclusive && at === offset)) count++;
      else break;
    }
    return count;
  };
  return {
    text,
    atoms,
    startPos: (offset) => pos + 1 + offset + atomsUpTo(offset, true),
    endPos: (offset) => pos + 1 + offset + atomsUpTo(offset, false),
    offsetAt: (target) => {
      let offset = 0;
      let at = pos + 1;
      node.forEach((child) => {
        if (at >= target) return;
        if (child.isText) offset += Math.min(child.text!.length, target - at);
        at += child.nodeSize;
      });
      return offset;
    },
  };
}

export interface InlineSyntaxMeta {
  readonly focused?: boolean;
  /** Leaf positions to draw again, or every typeset leaf. */
  readonly rebuild?: ReadonlyArray<number> | "typeset";
  /** Composition ended: draw what it deferred. */
  readonly flush?: boolean;
}

interface InlineSyntaxState {
  readonly decorations: DecorationSet;
  /** The reveal each drawn leaf was drawn with; a leaf far from the view may not be drawn yet. */
  readonly drawn: WeakMap<ProseMirrorNode, string>;
  readonly focused: boolean;
  /** Leaves changed while a composition was in progress, drawn when it ends. */
  readonly pending: ReadonlyArray<number>;
}

export const inlineSyntaxKey = new PluginKey<InlineSyntaxState>("md-inline-syntax");

// Characters of leaf text drawn when the state is made: all of a typical file.
const INITIAL_DRAW_BUDGET = 64_000;

const isEditableLeaf = (node: ProseMirrorNode | null | undefined): node is ProseMirrorNode =>
  node != null && editableLeafKind(node) !== null;

/** What the selection shows of a leaf: nothing unless the focused selection lies inside it. */
export function leafReveal(
  state: EditorState,
  focused: boolean,
  pos: number,
  leaf: LeafText,
  analysis: InlineAnalysis,
): InlineReveal {
  const { $from, $to } = state.selection;
  if (!focused || $from.parent !== $to.parent || !$from.parent.isTextblock) return NOTHING_REVEALED;
  if ($from.before() !== pos) return NOTHING_REVEALED;
  return inlineReveal(
    analysis,
    { from: leaf.offsetAt($from.pos), to: leaf.offsetAt($to.pos) },
    leaf.text,
  );
}

const FIND_IGNORE = { "data-thread-find-ignore": "true" };

const SCRIPT_URL = /^\s*(?:javascript|vbscript|data):/i;

/** A link target the editor may open; the reading view drops script URLs too. */
export const openableHref = (href: string | null) => (href && !SCRIPT_URL.test(href) ? href : null);

// A real href lets assistive tech see the link; the editor keeps clicks from following it.
function linkAttrs(href: string | null, title: string | null) {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const target = openableHref(href);
  const hint = target ? `${isMacPlatform(platform) ? "⌘" : "Ctrl"}-click to open` : "";
  const shown = [title, hint].filter(Boolean).join("\n");
  return {
    nodeName: "a",
    ...(target ? { href: target } : {}),
    ...(shown ? { title: shown } : {}),
    draggable: "false",
  };
}

function widget(className: string, style = ""): () => HTMLElement {
  return () => {
    const element = document.createElement("span");
    element.className = className;
    if (style) element.setAttribute("style", style);
    element.setAttribute("aria-hidden", "true");
    element.contentEditable = "false";
    return element;
  };
}

/**
 * Every decoration of one leaf: the reader's elements for its styles, its markers shown or
 * hidden, collapsed white space, and, when it is typeset, the engine's spans and line ends.
 * Each stretch of text gets one span with its own classes inside its style elements, all over
 * the same range, so the elements nest as the reading view's do.
 */
function leafDecorations(
  node: ProseMirrorNode,
  pos: number,
  leaf: LeafText,
  analysis: InlineAnalysis,
  reveal: InlineReveal,
  layout: LeafLayout | null,
): Decoration[] {
  const { text } = leaf;
  const length = text.length;
  const decorations: Decoration[] = [];
  if (length === 0) return decorations;
  const { styles } = analysis;

  const innermost = new Int32Array(length).fill(-1);
  styles.forEach((style, index) => innermost.fill(index, style.innerFrom, style.innerTo));
  // 1 a muted marker, 2 a hidden one.
  const markers = new Uint8Array(length);
  analysis.markers.forEach((marker, index) => {
    markers.fill(reveal.markers.has(index) ? 1 : 2, marker.from, marker.to);
  });
  const collapsed = new Uint8Array(length);
  analysis.collapsed.forEach((range, index) => {
    if (!reveal.spaces.has(index)) collapsed.fill(1, range.from, range.to);
  });
  const gone = new Uint8Array(length);
  const piece = new Int32Array(length).fill(-1);
  const pieces: Array<{ readonly className: string; readonly style: string }> = [];
  if (layout) {
    for (const range of layout.flow.gone) gone.fill(1, range.from, range.to);
    for (const decoration of layout.decorations) {
      if (decoration.kind !== "span") continue;
      const run = layout.flow.runs[decoration.run];
      if (run?.kind !== "text") continue;
      const index = pieces.length;
      pieces.push({ className: decoration.className, style: decoration.style });
      for (let at = decoration.start; at < decoration.end; at++) piece[run.sources[at]!] = index;
    }
  }
  const atomAt = new Set(leaf.atoms);
  const paths = new Map<number, ReadonlyArray<number>>();
  const pathAt = (at: number) => {
    const style = innermost[at]!;
    let path = paths.get(style);
    if (!path) {
      path = styles.flatMap((candidate, index) =>
        candidate.innerFrom <= at && at < candidate.innerTo ? [index] : [],
      );
      paths.set(style, path);
    }
    return path;
  };

  // ProseMirror wraps a text node in its decorations from the inside out: the span with the
  // stretch's own classes comes first, then its styles from the innermost.
  const emit = (from: number, to: number) => {
    const start = leaf.startPos(from);
    const end = leaf.endPos(to);
    if (end <= start) return;
    const classes: string[] = [];
    const marker = markers[from];
    if (marker === 1) classes.push("reader-md-marker");
    if (marker === 2) classes.push("reader-md-marker-hidden");
    if (collapsed[from] === 1) classes.push("reader-ws-collapse");
    if (gone[from] === 1) classes.push("reader-ws-gone");
    const set = piece[from]! >= 0 ? pieces[piece[from]!] : undefined;
    if (set) classes.push(set.className);
    if (classes.length > 0) {
      decorations.push(
        Decoration.inline(start, end, {
          nodeName: "span",
          class: classes.join(" "),
          ...(set?.style ? { style: set.style } : {}),
          ...(marker ? FIND_IGNORE : {}),
        }),
      );
    }
    const path = pathAt(from);
    for (let index = path.length - 1; index >= 0; index--) {
      const style = styles[path[index]!]!;
      decorations.push(
        Decoration.inline(
          start,
          end,
          style.kind === "a"
            ? linkAttrs(style.href, style.title)
            : { nodeName: styleTag(style.kind) },
        ),
      );
    }
  };
  let from = 0;
  for (let at = 1; at <= length; at++) {
    if (
      at < length &&
      !atomAt.has(at) &&
      innermost[at] === innermost[from] &&
      markers[at] === markers[from] &&
      collapsed[at] === collapsed[from] &&
      gone[at] === gone[from] &&
      piece[at] === piece[from]
    ) {
      continue;
    }
    emit(from, at);
    from = at;
  }

  if (layout) {
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, { "data-reader-typeset": "" }, { typeset: true }),
    );
    for (const decoration of layout.decorations) {
      if (decoration.kind === "indent") {
        decorations.push(
          Decoration.widget(leaf.startPos(0), widget("reader-md-indent", decoration.style), {
            side: -1,
            key: `indent:${decoration.style}`,
          }),
        );
        continue;
      }
      if (decoration.kind === "span") continue;
      const run = layout.flow.runs[decoration.run];
      if (run?.kind !== "text" || decoration.at === 0) continue;
      const after = run.sources[decoration.at - 1]! + 1;
      decorations.push(
        decoration.kind === "eol"
          ? Decoration.widget(leaf.endPos(after), widget("reader-eol"), {
              side: -1,
              key: "eol",
            })
          : Decoration.widget(leaf.endPos(after), widget("reader-hyphen"), {
              side: -2,
              key: "hyphen",
            }),
      );
    }
  }
  return decorations;
}

/**
 * The span of the new document a transaction's steps replaced, or null when it replaced
 * nothing. Mapping drops every decoration inside a replaced range, even where the new content
 * is the same node, so whatever lies inside is decorated again.
 */
export function replacedRange(tr: Transaction): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  tr.mapping.maps.forEach((map, index) => {
    const rest = tr.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      from = Math.min(from, rest.map(newStart, -1));
      to = Math.max(to, rest.map(newEnd, 1));
    });
  });
  return from <= to ? { from, to } : null;
}

/** Positions of the textblocks a transaction replaced, in the new document. */
function changedLeaves(tr: Transaction): number[] {
  const range = replacedRange(tr);
  if (!range) return [];
  const positions: number[] = [];
  const size = tr.doc.content.size;
  tr.doc.nodesBetween(Math.max(0, range.from - 1), Math.min(size, range.to + 1), (node, pos) => {
    if (node.isTextblock) {
      positions.push(pos);
      return false;
    }
    return true;
  });
  return positions;
}

function caretLeafPos(state: EditorState): number | null {
  const { $from, $to } = state.selection;
  if ($from.parent !== $to.parent || !isEditableLeaf($from.parent)) return null;
  return $from.before();
}

export function createInlineSyntaxPlugin(
  options: MarkdownSyntaxOptions,
  typeset: TypesetController,
): Plugin<InlineSyntaxState> {
  // So a caret move redraws only what it changes, and the view's scan draws what it nears.
  const drawn = new WeakMap<ProseMirrorNode, string>();

  const analysisOf = (node: ProseMirrorNode, doc: ProseMirrorNode) =>
    rememberedInlineAnalysis(node) ??
    inlineAnalysisFor(node, documentDefinitions(doc, options), options);

  const draw = (state: EditorState, focused: boolean, pos: number, node: ProseMirrorNode) => {
    const analysis = analysisOf(node, state.doc);
    if (!analysis) return [];
    const leaf = leafTextOf(node, pos);
    const reveal = leafReveal(state, focused, pos, leaf, analysis);
    drawn.set(node, reveal.key);
    const layout = typeset.layoutFor(node, leaf.text, analysis, reveal);
    return leafDecorations(node, pos, leaf, analysis, reveal, layout);
  };

  const revealChanged = (state: EditorState, focused: boolean, pos: number) => {
    const node = state.doc.nodeAt(pos);
    if (!isEditableLeaf(node)) return false;
    const analysis = analysisOf(node, state.doc);
    if (!analysis) return false;
    const reveal = leafReveal(state, focused, pos, leafTextOf(node, pos), analysis);
    return drawn.get(node) !== reveal.key;
  };

  return new Plugin<InlineSyntaxState>({
    key: inlineSyntaxKey,
    state: {
      init: (_, state) => {
        // A long document draws its start; the view's scan draws the rest as it nears the view,
        // before it is painted.
        const decorations: Decoration[] = [];
        let budget = INITIAL_DRAW_BUDGET;
        state.doc.descendants((node, pos) => {
          if (budget <= 0) return false;
          if (node.isTextblock) {
            if (isEditableLeaf(node)) decorations.push(...draw(state, false, pos, node));
            budget -= node.content.size;
            return false;
          }
          return true;
        });
        return {
          decorations: DecorationSet.create(state.doc, decorations),
          drawn,
          focused: false,
          pending: [],
        };
      },
      apply: (tr: Transaction, value, oldState, state) => {
        const meta = tr.getMeta(inlineSyntaxKey) as InlineSyntaxMeta | undefined;
        const focused = meta?.focused ?? value.focused;
        if (!tr.docChanged && !tr.selectionSet && !meta) return value;
        let decorations = value.decorations.map(tr.mapping, tr.doc);
        const dirty = new Set<number>();
        if (tr.docChanged) {
          const inverted = tr.mapping.invert();
          for (const pos of changedLeaves(tr)) {
            dirty.add(pos);
            const fresh = tr.doc.nodeAt(pos);
            const old = tr.before.nodeAt(inverted.map(pos, 1));
            if (fresh && old && old.type === fresh.type && old.attrs.level === fresh.attrs.level) {
              typeset.carry(old, fresh);
            }
          }
        }
        const oldCaret = caretLeafPos(oldState);
        const candidates = [
          oldCaret === null ? null : tr.mapping.map(oldCaret, 1),
          caretLeafPos(state),
        ];
        for (const pos of candidates) {
          if (pos !== null && !dirty.has(pos) && revealChanged(state, focused, pos)) dirty.add(pos);
        }
        if (meta?.rebuild === "typeset") {
          const typesetLeaves = decorations.find(undefined, undefined, (spec) => spec.typeset);
          for (const leaf of typesetLeaves) dirty.add(leaf.from);
        } else {
          for (const pos of meta?.rebuild ?? []) dirty.add(pos);
        }
        let pending = value.pending.map((pos) => tr.mapping.map(pos, 1));
        if (typeset.composing) {
          return { decorations, drawn, focused, pending: [...pending, ...dirty] };
        }
        if (meta?.flush) for (const pos of pending) dirty.add(pos);
        pending = [];
        const removed: Decoration[] = [];
        const added: Decoration[] = [];
        for (const pos of dirty) {
          const node = state.doc.nodeAt(pos);
          if (!node?.isTextblock) continue;
          const end = pos + node.nodeSize;
          for (const old of decorations.find(pos, end)) {
            if (old.from >= pos && old.to <= end) removed.push(old);
          }
          if (isEditableLeaf(node)) added.push(...draw(state, focused, pos, node));
        }
        if (removed.length > 0) decorations = decorations.remove(removed);
        if (added.length > 0) decorations = decorations.add(state.doc, added);
        return { decorations, drawn, focused, pending };
      },
    },
    props: {
      decorations: (state) => inlineSyntaxKey.getState(state)?.decorations,
    },
  });
}
