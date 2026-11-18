import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { isMacPlatform } from "~/lib/utils";

import { orderedListMarkerSlot, orderedListSlotStyle } from "../ReaderOrderedList";
import { inlineStyleOf, subscribeReaderLayoutEpoch } from "../readerTypesetDom";
import { inlineSyntaxKey, replacedRange } from "./inlineSyntaxPlugin";
import { type MarkdownEditOptions, toggleTask } from "./markdownFileEdits";

const FIND_IGNORE = "data-thread-find-ignore";

/** The labels an ordered list shows, as its CSS counter numbers them. */
const listLabels = (list: ProseMirrorNode) =>
  Array.from({ length: list.childCount }, (_, index) => `${(list.attrs.start as number) + index}.`);

/** Number column widths, by labels; one font sets every list in an editor. */
class ListSlots {
  font: string | null = null;
  readonly styles = new Map<string, string>();
  /** A list was drawn without its number column; the next view update measures it. */
  missing = true;

  styleOf(list: ProseMirrorNode): string | undefined {
    const style = this.styles.get(listLabels(list).join(" "));
    if (style === undefined) this.missing = true;
    return style;
  }

  /** Measures the lists whose labels have no width yet; true when any was added. */
  measure(view: EditorView): boolean {
    if (!this.missing) return false;
    this.missing = false;
    let added = false;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== "orderedList") return !node.isTextblock;
      const labels = listLabels(node);
      const key = labels.join(" ");
      if (this.styles.has(key)) return true;
      if (this.font === null) {
        const dom = view.nodeDOM(pos);
        if (!(dom instanceof Element)) return true;
        this.font = inlineStyleOf(getComputedStyle(dom)).font;
      }
      const marker = orderedListMarkerSlot(labels, this.font);
      if (!marker) return true;
      this.styles.set(
        key,
        Object.entries(orderedListSlotStyle(marker))
          .map(([name, value]) => `${name}:${value}`)
          .join(";"),
      );
      added = true;
      return true;
    });
    return added;
  }
}

function taskCheckbox(checked: boolean, options: MarkdownEditOptions) {
  return (view: EditorView, getPos: () => number | undefined) => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    const mac = isMacPlatform(navigator.platform);
    // The box takes no focus inside the text; the caret's item toggles with this chord.
    input.setAttribute("aria-label", `Toggle task (${mac ? "⌘" : "Ctrl+"}Enter)`);
    input.setAttribute("aria-keyshortcuts", mac ? "Meta+Enter" : "Control+Enter");
    input.contentEditable = "false";
    // The click toggles; a mousedown would also move the caret.
    input.addEventListener("mousedown", (event) => event.preventDefault());
    input.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      const tr = toggleTask(view.state, pos, options);
      if (tr) view.dispatch(tr);
    });
    return input;
  };
}

/** Checkboxes before task items' text and number columns on ordered lists, for some blocks. */
function persistentDecorations(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  slots: ListSlots,
  options: MarkdownEditOptions,
): Decoration[] {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "orderedList") {
      const style = slots.styleOf(node);
      if (style) decorations.push(Decoration.node(pos, pos + node.nodeSize, { style }));
    }
    if (node.type.name === "listItem" && node.attrs.checked !== null) {
      const first = node.firstChild;
      if (first?.type.name === "paragraph") {
        const checked = node.attrs.checked === true;
        decorations.push(
          Decoration.widget(pos + 2, taskCheckbox(checked, options), {
            side: -1,
            ignoreSelection: true,
            key: `task:${checked}`,
          }),
        );
      }
    }
    return !node.isTextblock;
  });
  return decorations;
}

const persistentKey = new PluginKey<DecorationSet>("md-block-chrome");

/** The first line's markers of a leaf, as the gutter shows them. */
const gutterText = (before: string) =>
  before.slice(Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1).trim();

