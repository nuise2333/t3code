import { describe, expect, it } from "vite-plus/test";
import { breakLines } from "./breaker";
import { buildItems } from "./items";
import {
  ORACLE_ADVANCES,
  ORACLE_CASES,
  ORACLE_HAN,
  ORACLE_HYPHEN,
  ORACLE_SPACE,
} from "./oracleFixture";

const measurer = {
  advance: (text: string) => {
    let width = 0;
    let latin = "";
    for (const char of text) {
      if ((char.codePointAt(0) ?? 0) >= 0x2e80) width += ORACLE_HAN;
      else latin += char;
    }
    if (latin === "") return width;
    const advance = ORACLE_ADVANCES[latin];
    if (advance === undefined) throw new Error(`No recorded advance for "${latin}"`);
    return width + advance;
  },
  spaceAdvance: () => ORACLE_SPACE,
  hyphenAdvance: () => ORACLE_HYPHEN,
};

describe("breaks match the reference reader's line report", () => {
  it.each(ORACLE_CASES)("$name", ({ text, rows }) => {
    const items = buildItems([{ kind: "text", text, font: "oracle", fontSize: 16 }], measurer);
    for (const [width, interior, hyphenated, maxRatio, minRatio, meanRatio] of rows) {
      const lines = breakLines(items, {
        width,
        firstLineWidth: width,
        ragged: false,
        raggedStretch: 32,
        tolerance: 10,
        isLastResort: false,
      });
      const ratios = (lines ?? []).slice(0, -1).map((line) => {
        let difference = width;
        let stretch = 0;
        let shrink = 0;
        for (const item of items.slice(line.start, line.end)) {
          if (item.type !== "penalty") difference -= item.width;
          if (item.type === "glue") {
            stretch += item.stretch;
            shrink += item.shrink;
          }
        }
        const breakItem = items[line.end];
        if (breakItem?.type === "penalty") difference -= breakItem.width;
        return difference > 0 ? difference / stretch : difference / shrink;
      });
      const hyphens = (lines ?? []).filter((line) => {
        const breakItem = items[line.end];
        return breakItem?.type === "penalty" && breakItem.flagged;
      });
      const mean = ratios.reduce((sum, ratio) => sum + Math.abs(ratio), 0) / ratios.length;
      const label = `width ${width}`;
      expect(ratios.length, label).toBe(interior);
      expect(hyphens.length, label).toBe(hyphenated);
      expect(Math.max(...ratios), label).toBeCloseTo(maxRatio, 2);
      expect(Math.min(...ratios), label).toBeCloseTo(minRatio, 2);
      expect(mean, label).toBeCloseTo(meanRatio, 2);
    }
  });
});
