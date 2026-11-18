import { ThreadId, EnvironmentId } from "@t3tools/contracts";
import { TextSelection } from "@tiptap/pm/state";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import ChatMarkdown from "~/components/ChatMarkdown";

import { render } from "../../../test/render";
import "../../index.css";
import { buildMarkdownFileDoc, parseMarkdownFile } from "./markdownFileParse";
import { ReaderEditor, type ReaderEditorHandle } from "./ReaderEditor";

const SOURCE = `# Typesetting *parity* check

Typography is the craft of arranging type so that written language is **legible, readable** and *appealing* when displayed. The arrangement involves selecting typefaces, point sizes, \`line lengths\`, line spacing and letter spacing, as well as [adjusting the space](https://example.com) between pairs of letters. 中文与 English 混排也应当正确，这是一个很长的句子需要换行，“引号”也要处理。

Second paragraph with ==highlight==, a soft
line end, and enough words to wrap across the column more than once, so that the justification of every line can be compared.

- first item with some text that keeps going long enough to wrap onto a second line in the column
- second item

| a | b |
|---|---|
| 1 | 2 |

Last paragraph.
`;

const PREVIEW = {
  cwd: "/repo",
  imageBaseDir: "/repo",
  threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
  workspaceMutationId: null,
};

/** Each line of a block as where its text is drawn: top, left and right, relative to the block. */
function lineBoxes(block: Element) {
  const origin = block.getBoundingClientRect();
  const range = document.createRange();
  const lines = new Map<number, { left: number; right: number }>();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width === 0) continue;
      const top = Math.round(rect.top - origin.top);
      const line = lines.get(top);
      lines.set(top, {
        left: Math.min(line?.left ?? rect.left, rect.left),
        right: Math.max(line?.right ?? rect.right, rect.right),
      });
    }
  }
  return [...lines]
    .toSorted(([a], [b]) => a - b)
    .map(([top, { left, right }]) => ({
      top,
      left: Math.round((left - origin.left) * 4) / 4,
      right: Math.round((right - origin.left) * 4) / 4,
    }));
}

/** Line boxes of the text blocks both views typeset, in document order. */
function typesetLines(root: Element) {
  return [...root.querySelectorAll("[data-reader-typeset]")].map((block) => ({
    tag: block.tagName,
    height: block.getBoundingClientRect().height,
    lines: lineBoxes(block),
  }));
}

async function renderSideBySide() {
  const handle = createRef<ReaderEditorHandle>();
  const doc = buildMarkdownFileDoc(parseMarkdownFile(SOURCE, { math: false }));
  const screen = await render(
    <div className="flex h-[900px] w-[1200px]">
      <div className="h-full w-[600px] overflow-y-auto" data-testid="reader">
        <ChatMarkdown text={SOURCE} cwd="/repo" variant="reader" />
      </div>
      <div className="h-full w-[600px] overflow-y-auto" data-testid="editor">
        <ReaderEditor
          doc={doc}
          math={false}
          preview={PREVIEW}
          handleRef={handle}
          onChange={() => {}}
          onBlur={() => {}}
          onOpenLink={() => {}}
        />
      </div>
    </div>,
  );
  const reader = screen.container.querySelector('[data-testid="reader"] .markdown-reader')!;
  const editor = screen.container.querySelector("[data-reader-editor]")!;
  // The heading, two paragraphs, two list items and the last paragraph, in each.
  await vi.waitFor(() => {
    expect(reader.querySelectorAll("[data-reader-typeset]")).toHaveLength(6);
    expect(editor.querySelectorAll("[data-reader-typeset]")).toHaveLength(6);
  });
  return { screen, handle, reader, editor };
}

it("sets paragraphs, headings and list items exactly as the reading view, focused or not", async () => {
  const { screen, handle, reader, editor } = await renderSideBySide();
  await using _screen = screen;
  const expected = typesetLines(reader);
  expect(expected.some((block) => block.lines.length > 2)).toBe(true);
  expect(typesetLines(editor)).toEqual(expected);

  // The caret in plain text, away from any marker, changes nothing.
  const view = handle.current!.view;
  const paragraph = view.state.doc.child(1);
  const caret = 1 + view.state.doc.child(0).nodeSize + paragraph.textContent.indexOf("craft") + 2;
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)));
  await vi.waitFor(() => expect(editor.querySelectorAll("[data-reader-typeset]")).toHaveLength(6));
  expect(typesetLines(editor)).toEqual(expected);
});

it("shows markers only around the caret, and lays out only that paragraph again", async () => {
  const { screen, handle, reader, editor } = await renderSideBySide();
  await using _screen = screen;
  const expected = typesetLines(reader);
  const view = handle.current!.view;
  const paragraph = view.state.doc.child(1);
  const caret = 1 + view.state.doc.child(0).nodeSize + paragraph.textContent.indexOf("legible");
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)));
  await vi.waitFor(() => {
    const markers = [...editor.querySelectorAll(".reader-md-marker")].map((m) => m.textContent);
    expect(markers).toEqual(["**", "**"]);
  });
  await vi.waitFor(() => expect(editor.querySelectorAll("[data-reader-typeset]")).toHaveLength(6));
  const shown = typesetLines(editor);
  expect(shown[1]).not.toEqual(expected[1]);
  expect([shown[0], ...shown.slice(2)]).toEqual([expected[0], ...expected.slice(2)]);
});

