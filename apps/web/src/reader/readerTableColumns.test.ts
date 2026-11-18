import { describe, expect, it } from "vite-plus/test";

import { allocateTableColumns } from "./readerTableColumns";

// Content widths measured in the native reader at a 720 px column: 16 px of padding per column.
describe("allocateTableColumns", () => {
  it.each([
    {
      name: "natural widths when they fit",
      mins: [16, 16],
      maxs: [100, 200],
      avail: 400,
      widths: [100, 200],
    },
    {
      name: "a short column beside a long one",
      mins: [16, 16],
      maxs: [27.5, 2000],
      avail: 688,
      widths: [27.5, 660.5],
    },
    {
      name: "long, one letter, long",
      mins: [16, 16, 16],
      maxs: [900, 12.5, 1100],
      avail: 672,
      widths: [328, 16, 328],
    },
    {
      name: "long columns share equally",
      mins: [16, 16, 16],
      maxs: [400, 800, 1200],
      avail: 672,
      widths: [224, 224, 224],
    },
    {
      name: "minimums cut when even they do not fit",
      mins: [10, 30, 30],
      maxs: [10, 90, 90],
      avail: 50,
      widths: [10, 20, 20],
    },
  ])("$name", ({ mins, maxs, avail, widths }) => {
    expect(allocateTableColumns(mins, maxs, avail)).toEqual(widths);
  });
});
