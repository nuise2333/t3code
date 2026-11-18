import { describe, expect, it } from "vite-plus/test";

import { mergeLineRects, padLineSlots, pageTarget } from "./readerPaging";

/** Lines of 27 px from `from`, like body text in the reader. */
const linesFrom = (from: number, count: number, height = 27) =>
  Array.from({ length: count }, (_, index) => ({
    top: from + index * height,
    bottom: from + (index + 1) * height,
  }));

const page = {
  scrollTop: 0,
  viewportHeight: 600,
  maxScrollTop: 5000,
  fallbackOverlap: 54,
} as const;

describe("pageTarget", () => {
  it("keeps the last two whole lines at the top and brings the cut line through whole", () => {
    // Lines at 10, 37, ... the one at 577 is cut by the bottom edge at 600.
    const lines = linesFrom(10, 23);
    const target = pageTarget({ ...page, direction: "down", lines });
    expect(target).toBe(523);
    expect(lines.find((line) => line.top < 600 && line.bottom > 600)?.top).toBeGreaterThan(
      target ?? 0,
    );
  });

  it("moves at least half a screen and lands on a line when the bottom half has few lines", () => {
    const lines = [
      { top: 100, bottom: 127 },
      { top: 127, bottom: 154 },
      { top: 310, bottom: 337 },
    ];
    expect(pageTarget({ ...page, direction: "down", lines })).toBe(310);
    expect(pageTarget({ ...page, direction: "down", lines: lines.slice(0, 2) })).toBe(300);
  });

  it("overlaps by the fallback where no whole line is in view", () => {
    const picture = [{ top: 0, bottom: 2000 }];
    expect(pageTarget({ ...page, direction: "down", lines: picture })).toBe(546);
  });

  it("does not move past the end or before the start", () => {
    expect(pageTarget({ ...page, direction: "down", scrollTop: 5000, lines: [] })).toBeNull();
    expect(pageTarget({ ...page, direction: "up", lines: [] })).toBeNull();
    expect(
      pageTarget({ ...page, direction: "down", scrollTop: 4800, lines: linesFrom(5300, 10) }),
    ).toBe(5000);
  });

  it("pages up keeping the first two whole lines at the bottom", () => {
    // Lines at 1010, 1037, ...; the first whole one starts at 1010, the second ends at 1064.
    const lines = linesFrom(1010, 11);
    expect(pageTarget({ ...page, direction: "up", scrollTop: 1000, lines })).toBe(464);
  });

  it("pages up at least half a screen and stops at the top", () => {
    expect(
      pageTarget({
        ...page,
        direction: "up",
        scrollTop: 1000,
        lines: [{ top: 1300, bottom: 1600 }],
      }),
    ).toBe(700);
    expect(pageTarget({ ...page, direction: "up", scrollTop: 200, lines: linesFrom(210, 4) })).toBe(
      0,
    );
  });
});

describe("mergeLineRects", () => {
  it("joins fragments on one line and keeps separate lines apart", () => {
    const merged = mergeLineRects([
      { top: 40, bottom: 58 },
      { top: 4, bottom: 22 },
      // An inline formula a little taller than the text beside it.
      { top: 2, bottom: 25 },
      { top: 31, bottom: 49 },
      { top: 0, bottom: 0 },
    ]);
    expect(merged).toEqual([
      { top: 2, bottom: 25 },
      { top: 31, bottom: 58 },
    ]);
  });
});

describe("padLineSlots", () => {
  it("grows glyph boxes to the line height without crossing into a neighbour", () => {
    expect(
      padLineSlots(
        [
          { top: 4, bottom: 23 },
          { top: 31, bottom: 50 },
          { top: 54, bottom: 73 },
        ],
        27,
      ),
    ).toEqual([
      { top: 0, bottom: 27 },
      { top: 27, bottom: 52 },
      { top: 52, bottom: 77 },
    ]);
  });
});
