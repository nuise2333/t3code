import { describe, expect, it } from "vite-plus/test";

import { editorFlow, editorInlineRuns } from "./editorFlow";
import { analyzeLeafInline, inlineReveal, NOTHING_REVEALED } from "./markdownFileInline";

const OPTIONS = { math: false };

function flowOf(text: string, caret: number | null = null) {
  const analysis = analyzeLeafInline(text, "paragraph", [], OPTIONS);
  const reveal = inlineReveal(analysis, caret === null ? null : { from: caret, to: caret }, text);
  const flow = editorFlow(text, analysis, reveal);
  if (flow === null) throw new Error("no flow");
  return flow;
}

/** Each run as its text and kinds, and the source text each run was taken from. */
function runsOf(text: string, caret: number | null = null) {
  return flowOf(text, caret).runs.map((run) =>
    run.kind === "break"
      ? "<br>"
      : `${run.kinds}:${run.text}:${[...run.sources].map((at) => text[at]).join("")}`,
  );
}

describe("editorFlow", () => {
  it.each<[string, string, number | null, Array<string>]>([
    ["hidden markers", "foo **bar** baz", null, [":foo :foo ", "strong:bar:bar", ": baz: baz"]],
    [
      "markers shown next to the caret",
      "foo **bar** baz",
      7,
      [":foo **:foo **", "strong:bar:bar", ":** baz:** baz"],
    ],
    ["nested styles", "a ***b*** c", null, [":a :a ", "em>strong:b:b", ": c: c"]],
    ["a link", "see [the docs](/d) now", null, [":see :see ", "a:the docs:the docs", ": now: now"]],
    ["adjacent links", "[a](x)[b](y)", null, ["a:a:a", "a:b:b"]],
    ["an escape", "a\\*b", null, [":a*b:a*b"]],
    ["a soft line end", "one \n   two", null, [":one\ntwo:one\ntwo"]],
    ["a backslash hard break", "one\\\ntwo", null, [":one:one", "<br>", ":two:two"]],
    ["a two-space hard break", "one  \ntwo", null, [":one  :one  ", "<br>", ":two:two"]],
    ["inline code", "call `f(x)` now", null, [":call :call ", "code:f(x):f(x)", ": now: now"]],
    ["spaces shown at the caret", "a   b", 2, [":a   b:a   b"]],
    ["spaces collapsed away from it", "a   b", null, [":a   b:a   b"]],
  ])("reads %s", (_name, text, caret, expected) => {
    expect(runsOf(text, caret)).toEqual(expected);
  });

  it("sets a source line end between Han at no width", () => {
    const flow = flowOf("中文\n中文 and\nmore");
    expect(flow.gone).toEqual([{ from: 2, to: 3 }]);
  });

  it("leaves right-to-left text to the browser", () => {
    const text = "hello שלום";
    const analysis = analyzeLeafInline(text, "paragraph", [], OPTIONS);
    expect(editorFlow(text, analysis, NOTHING_REVEALED)).toBeNull();
  });

  it("gives each run the font of its styles, and waits for any it does not know", () => {
    const flow = flowOf("plain **bold** `code`");
    const body = { font: "16px serif", fontSize: 16, isItalic: false };
    const fonts = new Map([
      ["", body],
      ["strong", { ...body, font: "bold 16px serif" }],
    ]);
    expect(editorInlineRuns(flow, (kinds) => fonts.get(kinds))).toBeNull();
    fonts.set("code", { font: "14px mono", fontSize: 14, isItalic: false });
    expect(editorInlineRuns(flow, (kinds) => fonts.get(kinds))).toEqual([
      {
        kind: "text",
        text: "plain ",
        font: "16px serif",
        fontSize: 16,
        isCode: false,
        isItalic: false,
      },
      {
        kind: "text",
        text: "bold",
        font: "bold 16px serif",
        fontSize: 16,
        isCode: false,
        isItalic: false,
      },
      { kind: "text", text: " ", font: "16px serif", fontSize: 16, isCode: false, isItalic: false },
      {
        kind: "text",
        text: "code",
        font: "14px mono",
        fontSize: 14,
        isCode: true,
        isItalic: false,
      },
    ]);
  });
});
