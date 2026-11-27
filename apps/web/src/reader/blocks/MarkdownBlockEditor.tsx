import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { READER_ROOT_CLASS } from "~/components/ChatMarkdown";
import { cn, isMacPlatform } from "~/lib/utils";

import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";

import { renderedHitOffset, type RenderedHit } from "./renderedCaret";
import {
  type MarkdownCommand,
  markdownCommandForKey,
  runMarkdownCommand,
} from "./markdownBlockKeys";
import { markdownBlocks, type MarkdownBlock } from "./markdownBlocks";
import { continueOnEnter, indentLines } from "./markdownCommands";
import { MarkdownBlockMenu, type MarkdownBlockMenuTarget } from "./MarkdownBlockMenu";

/** The open block: where it sits in the text, what it held, and the source being typed. */
interface OpenBlock {
  readonly from: number;
  readonly to: number;
  readonly draft: string;
  /** Written before an appended block's draft, and dropped again if the draft stays empty. */
  readonly joiner: string;
  readonly caret: number;
}

export interface MarkdownBlockEditorProps {
  readonly text: string;
  readonly math: boolean;
  /** Changes whenever the host takes in contents written elsewhere, closing the open block. */
  readonly externalRevision: number;
  readonly onTextChange: (text: string) => void;
  readonly renderBlock: (
    block: MarkdownBlock,
    text: string,
    onTaskToggle: (markerOffset: number, checked: boolean) => void,
  ) => ReactNode;
  readonly onPasteImage?: ((file: File) => Promise<string | null>) | undefined;
  readonly onOpenLink?: ((href: string) => void) | undefined;
}

const HISTORY_LIMIT = 100;

/** `base` with the open block's source written over the bytes it was opened from. */
function textWith(base: string, open: OpenBlock) {
  const draft = open.draft === "" ? "" : open.joiner + open.draft;
  return base.slice(0, open.from) + draft + base.slice(open.to);
}

/** The clicked text position in a rendered block, read from the DOM under the pointer. */
function hitAt(event: MouseEvent): RenderedHit | null {
  const doc = event.currentTarget.ownerDocument;
  const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
  const node = position?.offsetNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const cell = (node.parentElement?.closest("td, th") ?? null) as HTMLTableCellElement | null;
  const row = cell?.parentElement as HTMLTableRowElement | null;
  const table = cell?.closest("table");
  return {
    text: node.textContent ?? "",
    offset: position.offset,
    cell:
      cell && row && table
        ? { row: Array.from(table.rows).indexOf(row), column: cell.cellIndex }
        : undefined,
  };
}

function caretOnFirstLine(field: HTMLTextAreaElement) {
  return !field.value.slice(0, field.selectionStart).includes("\n");
}

function caretOnLastLine(field: HTMLTextAreaElement) {
  return !field.value.slice(field.selectionEnd).includes("\n");
}

/**
 * Markdown as ElyMark edits it: the file's text is the document. Top-level blocks are drawn as
 * the reading view draws them; the pressed block opens as its source, and closing it writes that
 * source back over exactly the bytes it came from.
 */
