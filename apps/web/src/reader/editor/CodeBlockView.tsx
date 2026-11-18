import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Decoration, EditorView, NodeView, NodeViewConstructor } from "@tiptap/pm/view";

import { ComposerCodeBlockLanguagePicker } from "~/components/chat/ComposerCodeBlockLanguagePicker";
import { languageOfInfoString } from "~/composer-code-languages";
import { useRenderedAppearance } from "~/hooks/useTheme";

import { readerCodeLanguageLabel } from "../readerBlocks";
import type { EditorPortals } from "./editorPortals";
import { type MarkdownEditOptions, setCodeBlockLanguage } from "./markdownFileEdits";

function CodeLanguagePicker(props: {
  readonly language: string;
  readonly onChange: (language: string) => void;
}) {
  const theme = useRenderedAppearance();
  return (
    <div role="toolbar" aria-label="Code block">
      <ComposerCodeBlockLanguagePicker
        language={props.language}
        theme={theme}
        disabled={false}
        onChange={props.onChange}
      />
    </div>
  );
}

const isCodeActive = (decorations: ReadonlyArray<Decoration>) =>
  decorations.some((decoration) => (decoration.spec as { codeActive?: boolean }).codeActive);

/**
 * A fenced code block drawn as the reading view draws it: the language label in the corner,
 * and, while the selection is in the block, the language picker in its place.
 */
class CodeBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly label: HTMLElement;
  private readonly header: HTMLElement;
  private readonly key: number;
  private node: ProseMirrorNode;
  private active = false;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly portals: EditorPortals,
    private readonly options: MarkdownEditOptions,
  ) {
    this.node = node;
    this.key = portals.key();
    this.dom = document.createElement("div");
    this.dom.className = "reader-codeblock";
    this.label = document.createElement("span");
    this.label.className = "reader-code-label select-none";
    this.label.setAttribute("aria-hidden", "true");
    this.label.contentEditable = "false";
    this.label.setAttribute("data-thread-find-ignore", "true");
    const frame = document.createElement("div");
    frame.className = "chat-markdown-codeblock overflow-hidden";
    frame.dataset.wrap = "true";
    this.header = document.createElement("div");
    this.header.className = "chat-markdown-codeblock-header";
    this.header.contentEditable = "false";
    const pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    pre.append(this.contentDOM);
    frame.append(this.header, pre);
    this.dom.append(this.label, frame);
    this.drawLabel();
  }

  private language() {
    return languageOfInfoString((this.node.attrs.info as string).trim());
  }

  private drawLabel() {
    const language = this.language();
    const label = readerCodeLanguageLabel(language ? `language-${language}` : undefined);
    this.label.replaceChildren();
    this.label.hidden = label === null;
    if (label === null) return;
    const text = document.createElement("span");
    text.textContent = label;
    this.label.append(text);
  }

  private drawPicker() {
    if (!this.active) {
      this.portals.remove(this.key);
      return;
    }
    this.portals.set(
      this.key,
      this.header,
      <CodeLanguagePicker
        language={this.language()}
        onChange={(language) => {
          const pos = this.getPos();
          if (pos === undefined) return;
          const tr = setCodeBlockLanguage(this.view.state, pos, language, this.options);
          if (tr) this.view.dispatch(tr);
          this.view.focus();
        }}
      />,
    );
  }

  update(node: ProseMirrorNode, decorations: ReadonlyArray<Decoration>) {
    if (node.type !== this.node.type) return false;
    const infoChanged = node.attrs.info !== this.node.attrs.info;
    this.node = node;
    if (infoChanged) this.drawLabel();
    const active = isCodeActive(decorations);
    if (active !== this.active || (active && infoChanged)) {
      this.active = active;
      this.drawPicker();
    }
    return true;
  }

  ignoreMutation(mutation: { readonly type: string; readonly target: Node }) {
    if (mutation.type === "selection") return false;
    return !this.contentDOM.contains(mutation.target);
  }

  stopEvent(event: Event) {
    return event.target instanceof Node && this.header.contains(event.target);
  }

  destroy() {
    this.portals.remove(this.key);
  }
}

export const codeBlockNodeView =
  (portals: EditorPortals, options: MarkdownEditOptions): NodeViewConstructor =>
  (node, view, getPos) =>
    new CodeBlockView(node, view, getPos, portals, options);
