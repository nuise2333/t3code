import type { ScopedThreadRef } from "@t3tools/contracts";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type {
  Decoration,
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from "@tiptap/pm/view";
import { createContext, use } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";

import { observeNearViewport } from "../readerTypesetDom";
import type { EditorPortals } from "./editorPortals";
import { leafTextOf } from "./inlineSyntaxPlugin";
import type { RawBlockKind } from "./markdownFileSchema";
import { leafText } from "./markdownFileSerialize";
import { type RenderedHit, renderedHitOffset } from "./rawBlockCaret";

export interface RawPreviewProps {
  readonly cwd: string;
  readonly imageBaseDir: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
}

export const RawPreviewContext = createContext<RawPreviewProps | null>(null);

const FOOTNOTE_LABEL = /^\[\^([^\]\r\n]+)\]:[ \t]?/;
const FIND_IGNORE = "data-thread-find-ignore";

/** A raw block as the reading view renders it. */
function RawBlockPreview(props: { readonly kind: RawBlockKind; readonly text: string }) {
  const context = use(RawPreviewContext);
  const { kind, text } = props;
  // Nothing the reader draws: the source itself, muted.
  if (
    !context ||
    kind === "definition" ||
    kind === "frontmatter" ||
    (kind === "html" && /^\s*<!--[\s\S]*-->\s*$/.test(text))
  ) {
    return <div className="reader-raw-muted">{text}</div>;
  }
  const markdown = (source: string) => (
    <ChatMarkdown
      bare
      variant="reader"
      text={source}
      cwd={context.cwd}
      imageBaseDir={context.imageBaseDir}
      threadRef={context.threadRef}
      workspaceMutationId={context.workspaceMutationId}
    />
  );
  if (kind === "footnote") {
    const label = FOOTNOTE_LABEL.exec(text);
    if (label) {
      // A definition alone renders nothing: the reader shows notes only where they are cited.
      const body = text
        .slice(label[0].length)
        .split(/\r?\n/)
        .map((line) => line.replace(/^ {1,4}/, ""))
        .join("\n");
      return (
        <div className="reader-raw-footnote">
          <span className="reader-md-footnote-label">{label[1]}</span>
          {markdown(body)}
        </div>
      );
    }
  }
  return markdown(text);
}

const isRawActive = (decorations: ReadonlyArray<Decoration>) =>
  decorations.some((decoration) => (decoration.spec as { rawActive?: boolean }).rawActive);

/**
 * A block the editor grammar cannot represent exactly: its source, edited as text, while the
 * selection is in it, and the reading view's rendering of it otherwise. The preview mounts
 * once the block nears the view.
 */
class RawBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly key: number;
  private node: ProseMirrorNode;
  private isNear = false;
  private shown = "";
  private stopNear = () => {};
  private isDestroyed = false;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly portals: EditorPortals,
  ) {
    this.node = node;
    this.key = portals.key();
    this.dom = document.createElement("div");
    this.dom.className = "reader-raw";
    this.dom.dataset.mdRawKind = node.attrs.kind as string;
    this.contentDOM = document.createElement("pre");
    this.contentDOM.setAttribute("data-md-raw-source", "");
    this.preview = document.createElement("div");
    this.preview.className = "reader-raw-preview";
    this.preview.contentEditable = "false";
    this.dom.append(this.contentDOM, this.preview);
    this.preview.addEventListener("mousedown", this.onPreviewMouseDown);
    this.setActive(false);
    // ProseMirror attaches the view after constructing it; the scrolled view is found from there.
    queueMicrotask(() => {
      if (this.isDestroyed) return;
      this.stopNear = observeNearViewport(this.dom, (isNear) => {
        if (!isNear || this.isNear) return;
        this.isNear = true;
        this.render();
      });
    });
  }

  private readonly onPreviewMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("a, button, input, summary")) {
      return;
    }
    const pos = this.getPos();
    if (pos === undefined) return;
    event.preventDefault();
    const leaf = leafTextOf(this.node, pos);
    const offset = renderedHitOffset(leaf.text, this.hitAt(event)) ?? 0;
    const { state } = this.view;
    this.view.dispatch(
      state.tr.setSelection(TextSelection.create(state.doc, leaf.startPos(offset))),
    );
    this.view.focus();
  };

  private hitAt(event: MouseEvent): RenderedHit {
    const point = document.caretPositionFromPoint(event.clientX, event.clientY);
    const node = point?.offsetNode;
    const hit = node?.nodeType === Node.TEXT_NODE && this.preview.contains(node);
    const target = event.target instanceof Element ? event.target : null;
    const cell = target?.closest("td, th");
    const row = cell?.parentElement;
    const table = cell?.closest("table");
    return {
      text: hit ? node.textContent! : "",
      offset: hit ? point!.offset : 0,
      cell:
        cell instanceof HTMLTableCellElement &&
        row instanceof HTMLTableRowElement &&
        table instanceof HTMLTableElement &&
        this.preview.contains(table)
          ? { row: [...table.rows].indexOf(row), column: cell.cellIndex }
          : undefined,
    };
  }

  private render() {
    if (!this.isNear) return;
    const text = leafText(this.node);
    if (text === this.shown) return;
    this.shown = text;
    this.portals.set(
      this.key,
      this.preview,
      <RawBlockPreview kind={this.node.attrs.kind as RawBlockKind} text={text} />,
    );
  }

  private setActive(active: boolean) {
    // Only what is shown is searched, so find never counts the block twice.
    this.contentDOM.toggleAttribute(FIND_IGNORE, !active);
    this.preview.toggleAttribute(FIND_IGNORE, active);
  }

  update(node: ProseMirrorNode, decorations: ReadonlyArray<Decoration>) {
    if (node.type !== this.node.type || node.attrs.kind !== this.node.attrs.kind) return false;
    this.node = node;
    const active = isRawActive(decorations);
    this.setActive(active);
    // The rendering is hidden while the source is edited; it is drawn once the caret leaves.
    if (!active) this.render();
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    if (mutation.type === "selection") return false;
    return (
      !this.contentDOM.contains(mutation.target) ||
      (mutation.type === "attributes" && mutation.target === this.contentDOM)
    );
  }

  stopEvent(event: Event) {
    return event.target instanceof Node && this.preview.contains(event.target);
  }

  destroy() {
    this.isDestroyed = true;
    this.stopNear();
    this.preview.removeEventListener("mousedown", this.onPreviewMouseDown);
    this.portals.remove(this.key);
  }
}

export const rawBlockNodeView =
  (portals: EditorPortals): NodeViewConstructor =>
  (node, view, getPos) =>
    new RawBlockView(node, view, getPos, portals);
