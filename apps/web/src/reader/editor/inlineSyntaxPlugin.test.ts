import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import { createInlineSyntaxPlugin, inlineSyntaxKey } from "./inlineSyntaxPlugin";
import { splitBlock } from "./markdownFileEdits";
import { buildMarkdownFileDoc, parseMarkdownFile } from "./markdownFileParse";
import { posAtSourceOffset } from "./markdownFileSerialize";
import { TypesetController } from "./typesetPlugin";

const options = { math: false };

/** The classes drawn over each leaf's text, as `text: classes` per decorated stretch. */
function drawnMarkers(state: EditorState) {
  const decorations = inlineSyntaxKey.getState(state)!.decorations;
  return decorations
    .find()
    .filter((decoration) => decoration.from < decoration.to)
    .map((decoration) => ({
      text: state.doc.textBetween(decoration.from, decoration.to),
      className: (decoration as unknown as { type: { attrs: { class?: string } } }).type.attrs
        .class,
    }))
    .filter((drawn) => drawn.className?.includes("reader-md-marker"));
}

describe("inline syntax plugin", () => {
  it("keeps drawing the leaves a structure edit parsed again unchanged", () => {
    const source = "- **a** one\n- two\n- **b** three\n";
    const doc = buildMarkdownFileDoc(parseMarkdownFile(source, options));
    const caret = posAtSourceOffset(doc, source.indexOf("two") + 3);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, caret),
      plugins: [createInlineSyntaxPlugin(options, new TypesetController())],
    });
    const before = drawnMarkers(state);
    expect(before.map((drawn) => drawn.text)).toEqual(["**", "**", "**", "**"]);

    // Enter in the middle item replaces the whole list with its parse.
    const next = state.apply(splitBlock(state, options)!);
    expect(next.doc.lastChild!.childCount).toBe(4);
    expect(drawnMarkers(next)).toEqual(before);
  });

  it("draws links with their href and the open hint, leaving both off script links", () => {
    const source = '[docs](https://example.com "Docs") and [run](javascript:alert(1))\n';
    const doc = buildMarkdownFileDoc(parseMarkdownFile(source, options));
    const state = EditorState.create({
      doc,
      plugins: [createInlineSyntaxPlugin(options, new TypesetController())],
    });
    const links = inlineSyntaxKey
      .getState(state)!
      .decorations.find()
      .map((decoration) => decoration as unknown as { type: { attrs: Record<string, string> } })
      .map((decoration) => decoration.type.attrs)
      .filter((attrs) => attrs.nodeName === "a");
    expect(links.map((attrs) => attrs.href)).toEqual(["https://example.com", undefined]);
    expect(links[0]!.title).toMatch(/^Docs\n(⌘|Ctrl)-click to open$/);
    expect(links[1]!.title).toBeUndefined();
  });
});
