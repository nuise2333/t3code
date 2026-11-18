import type { Element, ElementContent, Root, RootContent } from "hast";
import { describe, expect, it } from "vite-plus/test";

import {
  collectReaderFlow,
  readerFlowText,
  type InlineStyle,
  type InlineView,
} from "../readerFlow";
import { readerLineNodes } from "../readerLines";
import { typesetParagraph } from "../typeset";
import { createFakeMeasurer } from "../typeset/fakeMeasurer";
import {
  findInReaderChunk,
  indexReaderFindText,
  readerFindQuery,
  type ReaderFindMatch,
  type ReaderFindView,
} from "./readerFindIndex";

type HastNode = Root | RootContent;

const text = (value: string): ElementContent => ({ type: "text", value });
const element = (
  tagName: string,
  children: Array<ElementContent> = [],
  properties: Element["properties"] = {},
): Element => ({ type: "element", tagName, properties, children });
const root = (...children: Array<ElementContent>): Root => ({ type: "root", children });

const view: ReaderFindView<HastNode> = {
  children: (node) => ("children" in node ? node.children : []),
  text: (node) => (node.type === "text" ? node.value : undefined),
  tagName: (node) => (node.type === "element" ? node.tagName : undefined),
  isSkipped: (node) => node.type === "element" && node.properties.dataSkip !== undefined,
};

const BODY: InlineStyle = { font: "16px body", fontSize: 16, isItalic: false };

/** A paragraph as the reader draws it: engine lines with hyphen and line-end markers. */
function typesetParagraphNode(children: Array<ElementContent>, width: number) {
  const inline: InlineView<ElementContent | Element> = {
    children: (parent) => ("children" in parent ? parent.children : []),
    text: (node) => (node.type === "text" ? node.value : undefined),
    box: () => ({ kind: "wrapper", style: BODY }),
  };
  const flow = collectReaderFlow(children, element("p", children), BODY, inline);
  if (flow === null) throw new Error("the paragraph cannot be set");
  const { lines } = typesetParagraph(flow.runs, { width, em: 16 }, createFakeMeasurer());
  return { flow, lines, paragraph: element("p", readerLineNodes(lines, flow)) };
}

/** The text a match covers, read from the nodes it starts and ends in. */
function matchedText(tree: HastNode, match: ReaderFindMatch<HastNode>): string {
  let out = "";
  let inside = false;
  const walk = (node: HastNode) => {
    if (node.type === "text") {
      const from = node === match.start.node ? match.start.offset : 0;
      if (node === match.start.node) inside = true;
      if (!inside) return;
      const to = node === match.end.node ? match.end.offset : node.value.length;
      out += node.value.slice(from, to);
      if (node === match.end.node) inside = false;
      return;
    }
    for (const child of Array.from(view.children(node))) walk(child);
  };
  walk(tree);
  return out;
}

function search(tree: HastNode, query: string) {
  const index = indexReaderFindText(tree, view);
  return index.chunks.flatMap((chunk) => findInReaderChunk(chunk, readerFindQuery(query)));
}

describe("indexReaderFindText", () => {
  it("reads a typeset paragraph as its copied text, so a word broken by a hyphen is found", () => {
    const words = "internationalization considerations notwithstanding representation";
    const { flow, lines, paragraph } = typesetParagraphNode([text(words)], 110);
    expect(lines.some((line) => line.hyphen !== undefined)).toBe(true);
    const tree = root(paragraph);

    const [chunk] = indexReaderFindText(tree, view).chunks;
    expect(chunk?.text).toBe(readerFlowText(flow.runs));

    const broken = lines.findIndex((line) => line.hyphen !== undefined);
    const piece = lines[broken]?.pieces.at(-1);
    const head = piece?.kind === "text" ? (piece.text.split(" ").at(-1) ?? "") : "";
    const word = words.split(" ").find((candidate) => candidate.startsWith(head)) ?? "";
    expect(word.length).toBeGreaterThan(head.length);

    const matches = search(tree, word.toUpperCase());
    expect(matches).toHaveLength(1);
    const [match] = matches;
    if (match === undefined) throw new Error("no match");
    expect(match.start.node).not.toBe(match.end.node);
    expect(matchedText(tree, match)).toBe(word);
  });

  it("finds a phrase across lines, wrappers and collapsed white space", () => {
    const children = [
      text("A long "),
      element("em", [text("emphasised\n   phrase")]),
      text(" that wraps around the narrow column several times over."),
    ];
    const { paragraph } = typesetParagraphNode(children, 90);
    for (const tree of [root(element("p", children)), root(paragraph)]) {
      const matches = search(tree, "Emphasised phrase that");
      expect(matches.map((match) => matchedText(tree, match).replace(/\s+/g, " "))).toEqual([
        "emphasised phrase that",
      ]);
    }
  });

  it("keeps blocks apart, skips marked elements and keeps code white space", () => {
    const code = element("pre", [element("code", [text("a  needle\nhay")])]);
    const tree = root(
      element("p", [text("ends with needle")]),
      element("p", [text("hay")]),
      element("div", [element("span", [text("label needle")], { dataSkip: "" }), code]),
    );
    expect(indexReaderFindText(tree, view).chunks.map((chunk) => chunk.text)).toEqual([
      "ends with needle",
      "hay",
      "a  needle\nhay",
    ]);
    expect(search(tree, "needle hay")).toEqual([]);
    expect(search(tree, "needle")).toHaveLength(2);
    expect(search(tree, "a  needle")).toHaveLength(1);
    // A code block indexed again on its own, as after it changes, keeps its spacing too.
    expect(indexReaderFindText(code, view).chunks.map((chunk) => chunk.text)).toEqual([
      "a  needle\nhay",
    ]);
  });

  it("marks only blocks without nested blocks as leaves", () => {
    const paragraph = element("p", [text("inner")]);
    const item = element("li", [text("item "), paragraph]);
    const { leaves } = indexReaderFindText(root(element("ul", [item])), view);
    expect([...leaves]).toEqual([paragraph]);
  });
});

describe("readerFindQuery", () => {
  it.each([
    ["", ""],
    ["   ", ""],
    ["trailing ", "trailing "],
  ])("normalises %j", (query, expected) => {
    expect(readerFindQuery(query)).toBe(expected);
  });
});
