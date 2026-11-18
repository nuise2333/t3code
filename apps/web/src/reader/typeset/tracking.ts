import { charClass, isClusterExtender } from "./classify";

/**
 * The `trak` table of macOS's New York (upright and italic share it): sizes in px, values in
 * 1/2048 em. CoreText applies it to every glyph; Chromium ignores `trak`, so the reader adds it.
 */
const NEW_YORK_TRAK = {
  sizes: [4, 6, 8, 12, 20, 36, 72, 144, 256],
  values: [120, 80, 50, 12, -20, -28, -31, -33, -36],
} as const;

/** Per-glyph tracking of New York at `fontSize` px, in px, interpolated as CoreText does. */
export function newYorkTracking(fontSize: number): number {
  const { sizes, values } = NEW_YORK_TRAK;
  let units: number = values[values.length - 1]!;
  if (fontSize <= sizes[0]) {
    units = values[0];
  } else {
    for (let index = 1; index < sizes.length; index += 1) {
      const upper = sizes[index]!;
      if (fontSize <= upper) {
        const lower = sizes[index - 1]!;
        const share = (fontSize - lower) / (upper - lower);
        units = values[index - 1]! + share * (values[index]! - values[index - 1]!);
        break;
      }
    }
  }
  return (units / 2048) * fontSize;
}

export type GlyphFace = "latin" | "cjk" | "other";

// Han, kana, Hangul and full-width marks come from the CJK face, emoji from the emoji face.
const faceOf = (cp: number): GlyphFace => {
  if (cp >= 0x1f000) return "other";
  switch (charClass(cp)) {
    case "han":
    case "kana":
    case "hangul":
    case "fullWidthOpening":
    case "fullWidthClosing":
    case "fullWidthStop":
    case "fullWidthMiddle":
    case "fullWidthOther":
      return "cjk";
    default:
      return "latin";
  }
};

/** Splits `text` into maximal stretches drawn from one face; `glyphs` counts Latin-face glyphs. */
export function faceSegments(
  text: string,
): Array<{ readonly text: string; readonly face: GlyphFace; readonly glyphs: number }> {
  const segments: Array<{ text: string; face: GlyphFace; glyphs: number }> = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const last = segments.at(-1);
    // An extender joins the character before it and adds no glyph of its own.
    if (last !== undefined && isClusterExtender(cp)) {
      last.text += char;
      continue;
    }
    const face = faceOf(cp);
    const glyphs = face === "latin" ? 1 : 0;
    if (last !== undefined && last.face === face) {
      last.text += char;
      last.glyphs += glyphs;
      continue;
    }
    segments.push({ text: char, face, glyphs });
  }
  return segments;
}

/** Number of glyphs in `text` that the Latin face draws. */
export function trackedGlyphCount(text: string): number {
  let count = 0;
  for (const segment of faceSegments(text)) count += segment.glyphs;
  return count;
}
