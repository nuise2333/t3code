// Mirrors native Ghostty's Nerd Font icon constraint (src/renderer/cell.zig `constraintWidth`
// and the `fit_cover1` + `center1` rule in src/font/Glyph.zig), without per-set scale groups.

export function isNerdFontIcon(text: string): boolean {
  const codePoint = text.codePointAt(0);
  if (codePoint === undefined || text.length !== (codePoint > 0xffff ? 2 : 1)) return false;
  // Powerline glyphs are terminal graphics that must stay inside their own cell.
  if (codePoint >= 0xe0b0 && codePoint <= 0xe0d7) return false;
  return (codePoint >= 0xe000 && codePoint <= 0xf8ff) || codePoint >= 0xf0000;
}

/** Cells an icon may cover: two when it is followed by a space and not preceded by an icon. */
export function nerdFontIconSpan(
  cells: readonly { readonly text: string }[],
  index: number,
): 1 | 2 {
  if (index >= cells.length - 1) return 1;
  const previous = cells[index - 1];
  if (previous !== undefined && isNerdFontIcon(previous.text)) return 1;
  const next = cells[index + 1]?.text ?? "";
  return next === "" || next === " " ? 2 : 1;
}

export interface NerdFontIconBox {
  readonly scale: number;
  /** Offset of the scaled glyph's left edge from the cell's left edge. */
  readonly x: number;
  /** Offset of the scaled glyph's top edge from the cell's top edge. */
  readonly y: number;
}

/**
 * Fits the glyph's ink box into `span` cells: scaled down to fit, or up to fill one cell,
 * but never grown past its one-cell size just because a second cell is free. Centred on
 * the first cell and vertically, never protruding left.
 */
export function nerdFontIconBox(options: {
  readonly glyphWidth: number;
  readonly glyphHeight: number;
  readonly span: 1 | 2;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly capHeight: number;
}): NerdFontIconBox {
  const { glyphWidth, glyphHeight, span, cellWidth, cellHeight, capHeight } = options;
  const singleIconHeight = (2 * capHeight + cellHeight) / 3;
  const fit = (cells: number) =>
    Math.min(
      (cells * cellWidth) / glyphWidth,
      (cells > 1 ? cellHeight : singleIconHeight) / glyphHeight,
    );
  let scale = fit(span);
  if (span > 1 && scale > 1) scale = Math.max(1, fit(1));
  return {
    scale,
    x: Math.max(0, (cellWidth - glyphWidth * scale) / 2),
    y: (cellHeight - glyphHeight * scale) / 2,
  };
}
