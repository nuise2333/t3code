import { describe, expect, it } from "vite-plus/test";

import {
  buildFileTreePathUpdates,
  moveFileTreePaths,
  shouldRebuildFileTree,
} from "./fileTreePathReconciliation";

const folder = (name: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${name}/entry-${index}`);

const decide = (previous: readonly string[], next: readonly string[]) =>
  shouldRebuildFileTree(previous, next, buildFileTreePathUpdates(previous, next));

describe("buildFileTreePathUpdates", () => {
  it("removes a folder once and skips the paths inside it", () => {
    expect(
      buildFileTreePathUpdates(["src/", "src/a/", "src/a/b/", "src/a/c.ts"], ["src/"]),
    ).toEqual([{ type: "remove", path: "src/a/", recursive: true }]);
  });

  it("does not treat a sibling that shares a name prefix as inside a removed folder", () => {
    expect(buildFileTreePathUpdates(["src/a/", "src/ab/", "src/a.ts"], [])).toEqual([
      { type: "remove", path: "src/a/", recursive: true },
      { type: "remove", path: "src/ab/", recursive: true },
      { type: "remove", path: "src/a.ts" },
    ]);
  });
});

describe("moveFileTreePaths", () => {
  it("moves a renamed folder's contents with it, so the server's listing diffs to nothing", () => {
    const before = ["src/", "src/a/", "src/a/b.ts", "src/ab.ts"];
    const renamed = moveFileTreePaths(before, "src/a/", "src/c/");
    expect(renamed).toEqual(["src/", "src/c/", "src/c/b.ts", "src/ab.ts"]);
    expect(
      buildFileTreePathUpdates(renamed, ["src/", "src/ab.ts", "src/c/", "src/c/b.ts"]),
    ).toEqual([]);
  });

  it("leaves the listing to put a failed rename back", () => {
    const before = ["src/", "src/a.ts"];
    const renamed = moveFileTreePaths(before, "src/a.ts", "src/b.ts");
    expect(buildFileTreePathUpdates(renamed, before)).toEqual([
      { type: "remove", path: "src/b.ts" },
      { type: "add", path: "src/a.ts" },
    ]);
  });
});

describe("shouldRebuildFileTree", () => {
  it("rebuilds when many paths land in a folder that dominates the tree", () => {
    const existing = folder("big", 50_000);
    expect(decide(existing, [...existing, ...addTo("big", 301)])).toBe(true);
  });

  it("counts a folder's subfolders as siblings, whose paths end in a slash", () => {
    const existing = folder("big", 50_000).map((path) => `${path}/`);
    const added = addTo("big", 301).map((path) => `${path}/`);
    expect(decide(existing, [...existing, ...added])).toBe(true);
    expect(decide(existing, existing.slice(301))).toBe(true);
  });

  it("batches a few hundred paths into a small folder beside a large unrelated one", () => {
    const existing = folder("big", 50_000);
    expect(decide(existing, [...existing, ...folder("small", 301)])).toBe(false);
  });

  it("batches many operations spread thinly across many small folders", () => {
    const existing = folder("big", 50_000);
    const added = Array.from({ length: 1_000 }, (_, index) => `small-${index}/file.ts`);
    expect(decide(existing, [...existing, ...added])).toBe(false);
  });
});

function addTo(name: string, count: number) {
  return Array.from({ length: count }, (_, index) => `${name}/added-${index}`);
}
