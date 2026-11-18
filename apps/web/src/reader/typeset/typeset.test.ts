import { describe, expect, it } from "vite-plus/test";
import { body, code, createFakeMeasurer } from "./fakeMeasurer";
import type { InlineRun } from "./items";
import { typesetParagraph, type TypesetLine, type TypesetOptions } from "./typeset";

const HAN = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜";
const ENGLISH =
  "The typographical considerations of international publishing already require appealing " +
  "penalties, considers the reader; and the tide ran out past the dark rock, as the sand lay wet.";
const MIXED =
  "他说：“你好。”然后（回头）看了看 Hello 世界，这是一个用来测试中文排版效果的段落；" +
  "包括标点挤压、悬挂和 hyphenation 的处理。「引号」《书名》都不能出现在行尾或者行首。";

const set = (runs: ReadonlyArray<InlineRun>, options: Partial<TypesetOptions> = {}) =>
  typesetParagraph(runs, { width: 320, em: 16, ...options }, createFakeMeasurer());

const textOf = (line: TypesetLine) =>
  line.pieces.map((piece) => (piece.kind === "text" ? piece.text : "\ufffc")).join("");
const han = (count: number) => HAN.slice(0, count);

describe("typesetParagraph", () => {
  it("justifies every line but the last to the column width", () => {
    const { lines, isJustified } = set([body(ENGLISH)]);
    expect(isJustified).toBe(true);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines.slice(0, -1)) expect(line.width).toBeCloseTo(320 + line.hang, 6);
    const last = lines.at(-1)!;
    expect(last.ratio).toBe(0);
    expect(last.width).toBe(last.naturalWidth);
    expect(last.width).toBeLessThan(320);
  });

  it("returns pieces whose advances and margins add up to the line width", () => {
    for (const runs of [
      [body(ENGLISH)],
      [body(MIXED)],
      [body(HAN), code("fooBar(国)"), body(HAN)],
    ]) {
      for (const line of set(runs).lines) {
        const total = line.pieces.reduce(
          (sum, piece) => sum + piece.marginLeft + piece.advance + piece.marginRight,
          line.hyphen?.advance ?? 0,
        );
        expect(total).toBeCloseTo(line.width, 6);
      }
    }
  });

  it("keeps the source text, with the space a line was broken at as a zero-width piece", () => {
    const { lines } = set([body(ENGLISH)]);
    expect(lines.map(textOf).join("")).toBe(ENGLISH);
    const broken = lines.find((line) => line.hyphen === undefined && line !== lines.at(-1))!;
    expect(broken.pieces.at(-1)).toMatchObject({ kind: "text", text: " ", advance: 0 });
  });

  it("sets word spaces as one word-spacing value per piece", () => {
    const [first] = set([body(ENGLISH)]).lines;
    const [piece] = first!.pieces;
    expect(first!.pieces).toHaveLength(first!.hyphen === undefined ? 2 : 1);
    expect(piece).toMatchObject({ kind: "text", marginLeft: 0, marginRight: 0, letterSpacing: 0 });
    const spaces = textOf(first!).trimEnd().split(" ").length - 1;
    const stretch = first!.ratio > 0 ? 2 : 4 / 3;
    expect(piece?.kind === "text" && piece.wordSpacing).toBeCloseTo(first!.ratio * stretch, 6);
    expect(first!.width - first!.naturalWidth).toBeCloseTo(spaces * first!.ratio * stretch, 6);
  });

  it("sets Han gaps as letter spacing between characters", () => {
    const [first] = set([body(han(41))], { width: 326 }).lines;
    expect(first!.pieces).toEqual([
      expect.objectContaining({ text: han(20), letterSpacing: 6 / 19, advance: 326 }),
    ]);
    expect(first!.ratio).toBeCloseTo(6 / (19 * 0.8), 6);
  });

  it("inserts a hyphen only where a word was divided", () => {
    const { lines } = set([body(ENGLISH)], { width: 330 });
    const hyphenated = lines.filter((line) => line.hyphen !== undefined);
    expect(hyphenated.length).toBeGreaterThan(0);
    for (const line of hyphenated) {
      expect(line.hyphen).toEqual({ run: 0, advance: 4 });
      expect(textOf(line)).toMatch(/[a-z]$/u);
      expect(line.hang).toBe(0);
    }
    expect(lines.map(textOf).join("")).toBe(ENGLISH);
  });

  describe("hanging punctuation", () => {
    it.each([
      ["，", 8],
      ["。", 8],
      ["、", 8],
      ["；", 4],
      ["：", 4],
      ["？", 4],
      ["！", 4],
      ["）", 4],
      ["」", 4],
      ["］", 0],
    ])("%s at a line end protrudes by %d px", (mark, hang) => {
      const [first] = set([body(`${han(20)}${mark}${han(8)}`)]).lines;
      expect(textOf(first!)).toBe(`${han(20)}${mark}`);
      expect(first!.hang).toBe(hang);
      expect(first!.width).toBeCloseTo(320 + hang, 6);
      expect(first!.pieces.at(-1)).toMatchObject({ text: mark, advance: 16, marginRight: -8 });
    });

    it("hangs a comma even when it would have fitted", () => {
      const [first] = set([body(`${han(19)}，${han(8)}`)]).lines;
      expect(textOf(first!)).toBe(`${han(19)}，`);
      expect(first!.hang).toBe(8);
      expect(first!.ratio).toBeGreaterThan(0);
      expect(first!.width).toBeCloseTo(328, 6);
    });

    it.each([
      [",", 4],
      [".", 4],
      [";", 2],
      [":", 2],
      ["!", 2],
      ["?", 2],
      [")", 2],
      ["%", 0],
    ])("an ASCII %s at a line end protrudes by %d px", (mark, hang) => {
      const [first] = set([body(`abcd efgh${mark} `.repeat(6))]).lines;
      expect(textOf(first!)).toBe(`abcd efgh${mark} `.repeat(4));
      expect(first!.hang).toBe(hang);
      expect(first!.width).toBeCloseTo(320 + hang, 6);
    });

    it("does not hang on last lines or in unjustified paragraphs", () => {
      const runs = [body(`${han(20)}，${han(8)}。`)];
      expect(set(runs).lines.at(-1)?.hang).toBe(0);
      expect(set(runs, { justify: false }).lines.map((line) => line.hang)).toEqual([0, 0]);
    });
  });

  describe("full-width marks", () => {
    it("sets an opening bracket at half width at the start of a continuation line", () => {
      const [, second] = set([body(`${han(20)}（${han(6)}`)]).lines;
      expect(second!.pieces[0]).toMatchObject({ text: `（${han(6)}`, marginLeft: -8 });
      expect(second!.width).toBe(8 + 6 * 16);
    });

    it("keeps the full cell of an opening bracket at the start of a paragraph", () => {
      const [first] = set([body(`（${han(4)}`)]).lines;
      expect(first!.pieces[0]).toMatchObject({ marginLeft: 0 });
      expect(first!.width).toBe(5 * 16);
    });

    it("sets a closing mark followed by another mark at half width", () => {
      const [line] = set([body("国。」国")]).lines;
      expect(line!.width).toBe(16 + 8 + 16 + 16);
      expect(line!.pieces.map((piece) => piece.marginRight)).toEqual([-8, 0, 0]);
    });

    it("shrinks the blank half of marks before anything else", () => {
      const [first] = set([body(`${"国，".repeat(11)}${han(4)}`)]).lines;
      expect(textOf(first!)).toBe("国，".repeat(11));
      expect(first!.ratio).toBeLessThan(0);
      expect(first!.pieces[0]).toMatchObject({ text: "国，" });
      expect(first!.pieces[0]?.marginRight).toBeCloseTo(-8 + 8 * (1 + first!.ratio), 6);
    });
  });

  it("never starts a line with a closing mark or ends one with an opening mark", () => {
    for (let width = 320; width <= 640; width += 8) {
      const { lines } = set([body(MIXED)], { width });
      for (const line of lines) {
        const text = textOf(line).trimEnd();
        expect(text).not.toMatch(/^[，。、；：？！）」》”’…%]/u);
        expect(text).not.toMatch(/[（「《“‘(]$/u);
      }
      expect(lines.map(textOf).join("")).toBe(MIXED);
    }
  });

  describe("unjustified paragraphs", () => {
    it.each([
      ["a column of 20 em", { width: 320 }, true],
      ["a column just under 20 em", { width: 319 }, false],
      ["a larger body size in the same column", { width: 320, em: 17 }, false],
      ["justify: false", { justify: false }, false],
    ])("%s", (_name, options: Partial<TypesetOptions>, justified) => {
      const { lines, isJustified } = set([body(ENGLISH)], options);
      expect(isJustified).toBe(justified);
      if (justified) return;
      for (const line of lines) {
        expect(line.ratio).toBe(0);
        expect(line.width).toBe(line.naturalWidth);
        expect(line.width).toBeLessThanOrEqual(options.width ?? 320);
      }
      expect(lines.some((line) => line.hyphen !== undefined)).toBe(true);
    });

    it("stops justifying when inline code is 45% of the text or more", () => {
      const prose = "The tide ran out past the dark rock and sand. ";
      const snippet = (length: number) => code("abc ".repeat(length / 4));
      expect(set([body(prose), snippet(36)]).isJustified).toBe(true);
      expect(set([body(prose), snippet(40)]).isJustified).toBe(false);
    });
  });

  it("places atoms with the Han to Latin gap as margins", () => {
    const [line] = set([body("国"), { kind: "atom", advance: 30 }, body("国")]).lines;
    expect(line!.pieces).toEqual([
      expect.objectContaining({ kind: "text", run: 0, marginRight: 4 }),
      { kind: "atom", run: 1, advance: 30, marginLeft: 0, marginRight: 4 },
      expect.objectContaining({ kind: "text", run: 2, marginLeft: 0 }),
    ]);
    expect(line!.width).toBe(16 + 4 + 30 + 4 + 16);
  });

  it("maps pieces back to their run and source range", () => {
    const runs = [body("The tide "), code("ranOut()"), body(" past  the rock")];
    const [line] = set(runs).lines;
    expect(
      line!.pieces.map(
        (piece) => piece.kind === "text" && [piece.run, piece.start, piece.end, piece.text],
      ),
    ).toEqual([
      [0, 0, 9, "The tide "],
      [1, 0, 8, "ranOut()"],
      [2, 0, 15, " past the rock"],
    ]);
  });

  it("indents the first line only", () => {
    const { lines } = set([body(han(40))], { firstLineIndent: 32 });
    expect(lines.map((line) => [line.indent, textOf(line).length])).toEqual([
      [32, 18],
      [0, 20],
      [0, 2],
    ]);
  });

  it("sets the line before a hard break at natural width", () => {
    const { lines } = set([body("The tide"), { kind: "break" }, body(ENGLISH)]);
    expect(lines[0]).toMatchObject({ ratio: 0, width: 60, hang: 0 });
    expect(textOf(lines[1]!)).toMatch(/^The typo/u);
  });

  describe("text that cannot be broken well", () => {
    it("breaks a long unbreakable run between characters without a hyphen and tracks it", () => {
      const digits = "0123456789".repeat(5);
      const { lines } = set([body(digits)], { width: 330 });
      expect(lines.map((line) => [textOf(line), line.hyphen])).toEqual([
        [digits.slice(0, 41), undefined],
        [digits.slice(41), undefined],
      ]);
      expect(lines[0]!.pieces).toEqual([
        expect.objectContaining({ letterSpacing: 2 / 40, advance: 330 }),
      ]);
    });

    it.each([
      ["a column narrower than one character", 5],
      ["a zero-width column", 0],
      ["a negative width", -40],
      ["a width that is not a number", Number.NaN],
    ])("still returns every character in %s", (_name, width) => {
      const { lines } = set([body(MIXED), { kind: "atom", advance: 50 }, body(ENGLISH)], { width });
      expect(lines.map(textOf).join("")).toBe(`${MIXED}\ufffc${ENGLISH}`);
    });

    it("lets a box wider than the column overflow on its own line", () => {
      const { lines } = set([body("ab "), { kind: "atom", advance: 500 }, body(" cd")]);
      expect(lines.map(textOf)).toEqual(["ab ", "\ufffc ", "cd"]);
      expect(lines[1]!.width).toBe(500);
    });
  });

  it("handles empty input", () => {
    expect(set([]).lines).toEqual([]);
    expect(set([body("  \n ")]).lines).toEqual([]);
  });

  it("reuses the result for unchanged content and options", () => {
    const measurer = createFakeMeasurer();
    const options = { width: 320, em: 16 };
    const first = typesetParagraph([body(ENGLISH)], options, measurer);
    expect(typesetParagraph([body(ENGLISH)], { ...options }, measurer)).toBe(first);
    expect(typesetParagraph([body(ENGLISH)], { ...options, width: 400 }, measurer)).not.toBe(first);
    expect(typesetParagraph([body(`${ENGLISH} `)], options, measurer)).not.toBe(first);
  });
});
