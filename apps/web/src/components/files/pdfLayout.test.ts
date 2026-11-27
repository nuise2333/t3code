import { describe, expect, it } from "vite-plus/test";
import {
  currentPdfPage,
  pdfFindIncludes,
  pdfFindMatchRuns,
  pdfLayout,
  pdfPageScrollTop,
  pdfPageText,
  pdfPageWidth,
  pdfRestoredScrollTop,
  rotatedPdfRatios,
  stepPdfZoom,
  visiblePdfPages,
} from "./pdfLayout";

describe("pdfPageWidth", () => {
  it("fits the page to the viewport minus its gutters until a zoom is chosen", () => {
    const view = { width: 500, height: 800 };
    expect(pdfPageWidth(view, 612, null)).toEqual({ width: 468, scale: 468 / 612 });
    expect(pdfPageWidth(view, 612, 1.5)).toEqual({ width: 918, scale: 1.5 });
  });

  it("never collapses below one pixel in a tiny viewport", () => {
    expect(pdfPageWidth({ width: 10, height: 10 }, 612, null).width).toBe(1);
    expect(pdfPageWidth({ width: 10, height: 10 }, 612, "page").width).toBe(1);
  });

  it("splits the fit width between two pages side by side", () => {
    expect(pdfPageWidth({ width: 500, height: 800 }, 612, null, 2).width).toBe(226);
  });

  it("fits a whole page by its height when the viewport is short, by width when narrow", () => {
    const letter = 792 / 612;
    expect(pdfPageWidth({ width: 1000, height: 432 }, 612, "page", 1, letter).width).toBeCloseTo(
      400 / letter,
    );
    expect(pdfPageWidth({ width: 300, height: 2000 }, 612, "page", 1, letter).width).toBe(268);
  });
});

describe("stepPdfZoom", () => {
  it("steps by a quarter and clamps to 25%..300%", () => {
    expect(stepPdfZoom(1, 1)).toBe(1.25);
    expect(stepPdfZoom(1, -1)).toBe(0.75);
    expect(stepPdfZoom(2.9, 1)).toBe(3);
    expect(stepPdfZoom(0.3, -1)).toBe(0.25);
  });

  it("starts from the fit-width scale when no zoom is set", () => {
    const { scale } = pdfPageWidth({ width: 500, height: 800 }, 612, null);
    expect(stepPdfZoom(scale, 1)).toBeCloseTo(468 / 612 + 0.25);
  });
});

describe("mixed-height page layout", () => {
  // A short banner page, a letter page, then a page half as tall as it is wide.
  const ratios = [140 / 612, 792 / 612, 306 / 612];
  const width = 612;
  const layout = pdfLayout(ratios, width);

  it("stacks pages with a gap before, between, and after them", () => {
    expect(layout.tops).toEqual([16, 172, 980]);
    expect(layout.ends).toEqual([172, 980, 1302]);
    expect(layout.height).toBe(1302);
  });

  it("reports the page whose bottom is past the top gutter as current", () => {
    expect(currentPdfPage(layout, 0)).toBe(0);
    expect(currentPdfPage(layout, 154)).toBe(0);
    expect(currentPdfPage(layout, 155)).toBe(1);
    expect(currentPdfPage(layout, 962)).toBe(1);
    expect(currentPdfPage(layout, 964)).toBe(2);
  });

  it("jumps to each page so that page becomes current", () => {
    for (const index of [0, 1, 2])
      expect(currentPdfPage(layout, pdfPageScrollTop(layout, index))).toBe(index);
    expect(pdfPageScrollTop(layout, 7)).toBe(0);
  });

  it("mounts pages within a viewport above and two below", () => {
    const indexes = (scrollTop: number, height: number) =>
      visiblePdfPages(ratios, layout, scrollTop, height).map((page) => page.index);
    expect(indexes(0, 100)).toEqual([0, 1]);
    expect(indexes(1100, 100)).toEqual([2]);
    expect(indexes(1100, 900)).toEqual([1, 2]);
    // Page 2 starts 180px (1.8 viewports) below the visible bottom of 800.
    expect(indexes(700, 100)).toEqual([1, 2]);
    expect(visiblePdfPages(ratios, layout, 0, 100)[0]).toEqual({ index: 0, ratio: ratios[0] });
  });

  it("scales offsets with the page width when zoomed", () => {
    expect(pdfLayout(ratios, width * 2).ends).toEqual([312, 1912, 2540]);
  });

  it("restores a saved spot scaled to the new width and kept inside pages that remain", () => {
    expect(pdfRestoredScrollTop(ratios, width, { page: 1, offset: 100 })).toBe(256);
    expect(pdfRestoredScrollTop(ratios, width * 2, { page: 1, offset: 100 }, width)).toBe(496);
    // A page that shrank keeps the reader on its last pixel; a removed page falls back to the last.
    expect(pdfRestoredScrollTop(ratios, width, { page: 2, offset: 600 })).toBe(964 + 305);
    expect(pdfRestoredScrollTop(ratios.slice(0, 2), width, { page: 2, offset: 0 })).toBe(156);
  });
});

