import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import {
  type RefObject,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { githubHeadingSlug } from "~/components/chat/markdownFragments";
import { READER_ROOT_CLASS } from "~/components/ChatMarkdown";
import { type ComposerChangeKind, groupUndoByChangeKind } from "~/composer-undo-grouping";
import { isMacPlatform } from "~/lib/utils";

import { codeBlockNodeView } from "./CodeBlockView";
import { EditorPortals } from "./editorPortals";
import {
  inlineSyntaxKey,
  type InlineSyntaxMeta,
  leafTextOf,
  openableHref,
} from "./inlineSyntaxPlugin";
import { applyExternalSource } from "./markdownFileEdits";
import { rememberedInlineAnalysis } from "./markdownFileInline";
import { rawBlockNodeView, RawPreviewContext, type RawPreviewProps } from "./RawBlockView";
import {
  createReaderEditorPlugins,
  EXTERNAL_META,
  readerEditorInputProps,
} from "./readerEditorExtensions";
import { TypesetController } from "./typesetPlugin";

export interface ReaderEditorHandle {
  readonly view: EditorView;
  /** Takes in the file as written elsewhere; false when nothing changed. */
  readonly applyExternal: (source: string) => boolean;
}

/** The href of the link styled at a position, if any. */
function linkAt(state: EditorState, pos: number): string | null {
  const $pos = state.doc.resolve(pos);
  const leaf = $pos.parent;
  const analysis = rememberedInlineAnalysis(leaf);
  if (!analysis || !leaf.isTextblock) return null;
  const offset = leafTextOf(leaf, $pos.before()).offsetAt(pos);
  const style = analysis.styles.find(
    (candidate) => candidate.kind === "a" && candidate.from <= offset && offset < candidate.to,
  );
  return openableHref(style?.href ?? null);
}

/** Links carry real hrefs for assistive tech; only the editor's Mod+click opens one. */
function stayOnLinks(_view: EditorView, event: MouseEvent) {
  if (event.target instanceof Element && event.target.closest("a[href]")) event.preventDefault();
  return false;
}

/** Scrolls to the heading a same-document link names, as the reader's heading ids number them. */
function scrollToFragment(root: HTMLElement, href: string) {
  let id = href.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // An undecodable fragment is matched as written.
  }
  const counts = new Map<string, number>();
  for (const heading of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
    let text = "";
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest("[data-thread-find-ignore]")) text += node.textContent;
    }
    const slug = githubHeadingSlug(text);
    if (!slug) continue;
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    if ((count === 0 ? slug : `${slug}-${count}`) === id) {
      heading.scrollIntoView({ block: "start" });
      return;
    }
  }
}

/**
 * The Markdown file editor: the file's own source, edited in place and drawn as the reading
 * view draws it. The view is made once per document; the file's later versions come in through
 * the handle, and every change is reported with the state it produced.
 */
export function ReaderEditor(props: {
  readonly doc: ProseMirrorNode;
  readonly math: boolean;
  readonly preview: RawPreviewProps;
  /** Set while the view exists, from before the parent's layout effects run. */
  readonly handleRef: RefObject<ReaderEditorHandle | null>;
  /** After each change of the document; `external` when it came in through the handle. */
  readonly onChange: (state: EditorState, external: boolean) => void;
  readonly onBlur: () => void;
  readonly onOpenLink: (href: string) => void;
  readonly onViewChange?: ((view: EditorView | null) => void) | undefined;
}) {
  const { doc, math } = props;
  const mountRef = useRef<HTMLDivElement>(null);
  const [portals] = useState(() => new EditorPortals());
  const items = useSyncExternalStore(portals.subscribe, portals.getSnapshot, portals.getSnapshot);
  const onChange = useEffectEvent((state: EditorState, external: boolean) =>
    props.onChange(state, external),
  );
  const onBlur = useEffectEvent(() => props.onBlur());
  const onOpenLink = useEffectEvent((href: string) => props.onOpenLink(href));
  const onViewChange = useEffectEvent((view: EditorView | null) => props.onViewChange?.(view));
  const { handleRef } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ProseMirror owns the mounted element's DOM; the view is made against it once the element exists, before paint, and destroyed with it
  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const options = { math };
    const typeset = new TypesetController();
    const input = readerEditorInputProps(options);
    let previousKind: ComposerChangeKind | null = null;
    const setFocus = (editor: EditorView, focused: boolean) => {
      const meta: InlineSyntaxMeta = { focused };
      editor.dispatch(
        editor.state.tr.setMeta(inlineSyntaxKey, meta).setMeta("addToHistory", false),
      );
    };
    const editor: EditorView = new EditorView(
      { mount },
      {
        state: EditorState.create({ doc, plugins: createReaderEditorPlugins(options, typeset) }),
        attributes: {
          class: READER_ROOT_CLASS,
          "data-reader-editor": "",
          spellcheck: "true",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "Markdown file",
        },
        nodeViews: {
          rawBlock: rawBlockNodeView(portals),
          codeBlock: codeBlockNodeView(portals, options),
        },
        clipboardTextSerializer: input.clipboardTextSerializer,
        handlePaste: input.handlePaste,
        handleDrop: input.handleDrop,
        handleTextInput: input.handleTextInput,
        handleDOMEvents: {
          ...input.handleDOMEvents,
          click: stayOnLinks,
          auxclick: stayOnLinks,
          focus: (target) => {
            setFocus(target, true);
            return false;
          },
          blur: (target) => {
            setFocus(target, false);
            onBlur();
            return false;
          },
        },
        handleClick: (target, pos, event) => {
          const mac = isMacPlatform(navigator.platform);
          if (!(mac ? event.metaKey : event.ctrlKey)) return false;
          const href = linkAt(target.state, pos);
          if (!href) return false;
          event.preventDefault();
          if (href.startsWith("#")) scrollToFragment(target.dom, href);
          else onOpenLink(href);
          return true;
        },
        dispatchTransaction: (tr: Transaction) => {
          previousKind = groupUndoByChangeKind(tr, previousKind);
          const previous = editor.state;
          // Appended re-parses can change the document of a selection-only transaction.
          const next = previous.apply(tr);
          editor.updateState(next);
          if (next.doc !== previous.doc) onChange(next, tr.getMeta(EXTERNAL_META) === true);
        },
      },
    );
    handleRef.current = {
      view: editor,
      applyExternal: (source: string) => {
        const tr = applyExternalSource(editor.state, source, { math });
        if (!tr) return false;
        editor.dispatch(tr.setMeta(EXTERNAL_META, true));
        return true;
      },
    };
    onViewChange(editor);
    return () => {
      handleRef.current = null;
      onViewChange(null);
      editor.destroy();
    };
  }, [doc, math, portals, handleRef]);

  return (
    <RawPreviewContext value={props.preview}>
      <div ref={mountRef} />
      {items.map((item) => createPortal(item.element, item.container, String(item.key)))}
    </RawPreviewContext>
  );
}
