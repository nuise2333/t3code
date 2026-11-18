import { describe, expect, it } from "vite-plus/test";
import { breakLines, type BreakOptions } from "./breaker";
import { FORBIDDEN_BREAK, FORCED_BREAK, type Item } from "./items";

const box = (width: number): Item => ({
  type: "box",
  width,
  run: 0,
  start: 0,
  end: 0,
  text: "",
  marginLeft: 0,
  marginRight: 0,
  isAtom: false,
  isLetterSpaced: false,
  lastStart: 0,
});
const glue = (width: number, stretch: number, shrink: number): Item => ({
  type: "glue",
  width,
  stretch,
  shrink,
  isLetterGap: false,
  run: -1,
  start: 0,
  end: 0,
});
const penalty = (cost: number, width = 0, flagged = false): Item => ({
  type: "penalty",
  width,
  cost,
  flagged,
});
const space = () => glue(10, 5, 5);

/** Words of the given widths separated by a 10 px space that stretches and shrinks by 5. */
const words = (...widths: ReadonlyArray<number>) =>
  widths.flatMap((width, index) => (index === 0 ? [box(width)] : [space(), box(width)]));

const options = (overrides: Partial<BreakOptions> = {}): BreakOptions => ({
  width: 100,
  firstLineWidth: 100,
  ragged: false,
  raggedStretch: 32,
  tolerance: 10,
  isLastResort: false,
  ...overrides,
});

const ends = (items: ReadonlyArray<Item>, overrides?: Partial<BreakOptions>) =>
  breakLines(items, options(overrides))?.map((line) => [line.start, line.end]);

describe("total-fit line breaking", () => {
  it("returns no lines for no content", () => {
    expect(breakLines([], options())).toEqual([]);
  });

  it("keeps a paragraph that fits on one natural line", () => {
    expect(breakLines(words(30, 30), options())).toEqual([{ start: 0, end: 3, isNatural: true }]);
  });

  it("gives up a tight first line when it would strand a word on a rigid line", () => {
    // First fit packs three words (ratio -1), leaving one word alone before the long one.
    expect(ends(words(30, 30, 30, 30, 90))).toEqual([
      [0, 3],
      [4, 7],
      [8, 9],
    ]);
  });

  it("discards the glue it breaks at and never breaks at a forbidden penalty", () => {
    const items = [box(60), penalty(FORBIDDEN_BREAK), space(), box(30), space(), box(60)];
    expect(ends(items)).toEqual([
      [0, 4],
      [5, 6],
    ]);
  });

  it("counts a hyphen's width on the line that ends with it", () => {
    const hyphenated = (hyphen: number) => [
      box(50),
      space(),
      box(30),
      penalty(50, hyphen, true),
      box(30),
      space(),
      box(50),
    ];
    expect(ends(hyphenated(10))).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(ends(hyphenated(16))?.[0]).toEqual([0, 1]);
  });

  it("prefers a loose line to hyphenating two lines in a row", () => {
    const loose = () => glue(10, 40, 5);
    const hyphen = () => penalty(50, 10, true);
    const items = [
      box(90),
      hyphen(),
      box(20),
      loose(),
      box(15),
      loose(),
      box(40),
      hyphen(),
      box(60),
    ];
    expect(ends(items)).toEqual([
      [0, 1],
      [2, 5],
      [6, 9],
    ]);
    expect(ends(items.slice(2))).toEqual([
      [0, 5],
      [6, 7],
    ]);
  });

  it("sets the line before a hard break at natural width and starts a new one", () => {
    const items = [box(20), penalty(FORCED_BREAK), box(20), space(), box(20)];
    expect(breakLines(items, options())).toEqual([
      { start: 0, end: 1, isNatural: true },
      { start: 2, end: 5, isNatural: true },
    ]);
  });

  it("uses the first line width for the first line only", () => {
    expect(ends(words(40, 40, 40, 40), { firstLineWidth: 50 })).toEqual([
      [0, 1],
      [2, 5],
      [6, 7],
    ]);
  });

  it("never shrinks in ragged mode", () => {
    expect(ends(words(30, 30, 30, 30), { ragged: true })).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(ends(words(30, 30, 30, 30))).toEqual([
      [0, 5],
      [6, 7],
    ]);
  });

  describe("infeasible paragraphs", () => {
    const tooWide = [box(150), space(), box(20)];
    const tooLoose = [box(10), penalty(FORBIDDEN_BREAK), glue(10, 1, 1), box(10), space(), box(95)];

    it("reports failure instead of exceeding the tolerance or the width", () => {
      expect(breakLines(tooWide, options())).toBeUndefined();
      expect(breakLines(tooLoose, options())).toBeUndefined();
    });

    it("as a last resort accepts any looseness and lets an unbreakable box overflow", () => {
      expect(ends(tooLoose, { isLastResort: true })).toEqual([
        [0, 4],
        [5, 6],
      ]);
      expect(ends(tooWide, { isLastResort: true })).toEqual([
        [0, 1],
        [2, 3],
      ]);
    });

    it("terminates with one box per line when nothing fits at all", () => {
      const lines = breakLines(
        words(30, 30, 30),
        options({ width: 0, firstLineWidth: 0, isLastResort: true }),
      );
      expect(lines?.map((line) => line.end - line.start)).toEqual([1, 1, 1]);
    });
  });
});
