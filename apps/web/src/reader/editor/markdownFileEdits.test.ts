import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import {
  applyExternalSource,
  continuationPrefix,
  hardBreak,
  indentListItem,
  isStructuralSpace,
  joinForward,
  leaveRawBlock,
  lineBeforeCaret,
  liftMarker,
  materializeTransient,
  outdentListItem,
  pastedSource,
  reparseBlockAt,
  replaceRegionSource,
  setCodeBlockLanguage,
  splitBlock,
  toggleInline,
  toggleTask,
} from "./markdownFileEdits";
import { inlineAnalysisFor } from "./markdownFileInline";
import { buildMarkdownFileDoc, parseMarkdownFile } from "./markdownFileParse";
import { posAtSourceOffset, serializeMarkdownFile, sourceOffsetAt } from "./markdownFileSerialize";

const options = { math: true };

/** A state for `marked`, with the caret at `|` or the selection between two of them. */
function stateOf(marked: string) {
  const first = marked.indexOf("|");
  const second = marked.indexOf("|", first + 1);
  const source = marked.replaceAll("|", "");
  const doc = buildMarkdownFileDoc(parseMarkdownFile(source, options));
  const anchor = posAtSourceOffset(doc, first);
  const head = second === -1 ? anchor : posAtSourceOffset(doc, second - 1);
  return EditorState.create({ doc, selection: TextSelection.create(doc, anchor, head) });
}

const sourceOf = (state: EditorState) => serializeMarkdownFile(state.doc);
const caretOf = (state: EditorState) => sourceOffsetAt(state.doc, state.selection.head);

/** The source with `|` at the caret. */
function marked(state: EditorState) {
  const source = sourceOf(state);
  const caret = caretOf(state);
  return `${source.slice(0, caret)}|${source.slice(caret)}`;
}

function run(state: EditorState, tr: Transaction | null) {
  expect(tr).not.toBeNull();
  return state.apply(tr!);
}

function topLevel(doc: ProseMirrorNode) {
  const nodes: ProseMirrorNode[] = [];
  doc.forEach((node) => nodes.push(node));
  return nodes;
}

function type(state: EditorState, text: string) {
  let next = state;
  for (const char of text) {
    next = next.apply(next.tr.insertText(char));
    if (char === " " && isStructuralSpace((lineBeforeCaret(next) ?? "").slice(0, -1))) {
      next = next.apply(reparseBlockAt(next, next.selection.head, options) ?? next.tr);
    }
  }
  return next;
}

