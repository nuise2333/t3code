const LEADING_FRONTMATTER =
  /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)(?:[\s\S]*?(?:\r\n|\r|\n))?(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/;

/**
 * Blanks a leading YAML frontmatter block so rendered previews skip it instead
 * of showing a rule and a setext heading. Masked characters become spaces and
 * line breaks stay, so source offsets (task checkbox edits) stay valid.
 */
export function maskMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(LEADING_FRONTMATTER, (block) => block.replace(/[^\r\n]/g, " "));
}

/** End offset of a leading frontmatter block (its closing fence line, without the line ending), or 0. */
export function markdownFrontmatterEnd(markdown: string): number {
  return LEADING_FRONTMATTER.exec(markdown)?.[0].length ?? 0;
}
