import { isDigit } from "./classify";

/** UAX #14 line breaking classes, reduced to the ones whose pair rules differ in prose. */
export type LineBreakClass =
  | "AL"
  | "NU"
  | "ID"
  | "OP"
  | "CL"
  | "CP"
  | "EX"
  | "IS"
  | "SY"
  | "NS"
  | "IN"
  | "PO"
  | "PR"
  | "QU"
  | "BA"
  | "BB"
  | "HY"
  | "GL"
  | "B2";

const inRange = (cp: number, low: number, high: number) => cp >= low && cp <= high;

const chars = (text: string) => new Set(Array.from(text, (char) => char.codePointAt(0) ?? 0));

const OP = chars("([{¡¿‚„⁅〈《「『【〔〖〘〚〝︗︵︷︹︻︽︿﹁﹃﹇﹙﹛﹝（［｛｟｢");
const CL = chars("}⁆、。〉》」』】〕〗〙〛〞〟︑︒︘︶︸︺︼︾﹀﹂﹄﹈﹐﹒﹚﹜﹞），．］｝｠｡｣､");
const EX = chars("!?︕︖﹖﹗！？");
const IS = chars(",.:;⁄︐︓︔");
const NS = chars(
  "‼‽⁇⁈⁉々〜〻〼゛゜ゝゞ゠・ヽヾ﹔﹕：；･ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶー",
);
const IN = chars("․‥…︙");
const PO = chars("%¢°‰‱′″‴‵‶‷⁗﹪％￠");
const PR = chars("$+\\£¤¥±№﹩＄￡￥￦");
const QU = chars("\"'«»‘’‛“”‟‹›");
const BA = chars("|‐‒–‧⁖⁘⁙⁚⁛⁝⁞\u00ad\u3000\u2009\u200a\u200b");
const GL = chars("\u00a0\u2011\u202f\u2060\ufeff");

export function lineBreakClass(cp: number): LineBreakClass {
  if (cp < 0x80) {
    if (isDigit(cp)) return "NU";
    if (inRange(cp, 0x41, 0x5a) || inRange(cp, 0x61, 0x7a)) return "AL";
    if (cp === 0x2d) return "HY";
    if (cp === 0x2f) return "SY";
    if (cp === 0x29 || cp === 0x5d) return "CP";
  }
  if (cp === 0x2014) return "B2";
  if (cp === 0xb4) return "BB";
  if (OP.has(cp)) return "OP";
  if (CL.has(cp)) return "CL";
  if (EX.has(cp)) return "EX";
  if (IS.has(cp)) return "IS";
  if (NS.has(cp) || inRange(cp, 0x31f0, 0x31ff)) return "NS";
  if (IN.has(cp)) return "IN";
  if (PO.has(cp)) return "PO";
  if (PR.has(cp)) return "PR";
  if (QU.has(cp)) return "QU";
  if (BA.has(cp)) return "BA";
  if (GL.has(cp)) return "GL";
  if (
    inRange(cp, 0x2e80, 0x2fdf) ||
    inRange(cp, 0x3000, 0x4dbf) ||
    inRange(cp, 0x4e00, 0x9fff) ||
    inRange(cp, 0xac00, 0xd7af) ||
    inRange(cp, 0xf900, 0xfaff) ||
    inRange(cp, 0xfe30, 0xfe6f) ||
    inRange(cp, 0xff01, 0xff60) ||
    inRange(cp, 0xffe0, 0xffe6) ||
    inRange(cp, 0x1f000, 0x1faff) ||
    inRange(cp, 0x20000, 0x3ffff)
  ) {
    return "ID";
  }
  return "AL";
}

const isAlpha = (cls: LineBreakClass) => cls === "AL";
const isAlnum = (cls: LineBreakClass) => cls === "AL" || cls === "NU";
const isPrefixOrPostfix = (cls: LineBreakClass) => cls === "PR" || cls === "PO";
const closesBeforeSpace = (cls: LineBreakClass) =>
  cls === "CL" || cls === "CP" || cls === "EX" || cls === "IS" || cls === "SY";

/**
 * Whether a line may end between two adjacent characters. Follows the Unicode 15.0 pair rules,
 * which keep curly quotes glued to both neighbours and forbid a break before any opening bracket
 * that follows a letter or digit.
 */
export function canBreakBetween(before: LineBreakClass, after: LineBreakClass) {
  if (closesBeforeSpace(after)) return false;
  if (before === "OP" || before === "BB") return false;
  if (before === "QU" || after === "QU") return false;
  if (before === "GL" || after === "GL") return false;
  if (after === "BA" || after === "HY" || after === "NS" || after === "IN") return false;
  if (before === "B2" && after === "B2") return false;
  if ((isAlpha(before) && after === "NU") || (before === "NU" && isAlpha(after))) return false;
  if ((before === "PR" && after === "ID") || (before === "ID" && after === "PO")) return false;
  if (
    (isPrefixOrPostfix(before) && isAlpha(after)) ||
    (isAlpha(before) && isPrefixOrPostfix(after))
  ) {
    return false;
  }
  if ((before === "CL" || before === "CP" || before === "NU") && isPrefixOrPostfix(after)) {
    return false;
  }
  if (isPrefixOrPostfix(before) && (after === "OP" || after === "NU")) return false;
  if (
    (before === "HY" || before === "IS" || before === "NU" || before === "SY") &&
    after === "NU"
  ) {
    return false;
  }
  if (isAlpha(before) && isAlpha(after)) return false;
  if (before === "IS" && isAlpha(after)) return false;
  if (isAlnum(before) && after === "OP") return false;
  if (before === "CP" && isAlnum(after)) return false;
  return true;
}

/** Whether a line may end at white space separating two characters. */
export function canBreakAcrossSpace(before: LineBreakClass, after: LineBreakClass) {
  if (closesBeforeSpace(after)) return false;
  if (before === "OP") return false;
  if (before === "QU" && after === "OP") return false;
  if ((before === "CL" || before === "CP") && after === "NS") return false;
  if (before === "B2" && after === "B2") return false;
  return true;
}