it("edits a table as source while the caret is in it and renders it once it leaves", async () => {
  const { screen, handle, editor } = await renderSideBySide();
  await using _screen = screen;
  const raw = editor.querySelector<HTMLElement>(".reader-raw")!;
  await vi.waitFor(() => expect(raw.querySelector("table")).not.toBeNull());
  expect(raw.hasAttribute("data-md-raw-active")).toBe(false);

  const preview = raw.querySelector<HTMLElement>(".reader-raw-preview")!;
  preview.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  await vi.waitFor(() => expect(raw.hasAttribute("data-md-raw-active")).toBe(true));
  const view = handle.current!.view;
  expect(view.state.selection.$from.parent.type.name).toBe("rawBlock");

  const { $from } = view.state.selection;
  const cell = $from.start() + $from.parent.textContent.indexOf("| 2 |") + 2;
  view.dispatch(view.state.tr.insertText("x", cell, cell + 1));
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  // Leaving the block parses it again, as a new node with a new view.
  await vi.waitFor(() => {
    const table = editor.querySelector<HTMLElement>(".reader-raw")!;
    expect(table.hasAttribute("data-md-raw-active")).toBe(false);
    expect(table.querySelector("table")?.textContent).toContain("x");
  });
});

it("does not lay text out again until a composition ends", async () => {
  const { screen, handle, editor } = await renderSideBySide();
  await using _screen = screen;
  const view = handle.current!.view;
  const last = view.state.doc.lastChild!;
  const end = view.state.doc.content.size - 1;
  expect(last.textContent).toBe("Last paragraph.");
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  const block = editor.lastElementChild!;
  await vi.waitFor(() => expect(block.hasAttribute("data-reader-typeset")).toBe(true));
  const spansBefore = block.querySelectorAll(".reader-lat").length;

  view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  view.dispatch(view.state.tr.insertText(" more words"));
  expect(block.querySelectorAll(".reader-lat")).toHaveLength(spansBefore);

  view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: " more words" }));
  view.dispatch(view.state.tr.setMeta("addToHistory", false));
  await vi.waitFor(() =>
    expect(
      [...block.querySelectorAll(".reader-lat")].map((span) => span.textContent).join(""),
    ).toContain("more words"),
  );
});

it("deletes one character beside a source line end it hides between Han", async () => {
  const source = "中文第一行\n中文第二行。\n";
  const handle = createRef<ReaderEditorHandle>();
  const doc = buildMarkdownFileDoc(parseMarkdownFile(source, { math: false }));
  await using screen = await render(
    <div className="h-[400px] w-[600px] overflow-y-auto">
      <ReaderEditor
        doc={doc}
        math={false}
        preview={PREVIEW}
        handleRef={handle}
        onChange={() => {}}
        onBlur={() => {}}
        onOpenLink={() => {}}
      />
    </div>,
  );
  const editor = screen.container.querySelector("[data-reader-editor]")!;
  await vi.waitFor(() => expect(editor.querySelector(".reader-ws-gone")).not.toBeNull());
  const view = handle.current!.view;
  view.focus();
  const end = 1 + source.indexOf("\n");
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  view.dispatch(view.state.tr.insertText("好"));
  await userEvent.keyboard("{Backspace}");
  expect(view.state.doc.textContent).toBe("中文第一行\n中文第二行。");
});

it("keeps the soft line ends of a paragraph when a character is typed into it", async () => {
  const source = "First line of a paragraph\nsecond line after a soft break\n\n# A heading\n";
  const handle = createRef<ReaderEditorHandle>();
  const doc = buildMarkdownFileDoc(parseMarkdownFile(source, { math: false }));
  await using screen = await render(
    <div className="h-[400px] w-[600px] overflow-y-auto">
      <ReaderEditor
        doc={doc}
        math={false}
        preview={PREVIEW}
        handleRef={handle}
        onChange={() => {}}
        onBlur={() => {}}
        onOpenLink={() => {}}
      />
    </div>,
  );
  const editor = screen.container.querySelector("[data-reader-editor]")!;
  await vi.waitFor(() => expect(editor.querySelector("[data-reader-typeset]")).not.toBeNull());
  const view = handle.current!.view;
  view.focus();
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + "First".length)),
  );
  await userEvent.keyboard("x");
  expect(view.state.doc.firstChild?.textContent).toBe(
    "Firstx line of a paragraph\nsecond line after a soft break",
  );
});

it("pastes the text of HTML that comes without plain text", async () => {
  const handle = createRef<ReaderEditorHandle>();
  const doc = buildMarkdownFileDoc(parseMarkdownFile("a\n", { math: false }));
  await using _screen = await render(
    <ReaderEditor
      doc={doc}
      math={false}
      preview={PREVIEW}
      handleRef={handle}
      onChange={() => {}}
      onBlur={() => {}}
      onOpenLink={() => {}}
    />,
  );
  const view = handle.current!.view;
  view.focus();
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/html", "<meta charset=utf-8><b>bold</b> text");
  view.dom.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true }));
  expect(view.state.doc.textContent).toBe("abold text");
});
