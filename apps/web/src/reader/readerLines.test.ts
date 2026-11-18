import type { Element, ElementContent } from "hast";
import { describe, expect, it } from "vite-plus/test";

import {
  collectReaderFlow,
  readerFlowText,
  type InlineBox,
  type InlineStyle,
  type InlineView,
} from "./readerFlow";
import { readerLineDecorations, readerLineNodes, readerLinesText } from "./readerLines";
import { typesetParagraph, type TypesetOptions } from "./typeset";
import { createFakeMeasurer } from "./typeset/fakeMeasurer";

const text = (value: string): ElementContent => ({ type: "text", value });
/** A typeset run of Latin-face text, as `readerLineNodes` wraps it for its baseline. */
const latin = (value: string): Element => ({
  type: "element",
  tagName: "span",
  properties: { className: ["reader-lat"] },
  children: [text(value)],
});
const element = (
  tagName: string,
  children: Array<ElementContent> = [],
  properties = {},
): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});

const BODY: InlineStyle = { font: "16px body", fontSize: 16, isItalic: false };
const CODE: InlineStyle = { font: "14px code", fontSize: 14, isItalic: false };
const BOXES: Record<string, InlineBox> = {
  math: { kind: "atom", advance: 30 },
  input: { kind: "outOfFlow" },
  aside: { kind: "outOfFlow" },
};

// The hast stands in for its own rendering: every element is drawn by the tag it was written with.
const view: InlineView<ElementContent | Element> = {
  children: (parent) => ("children" in parent ? parent.children : []),
  text: (node) => (node.type === "text" ? node.value : undefined),
  box: (_node, tagName) =>
    BOXES[tagName] ?? { kind: "wrapper", style: tagName === "code" ? CODE : BODY },
};

function setParagraph(nodes: Array<ElementContent>, options: Partial<TypesetOptions> = {}) {
  const flow = collectReaderFlow(nodes, element("p", nodes), BODY, view);
  if (flow === null) throw new Error("the paragraph cannot be set");
  const { lines } = typesetParagraph(
    flow.runs,
    { width: 400, em: 16, ...options },
    createFakeMeasurer(),
  );
  return { flow, lines, nodes: readerLineNodes(lines, flow) };
}

const px = (value: number) => `${Math.round(value * 4096) / 4096}px`;
const isElement = (node: ElementContent | undefined): node is Element => node?.type === "element";
const elements = (nodes: ReadonlyArray<ElementContent>, tagName: string): Array<Element> =>
  nodes.flatMap((node) =>
    isElement(node)
      ? [...(node.tagName === tagName ? [node] : []), ...elements(node.children, tagName)]
      : [],
  );
const PROSE =
  "Typography is the craft of arranging type so that written language is legible, readable and appealing when displayed, whatever the international circumstances.";

const EOL: Element = {
  type: "element",
  tagName: "span",
  properties: { className: ["reader-eol"], ariaHidden: "true" },
  children: [],
};
const HYPHEN: Element = {
  type: "element",
  tagName: "span",
  properties: { className: ["reader-hyphen"], ariaHidden: "true" },
  children: [],
};
const isEol = (node: ElementContent | undefined) =>
  isElement(node) && String(node.properties.className) === "reader-eol";
const count = (nodes: ReadonlyArray<ElementContent>, marker: Element): number =>
  nodes.reduce(
    (total, node) =>
      total +
      (isElement(node)
        ? Number(String(node.properties.className) === String(marker.properties.className)) +
          count(node.children, marker)
        : 0),
    0,
  );

