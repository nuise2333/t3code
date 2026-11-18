import { describe, expect, it } from "vite-plus/test";

import { orderedListMarkerDigits, orderedListMarkerNumbers } from "./ChatMarkdown.logic";

describe("orderedListMarkerDigits", () => {
  it.each([
    { items: [undefined, undefined], start: undefined, digits: 1 },
    { items: Array.from({ length: 10 }), start: undefined, digits: 2 },
    { items: [undefined, undefined, undefined], start: 998, digits: 4 },
    { items: [1, 250, undefined], start: 1, digits: 3 },
    { items: [undefined], start: "not a number", digits: 1 },
    { items: [], start: 100, digits: 3 },
  ])("counts $digits digits from start $start", ({ items, start, digits }) => {
    expect(orderedListMarkerDigits(items, start)).toBe(digits);
  });
});

describe("orderedListMarkerNumbers", () => {
  it("counts on from the start and from each written value", () => {
    expect(orderedListMarkerNumbers([undefined, undefined], 9)).toEqual([9, 10]);
    expect(orderedListMarkerNumbers([undefined, 7, undefined], "x")).toEqual([1, 7, 8]);
  });
});
