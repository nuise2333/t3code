import { expect, it } from "vite-plus/test";
import { mergeThreeWay } from "./markdownConflict";

it("merges independent edits, adjacent replacements and boundary insertions", () => {
  expect(mergeThreeWay("a\nb\nc\n", "A\r\nb\r\nc\r\n", "a\nB\nc\n尾\n")).toEqual({
    merged: "A\r\nB\r\nc\r\n尾\r\n",
    conflicts: 0,
  });
  expect(mergeThreeWay("a\nb", "new\na\nb", "A\nb")).toEqual({ merged: "new\nA\nb", conflicts: 0 });
  expect(mergeThreeWay("a\nb\nc", "a\nc", "a\nb\nC")).toEqual({ merged: "a\nC", conflicts: 0 });
  expect(mergeThreeWay("a\n", "A", "a\ntail\n")).toEqual({ merged: "A\ntail\n", conflicts: 0 });
  expect(mergeThreeWay("a\n", "a\r\n", "b\n")).toEqual({ merged: "b\r\n", conflicts: 0 });
});
it("combines chained overlapping edits into one conflict and keeps identical edits once", () => {
  expect(mergeThreeWay("a\nb\nc\nd\ne", "A\nb\nC\nd\nE", "all\nd\nE")).toEqual({
    merged: "<<<<<<< Local\nA\nb\nC\n=======\nall\n>>>>>>> Disk\nd\nE",
    conflicts: 1,
  });
  expect(mergeThreeWay("", "a", "b")).toEqual({
    merged: "<<<<<<< Local\na\n=======\nb\n>>>>>>> Disk\n",
    conflicts: 1,
  });
  expect(mergeThreeWay("a\nb\nc\n", "b\nC\n", "A\nb\nD\n").conflicts).toBe(2);
  expect(mergeThreeWay("a\nb", "a\nx\nb", "a\nx\nb")).toEqual({ merged: "a\nx\nb", conflicts: 0 });
});