describe("readerLineNodes", () => {
  it("ends every line but the last with a marker and reads back as the source prose", () => {
    const { flow, lines, nodes } = setParagraph([text(PROSE)]);
    expect(lines.length).toBeGreaterThan(2);
    expect(count(nodes, EOL)).toBe(lines.length - 1);
    expect(nodes.at(-1)).toMatchObject({ properties: { className: ["reader-lat"] } });
    expect(readerLinesText(nodes, flow)).toBe(PROSE);
  });

  it.each<[string, Array<ElementContent>, number]>([
    [
      "mixed wrappers",
      [
        text("A "),
        element("em", [text("soft, long emphasis that wraps")]),
        text(" and "),
        element("strong", [element("code", [text("some.code(call)")])]),
        text(" then the end of it all."),
      ],
      180,
    ],
    [
      "hard breaks",
      [
        text("first line  "),
        element("br"),
        text("\nsecond "),
        element("br"),
        element("br"),
        text("fourth"),
      ],
      400,
    ],
    ["a trailing hard break", [text("only line"), element("br"), text("\n")], 400],
    [
      "hyphenated words",
      [text("internationalization considerations notwithstanding representation")],
      110,
    ],
    [
      "an atom between words",
      [text("Energy is "), element("math"), text(" , as is well known to everyone.")],
      150,
    ],
    [
      "Han and Latin",
      [text("中文与 English 混排，这是一个很长的句子需要换行，“引号”也要处理。结束。")],
      200,
    ],
    ["a narrow column", [text(PROSE)], 60],
  ])("copies as the source for %s", (_name, children, width) => {
    const { flow, nodes } = setParagraph(children, { width });
    expect(readerLinesText(nodes, flow)).toBe(readerFlowText(flow.runs));
  });

  it("keeps a wrapper that crosses lines in one piece, with the line ends inside it", () => {
    const link = element("a", [text(PROSE)], { href: "/target", id: "ref" });
    const code = element("code", [text("a/long/path/to/some/file.ts and/another/path.ts")]);
    const { lines, nodes } = setParagraph([text("See "), link, text(" or "), code, text(".")], {
      width: 240,
    });
    const [copy, ...others] = elements(nodes, "a");
    expect(others).toEqual([]);
    expect(copy).not.toBe(link);
    expect(copy?.properties).toBe(link.properties);
    expect(link.children).toEqual([text(PROSE)]);
    expect(elements(nodes, "code")).toHaveLength(1);
    expect(count(nodes, EOL)).toBe(lines.length - 1);
    expect(count(copy?.children ?? [], EOL)).toBeGreaterThan(1);
    // The line that ends where the link ends breaks outside it.
    expect(isEol(copy?.children.at(-1))).toBe(false);
  });

  it("ends a line at a hard break with the break itself", () => {
    const first = element("br");
    const second = element("br");
    const { lines, nodes } = setParagraph([text("one "), first, second, text("\nthree")]);
    expect(lines).toHaveLength(3);
    expect(nodes).toEqual([latin("one"), first, second, latin("three")]);
  });

  it("draws a hyphen as an empty span in the font of the broken word", () => {
    const { lines, nodes } = setParagraph(
      [element("em", [text("internationalization considerations notwithstanding")])],
      { width: 110 },
    );
    expect(lines.filter((line) => line.hyphen !== undefined).length).toBeGreaterThan(0);
    const [wrapper] = elements(nodes, "em");
    const at = wrapper?.children.findIndex((child) => isEol(child)) ?? -1;
    expect(lines[0]?.hyphen).toBeDefined();
    expect(wrapper?.children[at - 1]).toEqual(HYPHEN);
    expect(count(nodes, HYPHEN)).toBe(lines.filter((line) => line.hyphen !== undefined).length);
  });

  it("places each piece with the spacing the engine computed", () => {
    const { lines, nodes } = setParagraph([text(PROSE)]);
    const index = lines.findIndex((line) => line.ratio !== 0 && line.hyphen === undefined);
    const [words, breakSpace] = lines[index]?.pieces ?? [];
    // Every line before it is one piece, its break space or hyphen, and the line end.
    const [piece, space, end] = nodes.slice(index * 3);
    expect(piece).toMatchObject({
      tagName: "span",
      properties: { style: `word-spacing:${px(words?.kind === "text" ? words.wordSpacing : 0)}` },
    });
    expect(breakSpace).toMatchObject({ text: " ", advance: 0 });
    expect(space).toMatchObject({
      properties: { style: "word-spacing:-4px;white-space:pre" },
      children: [text(" ")],
    });
    expect(end).toEqual(EOL);
  });

  it("takes the letter spacing CSS adds after the last character back out of the margin", () => {
    const { lines, nodes } = setParagraph(
      [text("这是一个很长的中文句子需要换行并且两端对齐排版才可以")],
      { width: 330 },
    );
    const piece = lines[0]?.pieces[0];
    const spacing = piece?.kind === "text" ? piece.letterSpacing : 0;
    expect(spacing).not.toBe(0);
    expect(nodes[0]).toMatchObject({
      properties: { style: `letter-spacing:${px(spacing)};margin-right:${px(-spacing)}` },
    });
  });

  it("indents the first line and keeps out-of-flow elements outside the text", () => {
    const checkbox = element("input");
    const aside = element("aside", [text("↩")]);
    const { flow, nodes } = setParagraph([checkbox, text(` ${PROSE} `), aside], {
      firstLineIndent: 32,
    });
    expect(nodes[0]).toBe(checkbox);
    expect(nodes[1]).toEqual({
      type: "element",
      tagName: "span",
      properties: { style: "margin-left:32px" },
      children: [],
    });
    expect(nodes.at(-1)).toBe(aside);
    expect(readerLinesText(nodes, flow)).toBe(PROSE);
  });

  it("wraps an atom with its run index so its width can be measured again", () => {
    const math = element("math", [text("E=mc^2")]);
    const { nodes } = setParagraph([text("Energy "), math, text(" known.")]);
    expect(nodes[1]).toMatchObject({
      tagName: "span",
      properties: { className: ["reader-atom"], dataReaderAtom: "1" },
      children: [math],
    });
  });
});

