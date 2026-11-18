/** Fine-grained class of a code point, for callers that style or inspect characters. */
export type CharClass =
  | "space"
  | "han"
  | "kana"
  | "hangul"
  | "fullWidthOpening"
  | "fullWidthClosing"
  | "fullWidthStop"
  | "fullWidthMiddle"
  | "fullWidthOther"
  | "latinLetter"
  | "digit"
  | "asciiPunctuation"
  | "other";

/** Coarse class that drives the Han to Latin gap and the Han to Han glue. */
export type ScriptClass = "han" | "cjkPunctuation" | "latin" | "space" | "other";

export type PunctuationSide = "opening" | "closing";

const inRange = (cp: number, low: number, high: number) => cp >= low && cp <= high;

const OPENING = new Set([
  0x3008, 0x300a, 0x300c, 0x300e, 0x3010, 0x3014, 0x3016, 0x3018, 0x301a, 0x301d, 0xff08, 0xff3b,
  0xff5b, 0xff5f, 0xff62,
]);
const CLOSING_BRACKETS = new Set([
  0x3009, 0x300b, 0x300d, 0x300f, 0x3011, 0x3015, 0x3017, 0x3019, 0x301b, 0x301e, 0x301f, 0xff09,
  0xff3d, 0xff5d, 0xff60, 0xff63,
]);
const STOPS = new Set([
  0x3001, 0x3002, 0xff01, 0xff0c, 0xff0e, 0xff1a, 0xff1b, 0xff1f, 0xff61, 0xff64,
]);
const MIDDLES = new Set([0x00b7, 0x2014, 0x2026, 0x301c, 0x30fb, 0xff5e]);
const ITERATION_MARKS = new Set([0x3005, 0x3006, 0x3007, 0x303b]);

export function isSpace(cp: number) {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0c;
}

export function isLatinLetter(cp: number) {
  return (
    inRange(cp, 0x41, 0x5a) ||
    inRange(cp, 0x61, 0x7a) ||
    (inRange(cp, 0xc0, 0x24f) && cp !== 0xd7 && cp !== 0xf7)
  );
}

export function isDigit(cp: number) {
  return inRange(cp, 0x30, 0x39);
}

function isHanIdeograph(cp: number) {
  return (
    ITERATION_MARKS.has(cp) ||
    inRange(cp, 0x3400, 0x4dbf) ||
    inRange(cp, 0x4e00, 0x9fff) ||
    inRange(cp, 0xf900, 0xfaff)
  );
}

export function charClass(cp: number): CharClass {
  if (isSpace(cp)) return "space";
  if (cp < 0x80) {
    if (isLatinLetter(cp)) return "latinLetter";
    if (isDigit(cp)) return "digit";
    return cp > 0x20 && cp < 0x7f ? "asciiPunctuation" : "other";
  }
  if (MIDDLES.has(cp)) return "fullWidthMiddle";
  if (isLatinLetter(cp)) return "latinLetter";
  if (isHanIdeograph(cp)) return "han";
  if (inRange(cp, 0x3040, 0x30ff)) return "kana";
  if (inRange(cp, 0xac00, 0xd7af)) return "hangul";
  if (OPENING.has(cp)) return "fullWidthOpening";
  if (CLOSING_BRACKETS.has(cp)) return "fullWidthClosing";
  if (STOPS.has(cp)) return "fullWidthStop";
  if (inRange(cp, 0x3000, 0x303f) || inRange(cp, 0xff01, 0xff60)) return "fullWidthOther";
  return "other";
}

// Full-width letters and digits count as CJK punctuation here, and Greek, Cyrillic, quotes and
// dashes as "other": neither side of those gets the Han to Latin gap.
export function scriptClass(cp: number): ScriptClass {
  if (isSpace(cp)) return "space";
  // The native Latin range U+00C0-024F takes in × and ÷ as well.
  if (isLatinLetter(cp) || isDigit(cp) || cp === 0xd7 || cp === 0xf7) return "latin";
  if (cp < 0x3000) return "other";
  if (isHanIdeograph(cp) || inRange(cp, 0x3040, 0x30ff) || inRange(cp, 0xac00, 0xd7af)) {
    return "han";
  }
  if (inRange(cp, 0x3000, 0x303f) || inRange(cp, 0xff01, 0xff60)) return "cjkPunctuation";
  return "other";
}

/** Which half of a full-width mark's cell is blank; stops count as closing. */
export function punctuationSide(cp: number): PunctuationSide | undefined {
  if (OPENING.has(cp)) return "opening";
  if (CLOSING_BRACKETS.has(cp) || STOPS.has(cp)) return "closing";
  return undefined;
}

const FULL_HANG = new Set([0x3001, 0x3002, 0xff0c, 0xff0e, 0x2c, 0x2e]);
const HALF_HANG = new Set([
  0x3009, 0x300b, 0x300d, 0x300f, 0x3011, 0x3015, 0x3017, 0x3019, 0x301b, 0x301e, 0x301f, 0xff01,
  0xff09, 0xff1a, 0xff1b, 0xff1f, 0x21, 0x22, 0x27, 0x29, 0x3a, 0x3b, 0x3f, 0x5d, 0x2019, 0x201d,
]);

/** Share of a line-end mark's set width that protrudes past the measure. */
export function hangFraction(cp: number) {
  if (FULL_HANG.has(cp)) return 1;
  return HALF_HANG.has(cp) ? 0.5 : 0;
}

// Variation selectors, joiners and combining marks stay with the character before them.
export function isClusterExtender(cp: number) {
  return (
    inRange(cp, 0x300, 0x36f) ||
    inRange(cp, 0x20d0, 0x20ff) ||
    inRange(cp, 0x3099, 0x309a) ||
    inRange(cp, 0xfe00, 0xfe0f) ||
    inRange(cp, 0x1f3fb, 0x1f3ff) ||
    inRange(cp, 0xe0100, 0xe01ef) ||
    cp === 0x200d
  );
}
