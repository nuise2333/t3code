import { describe, expect, it } from "vite-plus/test";

import { annotationForBlock, splitPlanBlocks } from "./planReviewBlocks";

const PLAN = [
  "# Ship the importer", // 1
  "", // 2
  "Read the **CSV** and", // 3
  "write rows in batches.", // 4
  "", // 5
  "## Steps", // 6
  "1. Parse the header", // 7
  "   with the `csv` crate", // 8
  "2. Validate rows", // 9
  "    - reject empty ids", // 10
  "", // 11
  "---", // 12
  "", // 13
  "```ts", // 14
  "# not a heading", // 15
  "", // 16
  "run();", // 17
  "```", // 18
  "", // 19
  "| a | b |", // 20
  "| - | - |", // 21
].join("\n");

describe("splitPlanBlocks", () => {
  it("splits headings, paragraphs, list items, code and tables at their source lines", () => {
    expect(splitPlanBlocks(PLAN).map(({ line, quote, depth }) => ({ line, quote, depth }))).toEqual(
      [
        { line: 1, quote: "Ship the importer", depth: 0 },
        { line: 3, quote: "Read the CSV and\nwrite rows in batches.", depth: 0 },
        { line: 6, quote: "Steps", depth: 0 },
        { line: 7, quote: "Parse the header\nwith the csv crate", depth: 0 },
        { line: 9, quote: "Validate rows", depth: 0 },
        { line: 10, quote: "reject empty ids", depth: 2 },
        { line: 12, quote: "", depth: 0 },
        { line: 14, quote: "# not a heading\n\nrun();", depth: 0 },
        { line: 20, quote: "| a | b |\n| - | - |", depth: 0 },
      ],
    );
  });

  it("dedents a nested block so it renders as a list item, not code", () => {
    expect(splitPlanBlocks(PLAN)[5]?.markdown).toBe("- reject empty ids");
  });

  it("keeps an unclosed code fence as one block to the end", () => {
    expect(splitPlanBlocks("```\na\n\nb").map((block) => block.quote)).toEqual(["a\n\nb"]);
  });

  it("finds a block's note by its line", () => {
    const blocks = splitPlanBlocks(PLAN);
    const note = { id: "n", action: "delete", quote: "Validate rows", line: 9 } as const;
    expect(annotationForBlock([note], blocks[4]!)).toBe(note);
    expect(annotationForBlock([note], blocks[3]!)).toBeUndefined();
  });
});