describe("readerLineDecorations", () => {
  const spansOf = (nodes: ReadonlyArray<ElementContent>): Array<[string, string]> =>
    nodes.flatMap((node): Array<[string, string]> => {
      if (!isElement(node)) return [];
      const className = String(node.properties.className ?? "");
      if (className === "reader-lat" || className === "reader-han") {
        return [[className, String(node.properties.style ?? "")]];
      }
      return spansOf(node.children);
    });

  it.each<[string, Array<ElementContent>, Partial<TypesetOptions>]>([
    ["prose", [text(PROSE)], {}],
    [
      "mixed wrappers",
      [
        text("A "),
        element("em", [text("soft, long emphasis that wraps")]),
        text(" and "),
        element("strong", [element("code", [text("some.code(call)")])]),
        text(" then the end of it all."),
      ],
      { width: 180 },
    ],
    [
      "hard breaks",
      [text("first line  "), element("br"), text("\nsecond "), element("br"), text("third")],
      {},
    ],
    [
      "hyphenated words",
      [text("internationalization considerations notwithstanding representation")],
      { width: 110 },
    ],
    [
      "Han and Latin",
      [text("中文与 English 混排，这是一个很长的句子需要换行，“引号”也要处理。结束。")],
      { width: 200 },
    ],
    ["an indent", [text(PROSE)], { firstLineIndent: 32 }],
  ])(
    "styles the same spans and line ends as readerLineNodes for %s",
    (_name, children, options) => {
      const { flow, lines, nodes } = setParagraph(children, options);
      const decorations = readerLineDecorations(lines, flow.runs);
      const spans = decorations.flatMap((decoration): Array<[string, string]> =>
        decoration.kind === "span" ? [[decoration.className, decoration.style]] : [],
      );
      expect(spans).toEqual(spansOf(nodes));
      const kinds = (kind: string) => decorations.filter((decoration) => decoration.kind === kind);
      expect(kinds("eol")).toHaveLength(count(nodes, EOL));
      expect(kinds("hyphen")).toHaveLength(count(nodes, HYPHEN));
      expect(kinds("indent")).toHaveLength(options.firstLineIndent ? 1 : 0);
      // The spans cover each run's text in order, so every source character is placed.
      for (const decoration of decorations) {
        if (decoration.kind !== "span") continue;
        const run = flow.runs[decoration.run];
        expect(run?.kind === "text" && decoration.end <= run.text.length).toBe(true);
      }
    },
  );
});
