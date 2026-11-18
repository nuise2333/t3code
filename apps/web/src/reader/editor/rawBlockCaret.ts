/** A text position under the pointer in a raw block's rendering. */
export interface RenderedHit {
  /** The clicked text node's text, and the offset in it. */
  readonly text: string;
  readonly offset: number;
  /** The clicked table cell: row 0 is the header row. */
  readonly cell?: { readonly row: number; readonly column: number } | undefined;
}

const LINE = /[^\r\n]*(?:\r\n|\r|\n|$)/g;

/** Where `text` occurs once in `source[from, to)`, plus `offset`; null otherwise. */
function onceIn(source: string, text: string, offset: number, from: number, to: number) {
  const slice = source.slice(from, to);
  const at = slice.indexOf(text);
  if (text.trim() === "" || at < 0 || slice.indexOf(text, at + 1) >= 0) return null;
  return from + at + Math.min(offset, text.length);
}

/** The start of the text of cell `column` on a table source line starting at `lineStart`. */
function cellStart(source: string, lineStart: number, lineEnd: number, column: number) {
  let at = lineStart;
  while (at < lineEnd && (source[at] === " " || source[at] === "\t")) at++;
  if (source[at] === "|") at++;
  for (let index = 0; index < column; index++) {
    while (at < lineEnd && source[at] !== "|") at += source[at] === "\\" ? 2 : 1;
    if (at >= lineEnd) return null;
    at++;
  }
  while (at < lineEnd && (source[at] === " " || source[at] === "\t")) at++;
  return Math.min(at, lineEnd);
}

/**
 * The source offset nearest a click on a raw block's rendering: in a table, the clicked cell's
 * text; elsewhere where the clicked text occurs once in the source. Null when neither is known.
 */
export function renderedHitOffset(source: string, hit: RenderedHit): number | null {
  if (hit.cell) {
    const lines = source.match(LINE) ?? [];
    // The delimiter row has no rendering: body row 1 is source line 2.
    const line = hit.cell.row === 0 ? 0 : hit.cell.row + 1;
    if (line >= lines.length) return null;
    let lineStart = 0;
    for (let index = 0; index < line; index++) lineStart += lines[index]!.length;
    const lineEnd = lineStart + lines[line]!.replace(/(?:\r\n|\r|\n)$/, "").length;
    const start = cellStart(source, lineStart, lineEnd, hit.cell.column);
    if (start === null) return null;
    let end = start;
    while (end < lineEnd && source[end] !== "|") end += source[end] === "\\" ? 2 : 1;
    return onceIn(source, hit.text, hit.offset, start, Math.min(end, lineEnd)) ?? start;
  }
  return onceIn(source, hit.text, hit.offset, 0, source.length);
}
