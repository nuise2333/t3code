import { describe, expect, it } from "vite-plus/test";

import { renderedHitOffset } from "./rawBlockCaret";

const TABLE = "| Name | Value |\n| --- | :-: |\n| a \\| b | two words |\n| 1 | 1 |\n";

describe("renderedHitOffset", () => {
  it.each([
    [{ row: 0, column: 1 }, "Value", 2, TABLE.indexOf("Value") + 2],
    [{ row: 1, column: 0 }, "a | b", 0, TABLE.indexOf("a \\|")],
    [{ row: 1, column: 1 }, "two words", 4, TABLE.indexOf("two words") + 4],
    // The same text in another cell does not matter.
    [{ row: 2, column: 1 }, "1", 1, TABLE.lastIndexOf("1") + 1],
    // Text that is not in the cell's source as rendered: the cell's start.
    [{ row: 1, column: 1 }, "rendered", 3, TABLE.indexOf("two words")],
  ])("puts a click in table cell %j at its text", (cell, text, offset, expected) => {
    expect(renderedHitOffset(TABLE, { cell, text, offset })).toBe(expected);
  });

  it("finds other clicked text only where it occurs once", () => {
    const html = "<div>\n  <p>Hello there</p>\n  <p>again</p><p>again</p>\n</div>";
    expect(renderedHitOffset(html, { text: "Hello there", offset: 3 })).toBe(
      html.indexOf("Hello") + 3,
    );
    expect(renderedHitOffset(html, { text: "again", offset: 1 })).toBeNull();
    expect(renderedHitOffset(TABLE, { cell: { row: 9, column: 0 }, text: "", offset: 0 })).toBe(
      null,
    );
  });
});
