import { describe, expect, it } from "vite-plus/test";

import { moveOrderedKey } from "./modelOrdering";

describe("moveOrderedKey", () => {
  const keys = ["a", "b", "c", "d"];

  it.each([
    ["d", "a", "before", ["d", "a", "b", "c"]],
    ["a", "d", "after", ["b", "c", "d", "a"]],
    ["a", "c", "before", ["b", "a", "c", "d"]],
    ["d", "b", "after", ["a", "b", "d", "c"]],
  ] as const)("moves %s %s %s", (source, target, position, expected) => {
    expect(moveOrderedKey(keys, source, target, position)).toEqual(expected);
  });

  it("returns null for drops that keep the order", () => {
    expect(moveOrderedKey(keys, "b", "c", "before")).toBeNull();
    expect(moveOrderedKey(keys, "b", "a", "after")).toBeNull();
    expect(moveOrderedKey(keys, "b", "b", "after")).toBeNull();
    expect(moveOrderedKey(keys, "x", "a", "before")).toBeNull();
  });
});
