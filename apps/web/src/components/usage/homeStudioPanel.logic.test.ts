import { describe, expect, it } from "vite-plus/test";

import {
  HOME_BOOKS,
  HOME_HEAT_WINDOW_DAYS,
  HOME_MODEL_COLOR_COUNT,
  assignModelColors,
  axisLabelIndexes,
  axisMax,
  bookLine,
  buildHeatCells,
  chartDays,
  countActiveDays,
  heatGridDays,
  heatLevel,
  heatTipPosition,
  pickBook,
  quotaWarnLevel,
  rangeSinceDay,
} from "./homeStudioPanel.logic";

const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

describe("range bucketing", () => {
  it.each([
    ["7d", "2026-11-16"],
    ["30d", "2026-10-24"],
  ] as const)("%s starts on %s", (range, since) => {
    expect(rangeSinceDay(range, "2026-11-22")).toBe(since);
  });

  it("covers the whole heatmap for All", () => {
    expect(rangeSinceDay("all", "2026-11-22") <= heatGridDays("2026-11-22")[0]!).toBe(true);
  });

  it("counts active days inside the range only", () => {
    const daily = [
      { day: "2026-11-01", totalTokens: 10 },
      { day: "2026-11-20", totalTokens: 0 },
      { day: "2026-11-21", totalTokens: 5 },
    ];
    expect(countActiveDays(daily, "2026-11-16")).toBe(1);
    expect(countActiveDays(daily, "2026-10-01")).toBe(2);
  });

  it("caps chart columns at 30 days and follows shorter ranges", () => {
    expect(chartDays("all", "2026-11-22")).toHaveLength(30);
    expect(chartDays("7d", "2026-11-22")).toEqual([
      "2026-11-16",
      "2026-11-17",
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
    ]);
  });
});

describe("heatmap", () => {
  it.each(["2026-11-22", "2026-11-25", "2024-03-02"])(
    "starts on a Sunday and ends on %s",
    (until) => {
      const days = heatGridDays(until);
      expect(weekday(days[0]!)).toBe(0);
      expect(days.at(-1)).toBe(until);
      expect(days.length).toBeGreaterThanOrEqual(26 * 7);
      expect(days.length).toBeLessThanOrEqual(HOME_HEAT_WINDOW_DAYS);
    },
  );

  it.each([
    [0, 100, 0],
    [1, 100, 1],
    [20, 100, 1],
    [21, 100, 2],
    [60, 100, 3],
    [80, 100, 4],
    [81, 100, 5],
    [100, 100, 5],
    [5, 0, 0],
  ])("maps %i of peak %i to step %i", (tokens, peak, level) => {
    expect(heatLevel(tokens, peak)).toBe(level);
  });

  it("scales levels to the peak inside the grid", () => {
    const cells = buildHeatCells("2026-11-22", [
      { day: "2026-11-22", totalTokens: 1000 },
      { day: "2026-11-21", totalTokens: 400 },
      { day: "2020-01-01", totalTokens: 1_000_000 },
    ]);
    expect(cells.at(-1)).toEqual({ day: "2026-11-22", tokens: 1000, level: 5 });
    expect(cells.at(-2)?.level).toBe(2);
    expect(cells.some((cell) => cell.day === "2020-01-01")).toBe(false);
  });

  it("keeps the tooltip inside the grid and flips above near the bottom", () => {
    const base = { gridWidth: 480, gridHeight: 120, cellWidth: 14, cellHeight: 14, textLength: 20 };
    expect(heatTipPosition({ ...base, cellLeft: 0, cellTop: 0 })).toEqual({ left: 0, top: 20 });
    const bottomRight = heatTipPosition({ ...base, cellLeft: 466, cellTop: 102 });
    expect(bottomRight.top).toBe(72);
    expect(bottomRight.left).toBe(480 - 154);
  });
});

describe("book line", () => {
  it("uses the picked book when the total fills it", () => {
    const last = HOME_BOOKS.at(-1)!;
    expect(pickBook(last.tokens * 3, 0.999)).toEqual({ title: last.title, count: 3 });
  });

  it("falls back to smaller books when the total is too low", () => {
    expect(pickBook(30_000, 0.99)?.title).toBe("Metamorphosis");
    expect(pickBook(7_000, 0.5)).toBeNull();
    expect(pickBook(0, 0.5)).toBeNull();
  });

  it("formats singular and plural copies", () => {
    expect(bookLine(7607, 0)).toBe("≈ 1 copy of Tao Te Ching");
    expect(bookLine(7607 * 1500, 0)).toBe("≈ 1,500 copies of Tao Te Ching");
  });
});

describe("quota warnings", () => {
  it.each([
    [100, 0],
    [36, 0],
    [35, 1],
    [16, 1],
    [15, 2],
    [0, 2],
  ] as const)("%i%% remaining warns at level %i", (remaining, level) => {
    expect(quotaWarnLevel(remaining)).toBe(level);
  });
});

describe("chart helpers", () => {
  it.each([
    [0, 0],
    [7, 10],
    [12, 20],
    [2400, 2500],
    [41_000, 50_000],
  ])("rounds a peak of %i up to %i", (peak, top) => {
    expect(axisMax(peak)).toBe(top);
  });

  it("always labels the newest column", () => {
    expect(axisLabelIndexes(7)).toEqual([0, 2, 4, 6]);
    expect(axisLabelIndexes(30).at(-1)).toBe(29);
    expect(axisLabelIndexes(30).length).toBeLessThanOrEqual(6);
  });

  it("gives distinct stable colours until the palette runs out", () => {
    const ids = ["claude:opus", "codex:gpt", "claude:haiku"];
    const colors = assignModelColors(ids);
    expect(new Set(colors.values()).size).toBe(3);
    expect(assignModelColors(ids.toReversed())).toEqual(colors);
    const many = assignModelColors(Array.from({ length: 12 }, (_, index) => `m${index}`));
    expect(new Set(many.values()).size).toBe(HOME_MODEL_COLOR_COUNT);
  });
});
