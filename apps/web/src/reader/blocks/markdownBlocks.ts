import { markdownFrontmatterEnd } from "@t3tools/shared/markdownFrontmatter";

import { parseMarkdownSyntax, type MarkdownSyntaxOptions } from "./markdownSyntax";

export interface MarkdownBlock {
  readonly from: number;
  readonly to: number;
  readonly kind: string;
}

export function markdownBlocks(
  source: string,
  options: MarkdownSyntaxOptions,
): readonly MarkdownBlock[] {
  const bom = source.startsWith("\uFEFF") ? 1 : 0;
  const yamlEnd = markdownFrontmatterEnd(source);
  const offset = yamlEnd || bom;
  const blocks: MarkdownBlock[] = yamlEnd ? [{ from: bom, to: yamlEnd, kind: "yaml" }] : [];
  for (const node of parseMarkdownSyntax(source.slice(offset), options).children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const from = start + offset;
    let to = end + offset;
    while (to > from && (source[to - 1] === "\r" || source[to - 1] === "\n")) to--;
    blocks.push({ from, to, kind: node.type });
  }
  return blocks;
}

export function replaceBlock(
  source: string,
  block: Pick<MarkdownBlock, "from" | "to">,
  text: string,
): string {
  return source.slice(0, block.from) + text + source.slice(block.to);
}