describe("spreads", () => {
  const ratios = [1, 1.5, 1, 1, 1];

  it("pairs pages from the first, each row as tall as its taller page, and centres each row", () => {
    const layout = pdfLayout(ratios, 100, "odd", 500);
    expect(layout.tops).toEqual([16, 16, 182, 182, 298]);
    expect(layout.ends).toEqual([182, 182, 298, 298, 414]);
    expect(layout.lefts.slice(0, 2)).toEqual([142, 258]);
    // A lone last page sits on the left, where it falls in the spread.
    expect(layout.lefts[4]).toBe(142);
  });

  it("sets a book's cover alone on the right, then pairs the rest", () => {
    const layout = pdfLayout(ratios, 100, "even", 500);
    expect(layout.tops).toEqual([16, 132, 132, 298, 298]);
    expect(layout.lefts[0]).toBe(258);
    expect(layout.lefts.slice(1, 3)).toEqual([142, 258]);
  });

  it("reports the left page of the row in view and jumps to either page's row", () => {
    const layout = pdfLayout(ratios, 100, "odd", 500);
    expect(currentPdfPage(layout, pdfPageScrollTop(layout, 3))).toBe(2);
  });

  it("restores a page in a spread to its row", () => {
    expect(pdfRestoredScrollTop(ratios, 100, { page: 3, offset: 0 }, 100, "odd")).toBe(166);
  });
});

describe("rotatedPdfRatios", () => {
  it("swaps each page's sides when turned a quarter, and keeps them when turned a half", () => {
    expect(rotatedPdfRatios([2, 0.5], 90)).toEqual([0.5, 2]);
    expect(rotatedPdfRatios([2, 0.5], 180)).toEqual([2, 0.5]);
  });
});

describe("pdfPageText", () => {
  it("joins text items, adds line ends, and skips marked content", () => {
    expect(
      pdfPageText([
        { str: "Quarter", hasEOL: false },
        { type: "beginMarkedContent" },
        { str: "ly outlook", hasEOL: true },
        { str: "Next", hasEOL: false },
      ]),
    ).toBe("Quarterly outlook\nNext");
  });
});

describe("pdfFindMatchRuns", () => {
  it("highlights every run a match spans when a word is split across spans", () => {
    expect(pdfFindMatchRuns(["Quarter", "ly outlook", " for Q3"], "quarterly OUTLOOK")).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("highlights each separate match", () => {
    expect(pdfFindMatchRuns(["risk", " and ", "budget", " ", "Risk"], "risk")).toEqual([
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it("matches a space in the query across a line end", () => {
    expect(
      pdfFindMatchRuns(["Q3 quarterly", "\n", "outlook", " ahead"], "quarterly outlook"),
    ).toEqual([true, true, true, false]);
  });

  it("matches a word hyphenated across a line end", () => {
    expect(pdfFindMatchRuns(["the quar-", "\n", "terly report"], "quarterly")).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("drops a line-end hyphen after a letter outside the BMP", () => {
    expect(pdfFindMatchRuns(["\u{10400}-", "\n", "\u{10401}"], "\u{10400}\u{10401}")).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("finds the same pages the highlights do", () => {
    const page = "Q3 quarterly\noutlook ahead, the quar-\nterly report";
    expect(pdfFindIncludes(page, "Quarterly  OUTLOOK")).toBe(true);
    expect(pdfFindIncludes(page, "quarterly report")).toBe(true);
    expect(pdfFindIncludes(page, "bud-get")).toBe(false);
    expect(pdfFindIncludes(page, " ")).toBe(false);
  });

  it("matches straight quotes typed for typeset curly ones", () => {
    expect(pdfFindMatchRuns(["We don\u2019t ", "ship \u201cbeta\u201d"], "don't")).toEqual([
      true,
      false,
    ]);
    expect(pdfFindMatchRuns(["We don\u2019t ", "ship \u201cbeta\u201d"], '"beta"')).toEqual([
      false,
      true,
    ]);
    expect(pdfFindIncludes("We don\u2019t ship \u201cbeta\u201d", 'don\'t ship "beta"')).toBe(true);
    expect(pdfFindIncludes("We don't ship", "don\u2019t")).toBe(true);
  });

  it("highlights nothing for a blank or missing query", () => {
    expect(pdfFindMatchRuns(["a b", "c"], " ")).toEqual([false, false]);
    expect(pdfFindMatchRuns(["a b", "c"], "")).toEqual([false, false]);
    expect(pdfFindMatchRuns(["a b", "c"], "zzz")).toEqual([false, false]);
  });
});
