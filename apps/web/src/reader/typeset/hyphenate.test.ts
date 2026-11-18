import { expect, it } from "vite-plus/test";
import { hyphenationPoints } from "./hyphenate";

const hyphenated = (word: string) => {
  let out = "";
  let from = 0;
  for (const point of hyphenationPoints(word)) {
    out += `${word.slice(from, point)}-`;
    from = point;
  }
  return out + word.slice(from);
};

it.each([
  ["typographical", "ty-po-graph-i-cal"],
  ["already", "al-ready"],
  ["appealing", "ap-peal-ing"],
  ["considers", "con-sid-ers"],
  ["penalty", "pen-alty"],
  ["requires", "re-quires"],
  ["internationalization", "in-ter-na-tion-al-iza-tion"],
  ["Typographical", "Ty-po-graph-i-cal"],
  ["project", "project"],
  ["table", "ta-ble"],
  ["into", "into"],
  ["the", "the"],
])("%s -> %s", (word, expected) => {
  expect(hyphenated(word)).toBe(expected);
});

it("keeps at least two letters before and three after a break", () => {
  for (const word of ["abandon", "elephant", "idea", "area", "every", "oboe", "aerial"]) {
    for (const point of hyphenationPoints(word)) {
      expect(point).toBeGreaterThanOrEqual(2);
      expect(word.length - point).toBeGreaterThanOrEqual(3);
    }
  }
});
