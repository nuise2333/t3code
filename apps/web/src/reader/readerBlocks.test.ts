import { describe, expect, it } from "vite-plus/test";

import { isReaderFigureParagraph, readerCodeLanguageLabel } from "./readerBlocks";

const text = (value: string) => ({ type: "text", value });
const element = (tagName: string, children: ReadonlyArray<object> = []) => ({
  type: "element",
  tagName,
  children,
});

describe("readerCodeLanguageLabel", () => {
  it.each([
    [undefined, null],
    ["chat-markdown-code", null],
    ["language-python", "Python"],
    ["language-PYTHON", "Python"],
    ["language-{.python}", "Python"],
    ["hljs language-sh", "bash"],
    ["language-c++", "C++"],
    ["language-text", "text"],
    ["language-FooBar", "FooBar"],
  ])("labels %s as %s", (className, label) => {
    expect(readerCodeLanguageLabel(className)).toBe(label);
  });
});

describe("isReaderFigureParagraph", () => {
  it.each([
    ["one image", [element("img")], true],
    ["images on separate lines", [element("img"), text("\n"), element("br"), element("img")], true],
    ["a linked image", [element("a", [element("img")])], true],
    ["an image in a sentence", [text("See "), element("img")], false],
    ["a text link", [element("a", [text("label")])], false],
    ["line breaks only", [element("br")], false],
    ["nothing", [], false],
  ])("%s", (_name, children, expected) => {
    expect(isReaderFigureParagraph(element("p", children))).toBe(expected);
  });

  it("treats a missing node as text", () => {
    expect(isReaderFigureParagraph(undefined)).toBe(false);
  });
});
