import { describe, expect, it } from "vite-plus/test";

import {
  gridColumnCount,
  gridRangePaths,
  gridReturnPath,
  moveGridIndex,
  sortGridEntries,
} from "./fileGrid.logic";

describe("sortGridEntries", () => {
  it("puts folders first and sorts names naturally", () => {
    const sorted = sortGridEntries([
      { path: "src/file10.ts", kind: "file" },
      { path: "src/file2.ts", kind: "file" },
      { path: "src/zeta", kind: "directory" },
      { path: "src/Alpha", kind: "directory", ignored: true },
    ]);
    expect(sorted.map((entry) => entry.name)).toEqual(["Alpha", "zeta", "file2.ts", "file10.ts"]);
    expect(sorted[0]).toMatchObject({ path: "src/Alpha", ignored: true });
  });
});

describe("grid layout", () => {
  it.each([
    [0, 1],
    [100, 1],
    [192, 2],
    [370, 4],
  ])("fits %ipx into %i columns", (width, columns) => {
    expect(gridColumnCount(width)).toBe(columns);
  });
});

describe("moveGridIndex", () => {
  // 3 columns, 8 tiles: rows [0 1 2] [3 4 5] [6 7]
  it.each([
    [4, "ArrowLeft", 3],
    [0, "ArrowLeft", 0],
    [2, "ArrowRight", 3],
    [7, "ArrowRight", 7],
    [4, "ArrowUp", 1],
    [1, "ArrowUp", 1],
    [1, "ArrowDown", 4],
    [5, "ArrowDown", 7],
    [6, "ArrowDown", 6],
    [4, "Home", 0],
    [1, "End", 7],
    [1, "Enter", null],
  ])("from %i, %s goes to %s", (index, key, expected) => {
    expect(moveGridIndex(index, key, 3, 8)).toBe(expected);
  });

  it("has nowhere to go in an empty folder", () => {
    expect(moveGridIndex(0, "ArrowRight", 3, 0)).toBeNull();
  });
});

describe("gridRangePaths", () => {
  const paths = ["a", "b", "c", "d"];

  it("selects between the anchor and the target in either direction", () => {
    expect(gridRangePaths(paths, "b", "d")).toEqual(["b", "c", "d"]);
    expect(gridRangePaths(paths, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("selects only the target without an anchor in this folder", () => {
    expect(gridRangePaths(paths, "elsewhere", "c")).toEqual(["c"]);
    expect(gridRangePaths(paths, null, "c")).toEqual(["c"]);
  });
});

describe("gridReturnPath", () => {
  it.each([
    ["", "apps/web/src", "apps"],
    ["apps", "apps/web/src", "apps/web"],
    ["apps/web/src", "apps/web/src", null],
    ["docs", "apps/web", null],
    ["app", "apps/web", null],
    ["", null, null],
  ])("in %j with trail %j focuses %j", (folder, trail, expected) => {
    expect(gridReturnPath(folder, trail)).toBe(expected);
  });
});
