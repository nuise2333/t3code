import { selectAll } from "@tiptap/pm/commands";
import { history, redo, undo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  type Command,
  type EditorState,
  NodeSelection,
  type Plugin,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { COMPOSER_UNDO_GROUP_DELAY, markAsClipboardEdit } from "~/composer-undo-grouping";

import { createBlockChromePlugins } from "./blockChromePlugin";
import { createCodeHighlightPlugin } from "./codeHighlightPlugin";
import { createInlineSyntaxPlugin } from "./inlineSyntaxPlugin";
import {
  hardBreak,
  indentListItem,
  joinForward,
  leaveRawBlock,
  liftMarker,
  lineBeforeCaret,
  type MarkdownEditOptions,
  outdentListItem,
  pastedSource,
  replaceRegionSource,
  splitBlock,
  toggleInline,
  toggleTask,
} from "./markdownFileEdits";
import { serializeMarkdownFile, sourceOffsetAt } from "./markdownFileSerialize";
import { createStructurePlugin } from "./structurePlugin";
import { createTypesetPlugin, type TypesetController } from "./typesetPlugin";

/** Marks a transaction that takes in a version of the file written elsewhere. */
export const EXTERNAL_META = "md-external";

const isProse = (node: ProseMirrorNode) =>
  node.type.name === "paragraph" || node.type.name === "heading";

/** Whether the selection lies inside one textblock, where native editing keeps the bytes right. */
function isInOneLeaf(state: EditorState) {
  const { selection } = state;
  if (selection instanceof NodeSelection) return false;
  return selection.$from.parent === selection.$to.parent && selection.$from.parent.isTextblock;
}

/** The selection's exact source: what copying it gives. */
function selectionSource(state: EditorState): string {
  const { from, to } = state.selection;
  return serializeMarkdownFile(state.doc).slice(
    sourceOffsetAt(state.doc, from),
    sourceOffsetAt(state.doc, to),
  );
}

/** Replaces the selection's source with `insert`, parsing the touched blocks again. */
function replaceSelectionSource(
  state: EditorState,
  insert: string,
  options: MarkdownEditOptions,
): Transaction {
  const { selection, doc } = state;
  // A selected atom runs from its line start to the next leaf's, so its bytes go with it.
  const from = sourceOffsetAt(doc, selection.from);
  const to = sourceOffsetAt(doc, selection.to);
  const caret = from + insert.length;
  return replaceRegionSource(state, { from, to, insert, selection: [caret, caret] }, options);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The length of the last (`before`) or first (`after`) grapheme of `text`; CRLF is one. */
function graphemeLength(text: string, side: "before" | "after"): number {
  // A grapheme is far shorter than this window, which keeps segmenting cheap in long text.
  const window = side === "before" ? text.slice(-32) : text.slice(0, 32);
  let length = 0;
  for (const { segment } of graphemes.segment(window)) {
    length = segment.length;
    if (side === "after") break;
  }
  return length;
}

function lineEndingBefore(text: string) {
  if (text.endsWith("\r\n")) return 2;
  return text.endsWith("\n") || text.endsWith("\r") ? 1 : 0;
}

export function createReaderEditorPlugins(
  options: MarkdownEditOptions,
  typeset: TypesetController,
): Plugin[] {
  const run =
    (command: (state: EditorState) => Transaction | null, swallow = false): Command =>
    (state, dispatch) => {
      const tr = command(state);
      if (!tr) return swallow;
      dispatch?.(tr.scrollIntoView());
      return true;
    };
  const crossLeaf =
    (insert: string): Command =>
    (state, dispatch) => {
      if (isInOneLeaf(state) || state.selection.empty) return false;
      dispatch?.(replaceSelectionSource(state, insert, options).scrollIntoView());
      return true;
    };

  const enter: Command = (state, dispatch) => {
    if (crossLeaf("")(state, dispatch)) return true;
    const { $from } = state.selection;
    const tr = splitBlock(state, options);
    if (!tr) return true;
    // A new code line keeps the indentation of the line it was split from.
    if ($from.parent.type.name === "codeBlock") {
      const indent = /^[ \t]*/.exec(lineBeforeCaret(state) ?? "")![0];
      if (indent) tr.insertText(indent);
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };

  const backspace: Command = (state, dispatch) => {
    if (crossLeaf("")(state, dispatch)) return true;
    const { selection } = state;
    if (selection instanceof NodeSelection) {
      dispatch?.(replaceSelectionSource(state, "", options));
      return true;
    }
    if (!selection.empty) return false;
    const { $from } = selection;
    if (!$from.parent.isTextblock) return false;
    const before = $from.nodeBefore;
    // A line prefix goes with the line ending before it: the two lines join.
    if (before?.type.name === "linePrefix") {
      const text = $from.parent.childBefore($from.parentOffset - 1).node;
      const width = text?.isText ? lineEndingBefore(text.text!) : 0;
      dispatch?.(state.tr.delete($from.pos - 1 - width, $from.pos));
      return true;
    }
    if ($from.parentOffset !== 0) return false;
    if (isProse($from.parent))
      return run((current) => liftMarker(current, options), true)(state, dispatch);
    return true;
  };

  // The browser's own character deletion also removes text the editor hides next to the caret
  // (a source line end between Han, set at no width), so one character is deleted here.
  const deleteCharacter =
    (side: "before" | "after"): Command =>
    (state, dispatch) => {
      const { selection } = state;
      if (!selection.empty || !selection.$from.parent.isTextblock) return false;
      const { $from } = selection;
      const text = side === "before" ? $from.nodeBefore : $from.nodeAfter;
      if (!text?.isText) return false;
      const length = graphemeLength(text.text!, side);
      const from = side === "before" ? $from.pos - length : $from.pos;
      dispatch?.(state.tr.delete(from, from + length).scrollIntoView());
      return true;
    };

  const deleteForward: Command = (state, dispatch) => {
    if (crossLeaf("")(state, dispatch)) return true;
    const { selection } = state;
    if (selection instanceof NodeSelection) {
      dispatch?.(replaceSelectionSource(state, "", options));
      return true;
    }
    if (!selection.empty) return false;
    const { $from } = selection;
    if (!$from.parent.isTextblock) return false;
    const after = $from.nodeAfter;
    if (after?.isText) {
      const ending = /^(?:\r\n|\r|\n)/.exec(after.text!)?.[0];
      const next = ending ? $from.parent.childAfter($from.parentOffset + ending.length).node : null;
      if (ending && after.text === ending && next?.type.name === "linePrefix") {
        dispatch?.(state.tr.delete($from.pos, $from.pos + ending.length + 1));
        return true;
      }
    }
    if ($from.parentOffset !== $from.parent.content.size) return false;
    if (isProse($from.parent))
      return run((current) => joinForward(current, options), true)(state, dispatch);
    return true;
  };

  const tab =
    (direction: "in" | "out"): Command =>
    (state, dispatch) => {
      const { $from } = state.selection;
      if ($from.parent.type.name === "codeBlock") {
        if (direction === "out") return true;
        dispatch?.(state.tr.insertText("  "));
        return true;
      }
      const command = direction === "in" ? indentListItem : outdentListItem;
      const tr = command(state, options);
      if (!tr) return $from.node($from.depth - 1).type.name === "listItem";
      dispatch?.(tr.scrollIntoView());
      return true;
    };

  const inline = (kind: "strong" | "em" | "code" | "del" | "a"): Command =>
    run((state) => toggleInline(state, kind, options));
  // These chords are also app commands (command palette, settle thread); like Mod+B over the
  // sidebar toggle, the editor takes them only to format selected text.
  const selectedInline =
    (kind: "del" | "a"): Command =>
    (state, dispatch, view) =>
      !state.selection.empty && inline(kind)(state, dispatch, view);

  /** Moves into an adjacent raw block, whose source is hidden from native caret motion. */
  const intoRaw =
    (direction: "up" | "down" | "left" | "right"): Command =>
    (state, dispatch, view) => {
      const { selection } = state;
      if (!view || !selection.empty || !selection.$head.parent.isTextblock) return false;
      if (!view.endOfTextblock(direction)) return false;
      const back = direction === "up" || direction === "left";
      const $edge = state.doc.resolve(back ? selection.$head.before() : selection.$head.after());
      const target = Selection.findFrom($edge, back ? -1 : 1, true);
      if (!target || target.$head.parent.type.name !== "rawBlock") return false;
      const $target = target.$head;
      const pos = back ? $target.end() : $target.start();
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, pos)).scrollIntoView());
      return true;
    };

  return [
    history({ newGroupDelay: COMPOSER_UNDO_GROUP_DELAY }),
    keymap({
      Enter: enter,
      "Shift-Enter": (state, dispatch) => {
        if (crossLeaf("")(state, dispatch)) return true;
        return run((current) => hardBreak(current, options) ?? splitBlock(current, options), true)(
          state,
          dispatch,
        );
      },
      Backspace: (state, dispatch, view) =>
        backspace(state, dispatch, view) || deleteCharacter("before")(state, dispatch, view),
      "Mod-Backspace": backspace,
      "Alt-Backspace": backspace,
      Delete: (state, dispatch, view) =>
        deleteForward(state, dispatch, view) || deleteCharacter("after")(state, dispatch, view),
      "Mod-Delete": deleteForward,
      "Alt-Delete": deleteForward,
      Tab: tab("in"),
      "Shift-Tab": tab("out"),
      "Mod-b": inline("strong"),
      "Mod-i": inline("em"),
      "Mod-e": inline("code"),
      "Mod-Shift-s": selectedInline("del"),
      "Mod-k": selectedInline("a"),
      Escape: run((state) => leaveRawBlock(state, options)),
      "Mod-Enter": run((state) => toggleTask(state, state.selection.from, options)),
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
      "Mod-a": selectAll,
      ArrowUp: intoRaw("up"),
      ArrowDown: intoRaw("down"),
      ArrowLeft: intoRaw("left"),
      ArrowRight: intoRaw("right"),
    }),
    createInlineSyntaxPlugin(options, typeset),
    createTypesetPlugin(typeset),
    createStructurePlugin(options),
    ...createBlockChromePlugins(options),
    createCodeHighlightPlugin(),
  ];
}

