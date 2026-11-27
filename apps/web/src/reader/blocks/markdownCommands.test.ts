import { expect, it } from "vite-plus/test";
import {
  applyParagraphCommand,
  applyInlineFormat,
  continueOnEnter,
  indentLines,
  tableEdit,
  type CommandResult,
  type ParagraphCommand,
} from "./markdownCommands";

const all = (text: string) => ({ start: 0, end: text.length });
function success(result: CommandResult) {
  if ("refused" in result) throw Error(result.refused);
  return result;
}
const paragraph = (text: string, command: ParagraphCommand) =>
  success(applyParagraphCommand(text, all(text), command)).text;

it("changes heading levels and strips stacked markers on selected lines", () => {
  expect(paragraph("中文😀", { kind: "heading", level: 6 })).toBe("###### 中文😀");
  expect(paragraph("## 中文", "promote")).toBe("# 中文");
  expect(paragraph("# 中文", "demote")).toBe("## 中文");
  expect(paragraph("> - [x] # 中文\r\n## 二", { kind: "paragraph" })).toBe("中文\r\n二");
  expect(applyParagraphCommand("plain", all("plain"), "promote")).toHaveProperty("refused");
  expect(
    applyParagraphCommand("```\ncode\n```", { start: 4, end: 4 }, { kind: "heading", level: 2 }),
  ).toHaveProperty("refused");
});
it.each([
  ["quote", "> 一\r\n> 二"],
  ["orderedList", "1. 一\r\n2. 二"],
  ["bulletList", "- 一\r\n- 二"],
  ["taskList", "- [ ] 一\r\n- [ ] 二"],
] as const)("toggles %s on and off without changing CRLF", (kind, expected) => {
  expect(paragraph("一\r\n二", kind)).toBe(expected);
  expect(paragraph(expected, kind)).toBe("一\r\n二");
  const partial = "一\r\n二";
  expect(success(applyParagraphCommand(partial, { start: 0, end: 3 }, kind)).text).toBe(
    expected.split("\r\n")[0] + "\r\n二",
  );
});
it("wraps selected lines in fences and inserts standalone blocks", () => {
  expect(paragraph("😀\r\n中", "codeFence")).toBe("```\r\n😀\r\n中\r\n```");
  expect(paragraph("x", "mathBlock")).toBe("$$\nx\n$$");
  expect(paragraph("", "toc")).toBe("[toc]");
  expect(paragraph("", "rule")).toBe("---");
  expect(
    paragraph("", "table")
      .split("\n")
      .map((row) => row.split("|").length - 2),
  ).toEqual([3, 3, 3]);
  expect(applyParagraphCommand("x", all("x"), "frontMatter")).toHaveProperty("refused");
  expect(
    success(applyParagraphCommand("x", all("x"), "frontMatter", { isFirstBlock: true })).text,
  ).toBe("---\n\n---\n\nx");
  expect(paragraph("x", "paragraphBefore")).toBe("\n\nx");
  expect(paragraph("x", "paragraphAfter")).toBe("x\n\n");
});
it.each([
  ["strong", "**", "**"],
  ["emphasis", "*", "*"],
  ["underline", "<u>", "</u>"],
  ["code", "`", "`"],
  ["strike", "~~", "~~"],
  ["link", "[", "](url)"],
  ["image", "![", "](url)"],
] as const)("wraps, unwraps and creates an empty %s pair", (format, open, close) => {
  const result = success(applyInlineFormat("中文😀", all("中文😀"), format));
  expect(result).toEqual({
    text: open + "中文😀" + close,
    selection: { start: open.length, end: open.length + 4 },
  });
  expect(success(applyInlineFormat(result.text, result.selection, format))).toEqual({
    text: "中文😀",
    selection: all("中文😀"),
  });
  expect(success(applyInlineFormat(result.text, all(result.text), format)).text).toBe("中文😀");
  expect(applyInlineFormat("", all(""), format)).toEqual({
    text: open + close,
    selection: { start: open.length, end: open.length },
  });
});
it("clears mixed formatting, preserves literals, and chooses a safe code delimiter", () => {
  const text = "**一** / <u>[二](path)</u> / a_b";
  expect(success(applyInlineFormat(text, all(text), "clear")).text).toBe("一 / 二 / a_b");
  const code = success(applyInlineFormat("a`b", all("a`b"), "code"));
  expect(code.text).toBe("``a`b``");
  expect(success(applyInlineFormat(code.text, code.selection, "code")).text).toBe("a`b");
});
it("continues and exits nested lists, tasks and quotes", () => {
  for (const [before, after] of [
    ["- item", "- item\n- "],
    ["  9) 中", "  9) 中\n  10) "],
    ["> - [x] ☑", "> - [x] ☑\n> - [ ] "],
    ["- a\r\n  - b", "- a\r\n  - b\r\n  - "],
    ["> > q", "> > q\n> > "],
    ["> - ", "> "],
    ["- [ ] ", ""],
    ["> ", ""],
  ])
    expect(continueOnEnter(before!, before!.length)?.text).toBe(after);
  expect(continueOnEnter("plain", 3)).toBeNull();
});
it("indents and outdents by the marker width across nested items", () => {
  const list = "10. 一\r\n    - 二";
  const indented = success(indentLines(list, all(list), 1));
  expect(indented.text).toBe("    10. 一\r\n        - 二");
  expect(success(indentLines(indented.text, all(indented.text), -1)).text).toBe(list);
  expect(indentLines("a", all("a"), 1)).toHaveProperty("refused");
});

const table = "| A   | B   |\r\n| --- | --- |\r\n| 一   | 二   |";
it("edits table rows including its header and retains the delimiter", () => {
  const blank = "|     |     |";
  expect(success(tableEdit(table, 0, "rowAbove")).text).toBe(
    [blank, table.split("\r\n")[1], table.split("\r\n")[0], table.split("\r\n")[2]].join("\r\n"),
  );
  expect(success(tableEdit(table, table.length, "rowBelow")).text).toBe(table + "\r\n" + blank);
  expect(success(tableEdit(table, 0, "deleteRow")).text).toBe("| 一   | 二   |\r\n| --- | --- |");
  expect(tableEdit(table, table.indexOf("---"), "deleteRow")).toHaveProperty("refused");
});
it("adds, removes, and aligns table columns without rewriting neighboring cells", () => {
  const unaligned = "|A| B   |\n|---| --- |\n|a\\|b|x|";
  expect(success(tableEdit(unaligned, 1, "columnLeft")).text).toBe(
    "|   |A| B   |\n|---|---| --- |\n|   |a\\|b|x|",
  );
  expect(success(tableEdit(unaligned, 1, "columnRight")).text).toBe(
    "|A|   | B   |\n|---|---| --- |\n|a\\|b|   |x|",
  );
  expect(success(tableEdit(unaligned, unaligned.indexOf("x"), "deleteColumn")).text).toBe(
    "|A|\n|---|\n|a\\|b|",
  );
  for (const [op, marker] of [
    ["alignLeft", ":--"],
    ["alignCenter", ":-:"],
    ["alignRight", "--:"],
  ] as const)
    expect(success(tableEdit(unaligned, 1, op)).text).toBe(unaligned.replace("---", marker));
  const mixed = "|A|B|\r\n|-|-|\n|x|y|";
  expect(success(tableEdit(mixed, 1, "alignRight")).text).toBe("|A |B|\r\n|-:|-|\n|x |y|");
  expect(tableEdit("|A|\n|-|", 1, "deleteColumn")).toHaveProperty("refused");
});
