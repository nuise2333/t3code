import type { Element, ElementContent } from "hast";
import { describe, expect, it } from "vite-plus/test";

import {
  collectReaderFlow,
  readerFlowText,
  readerListItemParts,
  type InlineBox,
  type InlineStyle,
  type InlineView,
} from "./readerFlow";

const text = (value: string): ElementContent => ({ type: "text", value });
const element = (tagName: string, children: Array<ElementContent> = []): Element => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

/** A rendered node: text, or an element that is a wrapper unless `box` says otherwise. */
interface Rendered {
  readonly text?: string;
  readonly tag?: string;
  readonly box?: InlineBox;
  readonly children?: ReadonlyArray<Rendered>;
}

const BODY: InlineStyle = { font: "16px body", fontSize: 16, isItalic: false };
const STYLES: Record<string, InlineStyle> = {
  em: { font: "italic 16px body", fontSize: 16, isItalic: true },
  code: { font: "14px code", fontSize: 14, isItalic: false },
};

const view: InlineView<Rendered> = {
  children: (parent) => parent.children ?? [],
  text: (node) => node.text,
  box: (node, tagName) =>
    node.box ??
    (node.tag === tagName
      ? { kind: "wrapper", style: STYLES[tagName] ?? BODY }
      : { kind: "unsupported" }),
};

const t = (value: string): Rendered => ({ text: value });
const el = (tag: string, children: ReadonlyArray<Rendered> = [], box?: InlineBox): Rendered =>
  box === undefined ? { tag, children } : { tag, children, box };
const collect = (nodes: Array<ElementContent>, rendered: ReadonlyArray<Rendered>) =>
  collectReaderFlow(nodes, { children: rendered }, BODY, view);

describe("collectReaderFlow", () => {
  it("reads text with the font of its wrappers and remembers the wrappers around each run", () => {
    const em = element("em", [text("soft "), element("code", [text("x()")])]);
    const link = element("a", [text("a link")]);
    const flow = collect(
      [text("Plain "), em, text(""), link, element("br"), text("\nnext")],
      [
        t("Plain "),
        el("em", [t("soft "), el("code", [t("x()")])]),
        el("a", [t("a link")]),
        el("br"),
        t("\nnext"),
      ],
    );
    expect(flow?.runs).toEqual([
      {
        kind: "text",
        text: "Plain ",
        font: "16px body",
        fontSize: 16,
        isCode: false,
        isItalic: false,
      },
      {
        kind: "text",
        text: "soft ",
        font: "italic 16px body",
        fontSize: 16,
        isCode: false,
        isItalic: true,
      },
      { kind: "text", text: "x()", font: "14px code", fontSize: 14, isCode: true, isItalic: false },
      {
        kind: "text",
        text: "a link",
        font: "16px body",
        fontSize: 16,
        isCode: false,
        isItalic: false,
      },
      { kind: "break" },
      {
        kind: "text",
        text: "\nnext",
        font: "16px body",
        fontSize: 16,
        isCode: false,
        isItalic: false,
      },
    ]);
    expect(flow?.sources.map((source) => source.path.map((wrapper) => wrapper.tagName))).toEqual([
      [],
      ["em"],
      ["em", "code"],
      ["a"],
      [],
      [],
    ]);
    expect(flow?.sources[2]?.path[0]).toBe(em);
    expect(flow?.hasAtoms).toBe(false);
  });

  it("keeps an element the renderer drew as a box in one piece of its measured width", () => {
    const math = element("code", [text("x^2")]);
    const flow = collect(
      [text("Area "), element("strong", [math]), text(".")],
      [t("Area "), el("strong", [el("span", [t("x²")], { kind: "atom", advance: 21.5 })]), t(".")],
    );
    expect(flow?.runs[1]).toEqual({ kind: "atom", advance: 21.5 });
    expect(flow?.sources[1]).toEqual({
      path: [expect.objectContaining({ tagName: "strong" })],
      node: math,
    });
    expect(flow?.hasAtoms).toBe(true);
  });

  it("sets aside out-of-flow elements before and after the text", () => {
    const checkbox = element("input");
    const backLink = element("a", [text("↩")]);
    const outOfFlow: InlineBox = { kind: "outOfFlow" };
    const flow = collect(
      [text("\n"), checkbox, text(" Task text "), backLink, text("\n")],
      [
        t("\n"),
        el("input", [], outOfFlow),
        t(" Task text "),
        el("a", [t("↩")], outOfFlow),
        t("\n"),
      ],
    );
    expect(flow?.lead).toEqual([checkbox]);
    expect(flow?.tail).toEqual([backLink]);
    expect(flow?.runs.map((run) => (run.kind === "text" ? run.text : run.kind))).toEqual([
      "\n",
      " Task text ",
      "\n",
    ]);
  });

  it.each<[string, Array<ElementContent>, ReadonlyArray<Rendered>]>([
    ["text the renderer replaced", [text("use $skill here")], [t("use "), el("span"), t(" here")]],
    ["a rendered node with no source", [text("a")], [t("a"), el("span")]],
    ["a source node that rendered nothing", [text("a"), element("a", [text("b")])], [t("a")]],
    ["an element where text was written", [text("a")], [el("span")]],
    ["an inline element it does not know", [element("kbd", [text("K")])], [el("kbd", [t("K")])]],
    [
      "a wrapper drawn as a block",
      [element("em", [text("a")])],
      [el("em", [t("a")], { kind: "unsupported" })],
    ],
    [
      "an image",
      [element("a", [element("img")])],
      [el("a", [el("img")], { kind: "atom", advance: 10 })],
    ],
    ["right-to-left text", [text("שלום")], [t("שלום")]],
    [
      "an out-of-flow element between words",
      [text("a "), element("input"), text(" b")],
      [t("a "), el("input", [], { kind: "outOfFlow" }), t(" b")],
    ],
    [
      "an out-of-flow element inside a wrapper",
      [element("em", [element("input")])],
      [el("em", [el("input", [], { kind: "outOfFlow" })])],
    ],
    ["raw HTML", [{ type: "raw", value: "<b>" }], [t("<b>")]],
  ])("leaves the paragraph to the browser for %s", (_name, nodes, rendered) => {
    expect(collect(nodes, rendered)).toBeNull();
  });
});

