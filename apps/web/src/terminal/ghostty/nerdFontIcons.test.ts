import { describe, expect, it } from "vite-plus/test";

import { isNerdFontIcon, nerdFontIconBox, nerdFontIconSpan } from "./nerdFontIcons";

const row = (...texts: string[]) => texts.map((text) => ({ text }));

describe("nerdFontIconSpan", () => {
  it.each([
    ["an icon before a blank cell", row("\uf179", "", "a"), 0, 2],
    ["an icon before a space", row("\uf179", " ", "a"), 0, 2],
    ["a supplementary icon before a space", row("\u{f033e}", " "), 0, 2],
    ["an icon before text", row("\uf179", "a"), 0, 1],
    ["an icon in the last column", row("a", "\uf179"), 1, 1],
    ["an icon after another icon", row("\uf179", "\uf015", " "), 1, 1],
    ["an icon after a Powerline separator", row("\ue0b0", "\uf015", " "), 1, 2],
  ])("gives %s its own span", (_name, cells, index, span) => {
    expect(nerdFontIconSpan(cells, index)).toBe(span);
  });

  it("leaves Powerline separators and ordinary text alone", () => {
    expect(isNerdFontIcon("\ue0b0")).toBe(false);
    expect(isNerdFontIcon("a")).toBe(false);
    expect(isNerdFontIcon("\uf179")).toBe(true);
  });
});

describe("nerdFontIconBox", () => {
  // A 7.8 by 17 cell with a 9.75 cap height, as Maple Mono NF CN measures at 13px.
  const cell = { cellWidth: 7.8, cellHeight: 17, capHeight: 9.75 };

  it("keeps a wide icon at its own size and left-aligned when the next cell is free", () => {
    const box = nerdFontIconBox({ ...cell, glyphWidth: 13.53, glyphHeight: 12.01, span: 2 });
    expect(box.scale).toBe(1);
    expect(box.x).toBe(0);
  });

  it("shrinks a wide icon into one cell when text follows", () => {
    const box = nerdFontIconBox({ ...cell, glyphWidth: 13.53, glyphHeight: 12.01, span: 1 });
    expect(box.scale * 13.53).toBeCloseTo(7.8);
    expect(box.x).toBeCloseTo(0);
  });

  it("grows a small icon to the one-cell icon height, centred in the first cell", () => {
    const box = nerdFontIconBox({ ...cell, glyphWidth: 3, glyphHeight: 6, span: 2 });
    const iconHeight = (2 * 9.75 + 17) / 3;
    expect(box.scale * 6).toBeCloseTo(iconHeight);
    expect(box.x).toBeCloseTo((7.8 - 3 * box.scale) / 2);
    expect(box.y).toBeCloseTo((17 - iconHeight) / 2);
  });
});