export function MarkdownBlockEditor(props: MarkdownBlockEditorProps) {
  const { text, math, onTextChange } = props;
  const [parsed, setParsed] = useState(() => ({
    text,
    math,
    blocks: markdownBlocks(text, { math }),
  }));
  const [open, setOpen] = useState<OpenBlock | null>(null);
  const [externalRevision, setExternalRevision] = useState(props.externalRevision);
  const [menu, setMenu] = useState<MarkdownBlockMenuTarget | null>(null);
  // Undo steps belong to one revision of the file; contents written elsewhere start afresh.
  const [history, setHistory] = useState<{
    readonly undo: readonly string[];
    readonly redo: readonly string[];
  }>({ undo: [], redo: [] });
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // Contents written elsewhere replace the text the open block was cut from.
  if (externalRevision !== props.externalRevision) {
    setExternalRevision(props.externalRevision);
    setOpen(null);
    setHistory({ undo: [], redo: [] });
  }
  // Blocks are parsed again only while none is open, so typing never re-parses the file.
  if (open === null && (parsed.text !== text || parsed.math !== math)) {
    setParsed({ text, math, blocks: markdownBlocks(text, { math }) });
  }

  const remember = (before: string) => {
    setHistory((current) => ({ undo: [...current.undo, before].slice(-HISTORY_LIMIT), redo: [] }));
  };

  // While a block is open, `parsed.text` is the text it was opened from.
  const commit = () => {
    if (!open) return parsed;
    const written = textWith(parsed.text, open);
    if (written !== text) onTextChange(written);
    if (written !== parsed.text) remember(parsed.text);
    const next =
      written === parsed.text
        ? parsed
        : { text: written, math, blocks: markdownBlocks(written, { math }) };
    setParsed(next);
    setOpen(null);
    return next;
  };
  const close = () => {
    commit();
  };

  const openBlock = (index: number, caret: "start" | "end" | number) => {
    let view = parsed;
    let target: MarkdownBlock | undefined = parsed.blocks[index];
    if (!target) return;
    if (open) {
      // Blocks after the one being closed move by however much its source grew or shrank.
      const delta = textWith(parsed.text, open).length - parsed.text.length;
      const from = target.from >= open.to ? target.from + delta : target.from;
      view = commit();
      target = view.blocks.find((block) => block.to >= from);
      if (!target) return;
    }
    const source = view.text.slice(target.from, target.to);
    setOpen({
      from: target.from,
      to: target.to,
      draft: source,
      joiner: "",
      caret:
        caret === "start" ? 0 : caret === "end" ? source.length : Math.min(caret, source.length),
    });
  };

  const appendBlock = () => {
    const base = commit().text;
    const joiner =
      base === "" ? "" : base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
    setOpen({ from: base.length, to: base.length, draft: "", joiner, caret: 0 });
  };

  const changeDraft = (draft: string) => {
    if (!open) return;
    const next = { ...open, draft };
    setOpen(next);
    onTextChange(textWith(parsed.text, next));
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the opened block's textarea takes focus and its caret, and grows to fit its source; both are DOM state outside React
  useLayoutEffect(() => {
    const node = field.current;
    if (!node || !open) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  });
  const openKey = open ? `${open.from}:${open.joiner}` : null;
  const focusOpened = useEffectEvent(() => {
    const node = field.current;
    if (!node || !open) return;
    node.focus({ preventScroll: false });
    node.setSelectionRange(open.caret, open.caret);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus moves to a block's textarea when it opens; the caret is DOM selection state
  useLayoutEffect(() => {
    if (openKey !== null) focusOpened();
  }, [openKey]);

  const undo = (redo: boolean) => {
    const from = redo ? history.redo : history.undo;
    const previous = from.at(-1);
    if (previous === undefined) return;
    const rest = from.slice(0, -1);
    const other = [...(redo ? history.undo : history.redo), text];
    setHistory(redo ? { undo: other, redo: rest } : { undo: rest, redo: other });
    onTextChange(previous);
  };

  const applyCommand = (command: MarkdownCommand) => {
    const node = field.current;
    if (!node || !open) return null;
    const blockIndex = parsed.blocks.findIndex((block) => block.from === open.from);
    const result = runMarkdownCommand(command, open.draft, {
      start: node.selectionStart,
      end: node.selectionEnd,
      isFirstBlock: blockIndex <= 0,
    });
    if ("refused" in result) return result.refused;
    node.focus();
    node.setSelectionRange(0, node.value.length);
    // insertText keeps the change on the field's own undo stack, one step per command.
    if (!node.ownerDocument.execCommand("insertText", false, result.text)) changeDraft(result.text);
    node.setSelectionRange(result.selection.start, result.selection.end);
    return null;
  };

  const deleteBlock = (index: number) => {
    const view = commit();
    const block = view.blocks[index];
    if (!block) return;
    const next = view.blocks[index + 1];
    const previous = view.blocks[index - 1];
    // The blank lines after the block go with it; the last block takes the ones before it.
    const written = next
      ? view.text.slice(0, block.from) + view.text.slice(next.from)
      : view.text.slice(0, previous ? previous.to : block.from) +
        view.text.slice(block.to).replace(/^[\r\n]+/, previous ? "\n" : "");
    remember(view.text);
    onTextChange(written);
  };

  // A task box ticked in a rendered block changes only its marker, as one undo step.
  const toggleTask = (block: MarkdownBlock, markerOffset: number, checked: boolean) => {
    const view = commit();
    const written = setMarkdownTaskChecked(view.text, block.from + markerOffset, checked);
    if (written === view.text) return;
    remember(view.text);
    onTextChange(written);
  };

  const clipboard = async (action: "cut" | "copy" | "paste") => {
    const node = field.current;
    if (!node || !open) {
      const block = menu?.index === undefined ? undefined : parsed.blocks[menu.index];
      if (action === "copy" && block)
        await navigator.clipboard?.writeText(parsed.text.slice(block.from, block.to));
      return;
    }
    const { selectionStart: start, selectionEnd: end } = node;
    node.focus();
    node.setSelectionRange(start, end);
    if (action === "paste") {
      const pasted = await navigator.clipboard?.readText().catch(() => null);
      if (pasted) node.ownerDocument.execCommand("insertText", false, pasted);
      return;
    }
    await navigator.clipboard?.writeText(node.value.slice(start, end));
    if (action === "cut") node.ownerDocument.execCommand("delete");
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const node = event.currentTarget;
    const command = markdownCommandForKey(
      event,
      isMacPlatform(navigator.platform),
      node.selectionStart !== node.selectionEnd,
    );
    if (command) {
      event.preventDefault();
      applyCommand(command);
      return;
    }
    const index = open ? parsed.blocks.findIndex((block) => block.from === open.from) : -1;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      root.current?.focus({ preventScroll: true });
      return;
    }
    if (
      event.key === "ArrowUp" &&
      node.selectionStart === node.selectionEnd &&
      caretOnFirstLine(node) &&
      index > 0
    ) {
      event.preventDefault();
      openBlock(index - 1, "end");
      return;
    }
    if (
      event.key === "ArrowDown" &&
      node.selectionStart === node.selectionEnd &&
      caretOnLastLine(node) &&
      index >= 0 &&
      index + 1 < parsed.blocks.length
    ) {
      event.preventDefault();
      openBlock(index + 1, "start");
      return;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const continued = continueOnEnter(node.value, node.selectionStart);
      if (continued) {
        event.preventDefault();
        node.setSelectionRange(0, node.value.length);
        if (!node.ownerDocument.execCommand("insertText", false, continued.text))
          changeDraft(continued.text);
        node.setSelectionRange(continued.selection.start, continued.selection.end);
      }
      return;
    }
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const indented = indentLines(
        node.value,
        { start: node.selectionStart, end: node.selectionEnd },
        event.shiftKey ? -1 : 1,
      );
      if (!("refused" in indented) && indented.text !== node.value) {
        event.preventDefault();
        node.setSelectionRange(0, node.value.length);
        if (!node.ownerDocument.execCommand("insertText", false, indented.text))
          changeDraft(indented.text);
        node.setSelectionRange(indented.selection.start, indented.selection.end);
      }
    }
  };

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo(event.shiftKey);
    } else if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      undo(true);
    } else if (event.key === "Enter" && parsed.blocks.length) {
      event.preventDefault();
      openBlock(0, "start");
    }
  };

  const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) =>
      file.type.startsWith("image/"),
    );
    if (!image || !props.onPasteImage) return;
    event.preventDefault();
    const node = event.currentTarget;
    const at = { start: node.selectionStart, end: node.selectionEnd };
    const path = await props.onPasteImage(image);
    if (path === null || field.current !== node) return;
    node.focus();
    node.setSelectionRange(at.start, at.end);
    const alt = node.value.slice(at.start, at.end);
    node.ownerDocument.execCommand("insertText", false, `![${alt}](${path.replace(/ /g, "%20")})`);
  };

  const onBlockPointer = (event: MouseEvent<HTMLDivElement>, index: number) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest?.('input[type="checkbox"]')) return;
    const link = (event.target as Element).closest?.("a[href]");
    if (link && (event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    const block = parsed.blocks[index]!;
    const source = parsed.text.slice(block.from, block.to);
    const hit = hitAt(event);
    const offset = hit ? renderedHitOffset(source, hit) : null;
    openBlock(index, offset ?? "end");
  };

  const openIndex = open ? parsed.blocks.findIndex((block) => block.from === open.from) : -1;
  const appended = open !== null && openIndex < 0;
  const textarea = open ? (
    <textarea
      ref={field}
      aria-label="Markdown source"
      data-reader-editor=""
      spellCheck
      rows={1}
      className="block w-full resize-none overflow-hidden rounded-md bg-muted/50 px-3 py-2 outline-none ring-1 ring-inset ring-border focus-visible:ring-ring"
      value={open.draft}
      onChange={(event) => changeDraft(event.target.value)}
      onKeyDown={onFieldKeyDown}
      onPaste={(event) => void onPaste(event)}
      onBlur={(event) => {
        // A menu opened from the block keeps it open.
        const to = event.relatedTarget instanceof Element ? event.relatedTarget : null;
        if (!to?.closest('[role="menu"]')) close();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          kind: parsed.blocks[openIndex]?.kind ?? "paragraph",
          editing: true,
        });
      }}
    />
  ) : null;

  return (
    <div
      ref={root}
      tabIndex={-1}
      className={cn(READER_ROOT_CLASS, "outline-none")}
      data-markdown-block-editor
      onKeyDown={onRootKeyDown}
    >
      {parsed.blocks.map((block, index) =>
        index === openIndex ? (
          <div key={`open-${block.from}`}>{textarea}</div>
        ) : (
          <div
            key={`${block.from}-${block.to}`}
            data-markdown-block={block.kind}
            className="cursor-text rounded-md px-1 hover:bg-accent/40 [content-visibility:auto]"
            onMouseDown={(event) => onBlockPointer(event, index)}
            onClick={(event) => {
              const link = (event.target as Element).closest?.("a[href]");
              if (!link) return;
              event.preventDefault();
              if (event.metaKey || event.ctrlKey)
                props.onOpenLink?.(link.getAttribute("href") ?? "");
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({
                x: event.clientX,
                y: event.clientY,
                kind: block.kind,
                editing: false,
                index,
              });
            }}
          >
            {props.renderBlock(block, parsed.text.slice(block.from, block.to), (offset, checked) =>
              toggleTask(block, offset, checked),
            )}
          </div>
        ),
      )}
      {appended ? textarea : null}
      <button
        type="button"
        aria-label="Write a new block at the end"
        data-markdown-block-append=""
        className="min-h-16 w-full cursor-text text-left text-muted-foreground text-sm"
        onMouseDown={(event) => {
          event.preventDefault();
          appendBlock();
        }}
      >
        {parsed.blocks.length === 0 && !open ? "Start writing…" : null}
      </button>
      <MarkdownBlockMenu
        target={menu}
        onClose={() => {
          setMenu(null);
          if (open) field.current?.focus();
        }}
        onCommand={(command) => applyCommand(command)}
        onEdit={() => {
          if (menu?.index !== undefined) openBlock(menu.index, "end");
        }}
        onDelete={() => {
          if (menu?.index !== undefined) deleteBlock(menu.index);
        }}
        onClipboard={(action) => void clipboard(action)}
      />
    </div>
  );
}
