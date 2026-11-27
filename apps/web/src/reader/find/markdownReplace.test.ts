import { expect, it } from "vite-plus/test";
import { findMatches, replaceMatches } from "./markdownReplace";

const literal = { regex: false, caseSensitive: false, wholeWord: false };
const regex = { ...literal, regex: true };
it("finds literal or whole Unicode words at UTF-16 offsets", () => {
  expect(findMatches("😀中文 中文版 [a] [A]", "中文", { ...literal, wholeWord: true })).toEqual({
    ranges: [{ from: 2, to: 4 }],
  });
  expect(findMatches("[a] [A]", "[A]", { ...literal, caseSensitive: true })).toEqual({
    ranges: [{ from: 4, to: 7 }],
  });
  expect(replaceMatches("[a] [A]", "[a]", "$1", literal)).toEqual({ text: "$1 $1", count: 2 });
});
it("substitutes named and numeric groups and can replace just one occurrence", () => {
  expect(replaceMatches("x1 x2", "(?<x>x)(\\d)", "$2$<x>$$", regex, 1)).toEqual({
    text: "x1 2x$",
    count: 1,
  });
  expect(findMatches("😀a", "(?=.)|$", regex)).toEqual({ ranges: [] });
  expect(findMatches("x", "(", regex)).toHaveProperty("error");
  expect(replaceMatches("x", "(", "!", regex)).toEqual({ text: "x", count: 0 });
  expect(replaceMatches("x".repeat(10001), "x", "", literal)).toEqual({ text: "x", count: 10000 });
});