describe("source edits", () => {
  it("typing in a paragraph inside a quote inside a list changes only the typed bytes", () => {
    const original = "# Top\n\n- intro\n\n  > quoted text\n  > more\n\nend\n";
    const state = stateOf(original.replace("quoted ", "quoted |"));
    const typed = type(state, "new ");
    expect(sourceOf(typed)).toBe(original.replace("quoted ", "quoted new "));
    expect(reparseBlockAt(typed, typed.selection.head, options)).toBeNull();
    const [heading, , end] = topLevel(typed.doc);
    expect(heading).toBe(topLevel(state.doc)[0]);
    expect(end).toBe(topLevel(state.doc)[2]);
  });

  it("Enter splits a paragraph, keeping the container prefix", () => {
    const state = stateOf("> one| two\n");
    expect(marked(run(state, splitBlock(state, options)))).toBe("> one\n>\n> |two\n");
  });

  it("Enter in a quoted list item continues the list through the quote", () => {
    const state = stateOf("> - a|b\n> - c\n");
    expect(marked(run(state, splitBlock(state, options)))).toBe("> - a\n> - |b\n> - c\n");
  });

  it("Enter on an empty last item leaves the list for an empty paragraph", () => {
    const state = stateOf("- a\n- |\n");
    const exited = run(state, splitBlock(state, options));
    expect(sourceOf(exited)).toBe("- a\n");
    expect(exited.selection.$head.parent.attrs.transient).toBe("");
    const typedInto = type(exited, "x");
    const typed = run(typedInto, materializeTransient(typedInto, options));
    expect(sourceOf(typed)).toBe("- a\n\nx\n");
    expect(topLevel(typed.doc).map((node) => node.type.name)).toEqual(["bulletList", "paragraph"]);
  });

  it("Enter twice at a list's end and leaving adds no bytes", () => {
    for (const original of [
      "- plain item\n\n<div>x</div>\n",
      "> - a\n>\n> - b\n\nc\n",
      "- [ ] one\n- [x] two\n\nend\n",
    ]) {
      const at = original.indexOf("\n\n");
      let state = stateOf(`${original.slice(0, at)}|${original.slice(at)}`);
      state = run(state, splitBlock(state, options));
      state = run(state, splitBlock(state, options));
      expect(sourceOf(state)).toBe(original);
      expect(state.selection.$head.parent.attrs.transient).not.toBeNull();
    }
  });

  it("Enter at a heading's end makes an empty paragraph that owns no bytes", () => {
    const original = "# Title\n\nBody\n";
    const state = stateOf("# Title|\n\nBody\n");
    const split = run(state, splitBlock(state, options));
    expect(sourceOf(split)).toBe(original);
    expect(split.selection.$head.parent.type.name).toBe("paragraph");
    // Left empty, the next parse drops it and nothing changed.
    const reparsed = run(split, reparseBlockAt(split, 1, options));
    expect(sourceOf(reparsed)).toBe(original);
    expect(topLevel(reparsed.doc).map((node) => node.type.name)).toEqual(["heading", "paragraph"]);
    // Typed into, it takes a blank line on each side.
    const typed = type(split, "x");
    expect(marked(run(typed, materializeTransient(typed, options)))).toBe(
      "# Title\n\nx|\n\nBody\n",
    );
  });

  it.each([
    ["- a|\n", "x\ny\n- [ ] task\n  more", "x\n  y\n- [ ] task\n  more"],
    ["- top\n  - sub|\n", "\n- [ ] t\n1. n", "\n  - [ ] t\n  1. n"],
    ["> - a|\n", "\n- b\nc", "\n> - b\n> c"],
    ["para|\n", "\n- b", "\n- b"],
  ])("pasting into %j continues its containers, list markers as siblings", (at, text, out) => {
    expect(pastedSource(stateOf(at), text)).toBe(out);
  });

  it("Shift-Enter writes a backslash break with the line's continuation prefix", () => {
    const state = stateOf("- a|b\n");
    expect(marked(run(state, hardBreak(state, options)))).toBe("- a\\\n  |b\n");
  });

  it.each([
    ["#", "# ", "heading"],
    [">", "> ", "blockquote"],
    ["1.", "1. ", "orderedList"],
    ["-", "- ", "bulletList"],
    ["#x", "#x ", "paragraph"],
  ])("typing %j then a space", (typed, source, nodeType) => {
    const result = type(stateOf("text\n\n|ab\n"), `${typed} `);
    expect(sourceOf(result)).toBe(`text\n\n${source}ab\n`);
    expect(topLevel(result.doc).at(-1)!.type.name).toBe(nodeType);
  });

  it("an opening fence and Enter add the closing fence", () => {
    // Typing does not reparse, so the fence line is still a paragraph when Enter comes.
    const empty = stateOf("|z|\n");
    const state = empty.apply(empty.tr.insertText("```ts"));
    expect(state.selection.$head.parent.type.name).toBe("paragraph");
    const fenced = run(state, splitBlock(state, options));
    expect(marked(fenced)).toBe("```ts\n|\n```\n");
    expect(fenced.selection.$head.parent.type.name).toBe("codeBlock");
    expect(fenced.selection.$head.parent.attrs.info).toBe("ts");
  });

  it.each([
    ["heading marker", "## |Title\n", "|Title\n"],
    ["quote marker", "> |q\n", "|q\n"],
    ["list marker", "- |a\n", "|a\n"],
    ["task box", "- [ ] |a\n", "- |a\n"],
    ["nested quote", "> > |q\n", "> |q\n"],
    ["two paragraphs", "a\n\n|b\n", "a|b\n"],
    ["a paragraph after a rule", "a\n\n---\n|b\n", "a\n\n|b\n"],
  ])("Backspace at the start: %s", (_, before, after) => {
    const state = stateOf(before);
    expect(marked(run(state, liftMarker(state, options)))).toBe(after);
  });

  it("Backspace after a code block moves into it instead of joining", () => {
    const state = stateOf("```\ncode\n```\n\n|after\n");
    const moved = run(state, liftMarker(state, options));
    expect(sourceOf(moved)).toBe(sourceOf(state));
    expect(moved.selection.$head.parent.type.name).toBe("codeBlock");
  });

  it.each([
    ["```\ncode|\n```\n\nafter\n", "paragraph", null],
    ["> ```\n> co|de\n> ```\n", "paragraph", "> "],
    ["$$\nx|\n$$\n", "paragraph", ""],
  ])("Escape in %j puts the caret just after the block", (at, parent, transient) => {
    const state = stateOf(at);
    const left = run(state, leaveRawBlock(state, options));
    expect(sourceOf(left)).toBe(sourceOf(state));
    const { $head } = left.selection;
    expect([$head.parent.type.name, $head.parentOffset]).toEqual([parent, 0]);
    expect($head.parent.attrs.transient).toBe(transient);
    expect(left.selection.$head.before()).toBeGreaterThan(state.selection.$head.before());
  });

  it("Delete at the end joins the next paragraph", () => {
    const state = stateOf("a|\n\n> b\n");
    expect(marked(run(state, joinForward(state, options)))).toBe("a|b\n");
  });

  it.each([
    ["nested", "- a\n- |b\n", "- a\n  - |b\n"],
    ["quoted", "> - a\n> - |b\n", "> - a\n>   - |b\n"],
    ["ordered", "1. a\n2. |b\n", "1. a\n   1. |b\n"],
  ])("Tab and Shift-Tab in a %s list", (_, before, after) => {
    const state = stateOf(before);
    const indented = run(state, indentListItem(state, options));
    expect(marked(indented)).toBe(after);
    expect(marked(run(indented, outdentListItem(indented, options)))).toBe(before);
  });

  it.each([
    ["- [ ] a\n", "- [x] a\n"],
    ["- [x] a\n", "- [ ] a\n"],
    ["- [X] a\n", "- [ ] a\n"],
    ["> 1. [ ] a\n", "> 1. [x] a\n"],
  ])("toggleTask %j", (before, after) => {
    const state = stateOf(before.replace(" a", " |a"));
    const toggled = run(state, toggleTask(state, state.selection.head, options));
    expect(sourceOf(toggled)).toBe(after);
    const item = toggled.selection.$head.node(toggled.selection.$head.depth - 1);
    expect(item.attrs.checked).toBe(after.includes("[x]"));
  });

  it("toggleInline wraps the selection and unwraps a styled range", () => {
    const state = stateOf("a |b| c\n");
    const bold = run(state, toggleInline(state, "strong", options));
    expect(sourceOf(bold)).toBe("a **b** c\n");
    expect(marked(run(bold, toggleInline(bold, "strong", options)))).toBe("a b| c\n");
    const linked = run(state, toggleInline(state, "a", options));
    expect(marked(linked)).toBe("a [b](|) c\n");
    const code = stateOf("x `c|ode` y\n");
    expect(sourceOf(run(code, toggleInline(code, "code", options)))).toBe("x code y\n");
  });

  it("toggleInline leaves out the selection's edge whitespace and keeps code spans whole", () => {
    const spaced = stateOf("a| b |c\n");
    expect(sourceOf(run(spaced, toggleInline(spaced, "em", options)))).toBe("a *b* c\n");
    const blank = stateOf("a\n| |b\n");
    expect(toggleInline(blank, "strong", options)).toBeNull();
    const across = stateOf("run `vp |test` now| ok\n");
    expect(sourceOf(run(across, toggleInline(across, "code", options)))).toBe(
      "run `` `vp test` now `` ok\n",
    );
    expect(sourceOf(run(across, toggleInline(across, "strong", options)))).toBe(
      "run **`vp test` now** ok\n",
    );
  });

  it("a language change rewrites only the language in the info string", () => {
    const state = stateOf("```js title=x\nco|de\n```\n");
    const changed = run(state, setCodeBlockLanguage(state, 0, "ts", options));
    expect(marked(changed)).toBe("```ts title=x\nco|de\n```\n");
    const plain = run(changed, setCodeBlockLanguage(changed.apply(changed.tr), 0, "", options));
    expect(sourceOf(plain)).toBe("```text title=x\ncode\n```\n");
  });

  it.each([
    ["start", (source: string) => `Intro\n\n${source}`],
    ["middle", (source: string) => source.replace("two", "2")],
    ["end", (source: string) => `${source}\nmore\n`],
  ])("applyExternalSource at the %s keeps the caret and stays out of history", (_, edit) => {
    const original = "# One\n\ntwo three\n\n- four\n";
    const state = stateOf(original.replace("three", "th|ree"));
    const external = edit(original);
    const tr = applyExternalSource(state, external, options)!;
    expect(tr.getMeta("addToHistory")).toBe(false);
    const applied = state.apply(tr);
    expect(sourceOf(applied)).toBe(external);
    const caret = caretOf(applied);
    expect(external.slice(caret - 2, caret + 3)).toBe("three");
    expect(applyExternalSource(applied, external, options)).toBeNull();
  });

  it("an unclosed fence takes the rest of the file", () => {
    const original = "a\n\nb\n\nc\n\n- d\n";
    const state = stateOf(original);
    const tr = replaceRegionSource(state, { from: 3, to: 3, insert: "```\n" }, options);
    const fenced = state.apply(tr);
    expect(sourceOf(fenced)).toBe("a\n\n```\nb\n\nc\n\n- d\n");
    expect(topLevel(fenced.doc).map((node) => node.type.name)).toEqual(["paragraph", "codeBlock"]);
    expect(topLevel(fenced.doc)[0]).toBe(topLevel(state.doc)[0]);
  });

  it.each([
    ["a closing fence under an unclosed front matter fence", "---\na: 1\n\n# H\n", 13, "\n---"],
    [
      "an unclosed `$$` that reads as a setext heading",
      "---\na: 1\n---\n\n# H\n\n> q\n\n- l\n",
      0,
      "$$\n",
    ],
    ["an unclosed `$$` kept as source", "a\n\n<b>x</b>\n\nc\n\n- l\n", 3, "$$\n"],
  ])("a region edit parses as the whole file does: %s", (_, original, at, insert) => {
    const state = stateOf(original);
    const edited = state.apply(replaceRegionSource(state, { from: at, to: at, insert }, options));
    const next = original.slice(0, at) + insert + original.slice(at);
    expect(edited.doc.eq(buildMarkdownFileDoc(parseMarkdownFile(next, options)))).toBe(true);
  });

  it("a lazy line joins the paragraph above when its blank line goes", () => {
    const state = stateOf("a\n\nb\n\nc\n");
    const joined = state.apply(replaceRegionSource(state, { from: 1, to: 2, insert: "" }, options));
    expect(sourceOf(joined)).toBe("a\nb\n\nc\n");
    expect(topLevel(joined.doc).length).toBe(2);
    expect(topLevel(joined.doc)[1]).toBe(topLevel(state.doc)[2]);
  });

  it("a new definition resolves references elsewhere in the file", () => {
    const state = stateOf("See [x].\n\nend\n");
    const styles = (node: ProseMirrorNode) =>
      inlineAnalysisFor(node, [], options)!.styles.map((style) => `${style.kind} ${style.href}`);
    expect(styles(topLevel(state.doc)[0]!)).toEqual([]);
    const tr = replaceRegionSource(
      state,
      { from: 14, to: 14, insert: "\n[x]: https://e.com" },
      options,
    );
    const defined = state.apply(tr);
    expect(sourceOf(defined)).toBe("See [x].\n\nend\n\n[x]: https://e.com");
    expect(styles(topLevel(defined.doc)[0]!)).toEqual(["a https://e.com"]);
    // The old document, which undo returns to, still has no link there.
    expect(styles(topLevel(state.doc)[0]!)).toEqual([]);
  });

  it.each([
    ["", ""],
    ["## ", ""],
    ["> ", "> "],
    ["- ", "  "],
    ["10. ", "    "],
    ["> - [ ] ", ">   "],
    ["-\t", "    "],
    ["  > > ", "  > > "],
    ["```js\n  ", "  "],
  ])("continuationPrefix(%j)", (before, continuation) => {
    expect(continuationPrefix(before)).toBe(continuation);
  });
});
