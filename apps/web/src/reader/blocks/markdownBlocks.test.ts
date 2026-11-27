import { expect, it } from "vite-plus/test";
import { markdownBlocks, replaceBlock } from "./markdownBlocks";

it("keeps source trivia outside the top-level UTF-16 ranges", () => {
  const parts = [
    ["yaml", "---\r\ntitle: 😀\r\n---"],
    ["heading", "# 中文😀  "],
    ["paragraph", "正文  "],
    ["list", "- one\r\n  - two"],
    ["blockquote", "> quoted"],
    ["definition", "[key]: url"],
    ["footnoteDefinition", "[^1]: note"],
    ["code", "```\r\nx\r\n```"],
    ["math", "$$\r\nx\r\n$$"],
    ["table", "| A | B |\r\n| - | - |"],
    ["thematicBreak", "***"],
    ["html", "<div></div>"],
  ] as const;
  const source = "\uFEFF" + parts.map(([, raw]) => raw).join("\r\n\r\n") + "\r\n";
  const blocks = markdownBlocks(source, { math: true });
  expect(blocks.map(({ from, to, kind }) => [kind, source.slice(from, to)])).toEqual(parts);
  for (const block of blocks)
    expect(replaceBlock(source, block, source.slice(block.from, block.to))).toBe(source);
  expect(replaceBlock(source, blocks[1]!, "新标题")).toBe(source.replace(parts[1][1], "新标题"));
  expect(markdownBlocks("", { math: true })).toEqual([]);
  expect(markdownBlocks("\uFEFF😀\n\n$$\nx\n$$", { math: false })).toEqual([
    { from: 1, to: 3, kind: "paragraph" },
    { from: 5, to: 12, kind: "paragraph" },
  ]);
});