describe("readerFlowText", () => {
  it("collapses white space like the browser, with a newline per hard break", () => {
    expect(
      readerFlowText([
        { kind: "text", text: "  One\n two ", font: "f", fontSize: 16 },
        { kind: "atom", advance: 10 },
        { kind: "text", text: " \t", font: "f", fontSize: 16 },
        { kind: "break" },
        { kind: "break" },
        { kind: "text", text: "\nthree  ", font: "f", fontSize: 16 },
      ]),
    ).toBe("One two \ufffc\n\nthree");
  });
});

describe("readerListItemParts", () => {
  const flow = (start: number, end: number) => ({ start, end, isFlow: true });
  const rest = (start: number, end: number) => ({ start, end, isFlow: false });
  it.each<[string, Array<ElementContent>, ReturnType<typeof flow>[]]>([
    ["a tight item", [text("Item "), element("em", [text("text")])], [flow(0, 2)]],
    [
      "text before a nested list",
      [text("Item "), element("em"), text("\n"), element("ul"), text("\n")],
      [flow(0, 2), rest(2, 3), rest(3, 4), rest(4, 5)],
    ],
    [
      "a loose item",
      [text("\n"), element("p"), text("\n"), element("p"), text("\n")],
      [rest(0, 1), rest(1, 2), rest(2, 3), rest(3, 4), rest(4, 5)],
    ],
    ["text after a block", [element("p"), text("\n tail")], [rest(0, 1), flow(1, 2)]],
    ["a task item", [element("input"), text(" Task")], [rest(0, 1), flow(1, 2)]],
    ["an empty item", [], []],
  ])("splits %s", (_name, children, parts) => {
    expect(readerListItemParts(children)).toEqual(parts);
  });
});