function caretDecorations(state: EditorState): DecorationSet {
  const focused = inlineSyntaxKey.getState(state)?.focused === true;
  if (!focused) return DecorationSet.empty;
  const { selection } = state;
  const decorations: Decoration[] = [];
  if (selection instanceof NodeSelection && selection.node.type.name === "horizontalRule") {
    const text = gutterText(selection.node.attrs.before as string);
    decorations.push(
      Decoration.node(selection.from, selection.to, { "data-md-gutter": text, [FIND_IGNORE]: "" }),
    );
    return DecorationSet.create(state.doc, decorations);
  }
  const { $from, $to } = selection;
  if ($from.parent !== $to.parent || !$from.parent.isTextblock) return DecorationSet.empty;
  const node = $from.parent;
  const pos = $from.before();
  if (node.type.name === "rawBlock") {
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, { "data-md-raw-active": "" }, { rawActive: true }),
    );
  } else if (node.type.name === "codeBlock") {
    decorations.push(
      Decoration.node(
        pos,
        pos + node.nodeSize,
        { "data-md-code-active": "" },
        { codeActive: true },
      ),
    );
  } else if (node.type.name === "paragraph" || node.type.name === "heading") {
    const text = gutterText(node.attrs.before as string);
    if (text !== "") {
      decorations.push(
        Decoration.widget(
          pos + 1,
          () => {
            const gutter = document.createElement("span");
            gutter.className = "reader-md-gutter";
            gutter.textContent = text;
            gutter.contentEditable = "false";
            gutter.setAttribute("aria-hidden", "true");
            gutter.setAttribute(FIND_IGNORE, "true");
            return gutter;
          },
          { side: -1, ignoreSelection: true, key: `gutter:${text}` },
        ),
      );
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

/**
 * The block markers and controls around the text: the caret leaf's first-line markers in the
 * margin, where they add no width, task checkboxes, ordered list number columns, and which raw
 * block shows its source.
 */
export function createBlockChromePlugins(options: MarkdownEditOptions): Plugin[] {
  const slots = new ListSlots();
  const persistent = new Plugin<DecorationSet>({
    key: persistentKey,
    state: {
      init: (_, state) =>
        DecorationSet.create(
          state.doc,
          persistentDecorations(state.doc, 0, state.doc.content.size, slots, options),
        ),
      apply: (tr, set, _old, state) => {
        const remeasured = tr.getMeta(persistentKey) === true;
        if (!tr.docChanged && !remeasured) return set;
        if (remeasured) {
          return DecorationSet.create(
            state.doc,
            persistentDecorations(state.doc, 0, state.doc.content.size, slots, options),
          );
        }
        const range = replacedRange(tr);
        let mapped = set.map(tr.mapping, state.doc);
        if (!range) return mapped;
        const start = range.from;
        const end = Math.min(state.doc.content.size, range.to);
        // Whole top-level blocks, so a list's decorations are made with all its items.
        const $start = state.doc.resolve(start);
        const $end = state.doc.resolve(end);
        const from = $start.depth > 0 ? $start.before(1) : start;
        const to = $end.depth > 0 ? $end.after(1) : end;
        mapped = mapped.remove(mapped.find(from, to));
        return mapped.add(state.doc, persistentDecorations(state.doc, from, to, slots, options));
      },
    },
    props: { decorations: (state) => persistentKey.getState(state) },
    view: (view) => {
      const measure = () => {
        if (view.isDestroyed || !slots.measure(view)) return;
        view.dispatch(view.state.tr.setMeta(persistentKey, true).setMeta("addToHistory", false));
      };
      queueMicrotask(measure);
      const stopEpoch = subscribeReaderLayoutEpoch(() => {
        slots.font = null;
        slots.styles.clear();
        slots.missing = true;
        queueMicrotask(measure);
      });
      return {
        update: (_view, previous) => {
          if (view.state.doc !== previous.doc) queueMicrotask(measure);
        },
        destroy: stopEpoch,
      };
    },
  });
  const caret = new Plugin({
    key: new PluginKey("md-caret-chrome"),
    props: { decorations: caretDecorations },
  });
  return [persistent, caret];
}
