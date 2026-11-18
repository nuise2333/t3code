import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import { splitBlock } from "./markdownFileEdits";
import { buildMarkdownFileDoc, parseMarkdownFile } from "./markdownFileParse";
import { posAtSourceOffset } from "./markdownFileSerialize";
import { createStructurePlugin } from "./structurePlugin";

const options = { math: false };

describe("structure plugin", () => {
  it("leaves the caret in the paragraph Enter opens after a list, before a raw block", () => {
    const source = "- a\n- \n\n| x |\n|---|\n| 1 |\n";
    const doc = buildMarkdownFileDoc(parseMarkdownFile(source, options));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, posAtSourceOffset(doc, source.indexOf("- \n") + 2)),
      plugins: [createStructurePlugin(options)],
    });
    const next = state.apply(splitBlock(state, options)!);
    expect(next.selection.$head.parent.type.name).toBe("paragraph");
    expect(next.selection.$head.parent.attrs.transient).toBe("");
  });

  it("keeps the caret in an empty paragraph when Enter is pressed in it again", () => {
    for (const source of [
      "Para\n| x |\n|---|\n| 1 |\n",
      "Para\n\nNext\n",
      "- a\n- \n\n| x |\n|---|\n| 1 |\n",
    ]) {
      const doc = buildMarkdownFileDoc(parseMarkdownFile(source, options));
      const at = source.startsWith("-") ? source.indexOf("- \n") + 2 : 4;
      let state = EditorState.create({
        doc,
        selection: TextSelection.create(doc, posAtSourceOffset(doc, at)),
        plugins: [createStructurePlugin(options)],
      });
      state = state.apply(splitBlock(state, options)!);
      expect(splitBlock(state, options)).toBeNull();
      expect(state.selection.$head.parent.attrs.transient).toBe("");
    }
  });

  it("makes a heading of a marker and space inserted by one input event", () => {
    const source = "a\n\nTitle\n";
    const doc = buildMarkdownFileDoc(parseMarkdownFile(source, options));
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, posAtSourceOffset(doc, source.indexOf("Title"))),
      plugins: [createStructurePlugin(options)],
    });
    const next = state.apply(state.tr.insertText("## "));
    expect(next.doc.lastChild!.type.name).toBe("heading");
    expect(next.selection.$head.parent.type.name).toBe("heading");
  });
});
