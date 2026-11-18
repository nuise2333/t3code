import { createCachedMeasurer } from "./measure";

const BODY = "16px body";
const CODE = "14px code";

/**
 * Deterministic advances for tests: the font key starts with its size in px; CJK is 1 em, a
 * letter or digit 0.5 em, a space, hyphen or other ASCII mark 0.25 em.
 */
export function createFakeMeasurer() {
  return createCachedMeasurer((text, font) => {
    const em = Number.parseFloat(font);
    let width = 0;
    for (const char of text) {
      const cp = char.codePointAt(0) ?? 0;
      if (cp >= 0x2e80) width += em;
      else if (/[\p{L}\p{N}]/u.test(char)) width += em / 2;
      else width += em / 4;
    }
    return width;
  });
}

export const body = (text: string) => ({ kind: "text", text, font: BODY, fontSize: 16 }) as const;
export const code = (text: string) =>
  ({ kind: "text", text, font: CODE, fontSize: 14, isCode: true }) as const;
