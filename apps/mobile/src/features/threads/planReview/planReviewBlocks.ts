import { plainMarkdownLine, type PlanAnnotationDraft } from "@t3tools/client-runtime/planReview";

/** One tappable part of a plan: a heading, a paragraph, a list item, a table or a code block. */
export interface PlanBlock {
  /** 1-based line of the plan's Markdown the block starts on. */
  readonly line: number;
  /** Source to render, dedented so a nested block does not render as code. */
  readonly markdown: string;
  /** The block as read, without Markdown markers; empty for a divider, which takes no note. */
  readonly quote: string;
  /** How deep the block sits in a list. */
  readonly depth: number;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const DIVIDER = /^\s{0,3}(?:[-*_]\s*){3,}$/;
const MAX_DEPTH = 4;

function indentOf(line: string): number {
  return line.match(/^[ \t]*/)![0].replaceAll("\t", "    ").length;
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line);
}

export function splitPlanBlocks(markdown: string): PlanBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: PlanBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const first = lines[index]!;
    if (!first.trim()) {
      index += 1;
      continue;
    }
    const fence = first.match(FENCE)?.[1];
    let end = index + 1;
    if (fence) {
      while (end < lines.length && !lines[end]!.trim().startsWith(fence)) end += 1;
      end = Math.min(end + 1, lines.length);
    } else if (!HEADING.test(first) && !DIVIDER.test(first)) {
      while (end < lines.length && lines[end]!.trim() && !startsBlock(lines[end]!)) end += 1;
    }
    const source = lines.slice(index, end);
    const indent = Math.min(...source.filter((line) => line.trim()).map(indentOf));
    const body = fence
      ? source.slice(1, source.at(-1)?.trim().startsWith(fence) ? -1 : undefined)
      : source;
    blocks.push({
      line: index + 1,
      markdown: source
        .map((line) => line.replaceAll("\t", "    ").slice(Math.min(indent, indentOf(line))))
        .join("\n"),
      quote: DIVIDER.test(first)
        ? ""
        : (fence ? body : body.map(plainMarkdownLine).filter(Boolean)).join("\n").trim(),
      depth: Math.min(MAX_DEPTH, Math.floor(indent / 2)),
    });
    index = end;
  }
  return blocks;
}

/** A plan's blocks never move once it is proposed, so a note finds its block by line. */
export function annotationForBlock(
  annotations: ReadonlyArray<PlanAnnotationDraft>,
  block: PlanBlock,
): PlanAnnotationDraft | undefined {
  return annotations.find((annotation) => annotation.line === block.line);
}