/** The plain text of a paste or drop; HTML alone gives its text content. */
function transferredText(data: DataTransfer | null): string {
  const text = data?.getData("text/plain") ?? "";
  const html = text === "" ? (data?.getData("text/html") ?? "") : "";
  if (html === "") return text;
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

/** Clipboard and input handling that keeps every edit a change of the file's source. */
export function readerEditorInputProps(options: MarkdownEditOptions) {
  return {
    clipboardTextSerializer: (_slice: unknown, view: EditorView) => selectionSource(view.state),
    handlePaste: (view: EditorView, event: ClipboardEvent) => {
      const text = transferredText(event.clipboardData);
      if (text === "") return true;
      const tr = replaceSelectionSource(view.state, pastedSource(view.state, text), options);
      view.dispatch(markAsClipboardEdit(tr, "paste").scrollIntoView());
      return true;
    },
    handleDrop: (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean) => {
      const text = transferredText(event.dataTransfer);
      const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (moved || text === "" || !at) return true;
      const state = view.state.apply(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, at.pos)),
      );
      if (!state.selection.$from.parent.isTextblock) return true;
      const tr = replaceSelectionSource(state, pastedSource(state, text), options);
      view.dispatch(tr.setMeta("uiEvent", "drop"));
      return true;
    },
    handleTextInput: (view: EditorView, _from: number, _to: number, text: string) => {
      if (isInOneLeaf(view.state) || view.state.selection.empty) return false;
      view.dispatch(replaceSelectionSource(view.state, text, options));
      return true;
    },
    handleDOMEvents: {
      cut: (view: EditorView, event: ClipboardEvent) => {
        if (view.state.selection.empty) return false;
        event.preventDefault();
        event.clipboardData?.setData("text/plain", selectionSource(view.state));
        const tr = replaceSelectionSource(view.state, "", options);
        view.dispatch(markAsClipboardEdit(tr, "cut").scrollIntoView());
        return true;
      },
      // Native typing over a selection across blocks would merge their DOM; take the
      // selection out as a source edit first and let the key type into the caret.
      keydown: (view: EditorView, event: KeyboardEvent) => {
        const isCharacter =
          event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.isComposing;
        if (!isCharacter || isInOneLeaf(view.state) || view.state.selection.empty) return false;
        view.dispatch(replaceSelectionSource(view.state, "", options));
        return false;
      },
      compositionstart: (view: EditorView) => {
        if (!isInOneLeaf(view.state) && !view.state.selection.empty) {
          view.dispatch(replaceSelectionSource(view.state, "", options));
        }
        return false;
      },
    },
  };
}
