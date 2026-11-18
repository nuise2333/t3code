import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";

import {
  isStructuralSpace,
  replaceRegionSource,
  lineBeforeCaret,
  type MarkdownEditOptions,
  materializeTransient,
  REPARSED_META,
  reparseBlockAt,
} from "./markdownFileEdits";
import { rememberedInlineAnalysis } from "./markdownFileInline";
import { sourceOffsetAt } from "./markdownFileSerialize";

const structureKey = new PluginKey("md-structure");

/** The textblock holding the caret, when the selection lies in one. */
function caretBlock(state: EditorState): { node: ProseMirrorNode; pos: number } | null {
  const { $from, $to } = state.selection;
  if ($from.parent !== $to.parent || !$from.parent.isTextblock) return null;
  return { node: $from.parent, pos: $from.before() };
}

/**
 * The caret line's text before the caret when the transactions typed text ending in a space
 * there, without that space. ProseMirror reads typing back from the DOM, so the steps
 * themselves vary, and one input event can insert several characters (`## ` at once).
 */
function lineBeforeTypedSpace(
  transactions: ReadonlyArray<Transaction>,
  oldState: EditorState,
  state: EditorState,
): string | null {
  if (!transactions.some((tr) => tr.docChanged) || !state.selection.empty) return null;
  const line = lineBeforeCaret(state);
  if (line === null || !line.endsWith(" ")) return null;
  const old = oldState.selection.empty ? lineBeforeCaret(oldState) : null;
  return old !== null && old.length < line.length && line.startsWith(old)
    ? line.slice(0, -1)
    : null;
}

/**
 * Text typed into an empty task item Enter made (`- [ ] `, whose box parses as text and whose
 * space is trailing) belongs after the space, where the caret was meant to be.
 */
function typedBeforeTrailingSpaces(
  oldState: EditorState,
  state: EditorState,
  options: MarkdownEditOptions,
) {
  const caret = caretBlock(state);
  const old = caretBlock(oldState);
  if (!caret || !old || !state.selection.empty || !oldState.selection.empty) return null;
  const { $from } = state.selection;
  const trailing = /^[ \t]+/.exec(caret.node.attrs.after as string)?.[0];
  if (!trailing || $from.parentOffset !== caret.node.content.size) return null;
  if (oldState.selection.$from.parentOffset !== old.node.content.size) return null;
  const before = old.node.textContent;
  // Only the empty task item: elsewhere the caret stays before invisible trailing spaces.
  if (!/^\[[ xX]\]$/.test(before)) return null;
  const text = caret.node.textContent;
  if (text.length <= before.length || !text.startsWith(before)) return null;
  const end = sourceOffsetAt(state.doc, $from.pos);
  const typed = text.slice(before.length);
  const caretAt = end + trailing.length;
  return replaceRegionSource(
    state,
    {
      from: end - typed.length,
      to: end + trailing.length,
      insert: trailing + typed,
      selection: [caretAt, caretAt],
    },
    options,
  );
}

/**
 * Re-parses a block where its structure can have changed: a space typed after a block marker,
 * or the caret leaving a raw or code block, an empty paragraph Enter made, or a block that no
 * longer parses as its kind. Appended, so one undo reverts the edit and the re-parse together.
 */
export function createStructurePlugin(options: MarkdownEditOptions): Plugin {
  return new Plugin({
    key: structureKey,
    appendTransaction: (transactions, oldState, state) => {
      if (transactions.some((tr) => tr.getMeta("md-external"))) return null;
      const caret = caretBlock(state);
      const moved = typedBeforeTrailingSpaces(oldState, state, options);
      if (moved) return moved;
      if (caret?.node.type.name === "paragraph" && caret.node.attrs.transient !== null) {
        if (caret.node.content.size > 0) return materializeTransient(state, options);
      }
      if (caret && (caret.node.type.name === "paragraph" || caret.node.type.name === "heading")) {
        const line = lineBeforeTypedSpace(transactions, oldState, state);
        if (line !== null && isStructuralSpace(line)) {
          return reparseBlockAt(state, state.selection.from, options);
        }
      }
      const left = caretBlock(oldState);
      if (!left || transactions.some((tr) => tr.getMeta(REPARSED_META))) return null;
      let pos = left.pos;
      for (const tr of transactions) {
        const mapped = tr.mapping.mapResult(pos, 1);
        // A block the edit replaced was already parsed again; its mapped position is a neighbour.
        if (mapped.deletedAfter) return null;
        pos = mapped.pos;
      }
      const node = state.doc.nodeAt(pos);
      if (!node?.isTextblock || (caret && caret.pos === pos)) return null;
      const name = node.type.name;
      const leaves =
        name === "rawBlock" ||
        name === "codeBlock" ||
        (name === "paragraph" && node.attrs.transient !== null) ||
        rememberedInlineAnalysis(node)?.kindMismatch === true;
      return leaves ? reparseBlockAt(state, pos + 1, options) : null;
    },
  });
}
