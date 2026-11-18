/** Advances in CSS px. `font` is whatever the host's measuring function accepts, e.g. a canvas font. */
export interface TextMeasurer {
  advance(text: string, font: string): number;
  spaceAdvance(font: string): number;
  hyphenAdvance(font: string): number;
}

const MAX_ENTRIES_PER_FONT = 50_000;

export function createCachedMeasurer(
  measure: (text: string, font: string) => number,
): TextMeasurer {
  const fonts = new Map<string, Map<string, number>>();
  const advance = (text: string, font: string) => {
    let entries = fonts.get(font);
    if (entries === undefined) {
      entries = new Map();
      fonts.set(font, entries);
    }
    let width = entries.get(text);
    if (width === undefined) {
      width = measure(text, font);
      if (entries.size >= MAX_ENTRIES_PER_FONT) entries.clear();
      entries.set(text, width);
    }
    return width;
  };
  return {
    advance,
    spaceAdvance: (font) => advance(" ", font),
    hyphenAdvance: (font) => advance("-", font),
  };
}
