import { describe, expect, it } from "vite-plus/test";

import type { GhosttyCell, GhosttySnapshot } from "./core";
import { renderGhosttySnapshot } from "./renderer";

const background = { r: 255, g: 255, b: 255 };

const blank: GhosttyCell = {
  text: "",
  wide: 0,
  foreground: { r: 0, g: 0, b: 0 },
  background,
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
};

/** Counts device pixels that are not the terminal background. */
function pixelsOffBackground(context: CanvasRenderingContext2D): number {
  const { data } = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] !== 255 || data[index + 1] !== 255 || data[index + 2] !== 255) count += 1;
  }
  return count;
}

/** Whether the device pixel under a CSS pixel position is closer to black than white. */
function isDarkAt(context: CanvasRenderingContext2D, x: number, y: number): boolean {
  const { a, d } = context.getTransform();
  const { data } = context.getImageData(Math.floor(x * a), Math.floor(y * d), 1, 1);
  return data[0]! < 128 && data[1]! < 128 && data[2]! < 128;
}

/** A 40 by 60 CSS pixel canvas drawn at the given device pixel ratio. */
function scaledContext(scale: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(40 * scale);
  canvas.height = Math.round(60 * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable");
  context.setTransform(scale, 0, 0, scale, 0, 0);
  return context;
}

const layout = {
  metrics: { width: 7.8, height: 17, baseline: 13 },
  fontSize: 13,
  fontFamily: "monospace",
  padding: 4,
  originY: 4,
};

describe.each([1.25, 2.2])("renderGhosttySnapshot at a %sx device pixel ratio", (scale) => {
  it.each([
    ["bar", 0],
    ["block", 1],
    ["underline", 2],
    ["hollow block", 3],
  ])("erases a %s cursor completely when it blinks off", (_name, cursorStyle) => {
    const context = scaledContext(scale);
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 3,
      foreground: { r: 0, g: 0, b: 0 },
      background,
      cursor: { r: 0, g: 0, b: 0 },
      cursorX: 2,
      cursorY: 1,
      cursorVisible: true,
      cursorBlinking: true,
      cursorStyle,
      dirtyRows: new Set(),
      rowData: [0, 1, 2].map(() => ({
        cells: [blank, blank, blank],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    };
    const options = { ...layout, context, snapshot };

    renderGhosttySnapshot({ ...options, forceFull: true, cursorOn: true });
    expect(pixelsOffBackground(context)).toBeGreaterThan(0);

    renderGhosttySnapshot({ ...options, forceFull: false, cursorOn: false, previousCursorY: 1 });
    expect(pixelsOffBackground(context)).toBe(0);
  });

  it("erases a Powerline separator completely when only its row repaints", () => {
    const context = scaledContext(scale);
    const firstRow = (cell: GhosttyCell): GhosttySnapshot => ({
      cols: 3,
      rows: 3,
      foreground: { r: 0, g: 0, b: 0 },
      background,
      cursor: { r: 0, g: 0, b: 0 },
      cursorX: -1,
      cursorY: -1,
      cursorVisible: false,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [cell, blank, blank].map((middle) => ({
        cells: [blank, middle, blank],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    });
    const options = { ...layout, context, forceFull: false, cursorOn: false };

    renderGhosttySnapshot({ ...options, snapshot: firstRow(blank), forceFull: true });
    renderGhosttySnapshot({ ...options, snapshot: firstRow({ ...blank, text: "\ue0b0" }) });
    expect(pixelsOffBackground(context)).toBeGreaterThan(0);

    renderGhosttySnapshot({ ...options, snapshot: firstRow(blank) });
    expect(pixelsOffBackground(context)).toBe(0);
  });

  // Cell 1 spans x 11.8 to 19.6 and row 0 spans y 4 to 21 in CSS pixels.
  it.each([
    ["right", "\ue0b4", { flat: 12.3, round: 19.1, neighbour: 0, outside: 11.3 }],
    ["left", "\ue0b6", { flat: 19.1, round: 12.3, neighbour: 2, outside: 20.1 }],
  ])("fills the rounded %s cap to the cell edges, under a block cursor too", (_side, text, x) => {
    const context = scaledContext(scale);
    const segment = { ...blank, background: { r: 0, g: 0, b: 0 } };
    const cells = [blank, { ...blank, text }, blank];
    cells[x.neighbour] = segment;
    const snapshot = (cursorVisible: boolean): GhosttySnapshot => ({
      cols: 3,
      rows: 1,
      foreground: { r: 0, g: 0, b: 0 },
      background,
      cursor: { r: 0, g: 0, b: 0 },
      cursorX: 1,
      cursorY: 0,
      cursorVisible,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [{ cells, text: "", isWrapContinuation: false, wrapsToNext: false }],
    });

    renderGhosttySnapshot({
      ...layout,
      context,
      snapshot: snapshot(false),
      forceFull: true,
      cursorOn: false,
    });
    expect(isDarkAt(context, x.flat, 4.5)).toBe(true);
    expect(isDarkAt(context, x.flat, 20.5)).toBe(true);
    expect(isDarkAt(context, x.round, 12.5)).toBe(true);
    expect(isDarkAt(context, x.round, 4.5)).toBe(false);

    renderGhosttySnapshot({
      ...layout,
      context,
      snapshot: snapshot(true),
      forceFull: true,
      cursorOn: true,
    });
    expect(isDarkAt(context, x.outside, 12.5)).toBe(true);
    expect(isDarkAt(context, x.flat, 12.5)).toBe(false);
  });

  // The 3 by 3 grid spans x 4 to 27.4 and y 4 to 55 in CSS pixels; cell 1 centres on 15.7, 29.5.
  it.each([
    ["box drawing lines", "\u253c", 2],
    ["full blocks", "\u2588", 0],
  ])("joins %s across cells and rows without seams", (_name, text, reach) => {
    const context = scaledContext(scale);
    const glyph = { ...blank, text };
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 3,
      foreground: { r: 0, g: 0, b: 0 },
      background,
      cursor: { r: 0, g: 0, b: 0 },
      cursorX: -1,
      cursorY: -1,
      cursorVisible: false,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set(),
      rowData: [0, 1, 2].map(() => ({
        cells: [glyph, glyph, glyph],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    };
    renderGhosttySnapshot({ ...layout, context, snapshot, forceFull: true, cursorOn: false });

    const { data, width } = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
    const dark = (x: number, y: number) => data[(y * width + x) * 4]! < 128;
    const inkNear = (x: number, y: number, alongX: boolean) =>
      Array.from({ length: reach * 2 + 1 }, (_, index) => index - reach).some((delta) =>
        alongX ? dark(x, y + delta) : dark(x + delta, y),
      );
    const centreX = Math.round(15.7 * scale);
    const centreY = Math.round(29.5 * scale);
    for (let y = Math.ceil(4 * scale); y < Math.floor(55 * scale); y += 1) {
      expect(inkNear(centreX, y, false), `row ${y}`).toBe(true);
    }
    for (let x = Math.ceil(4 * scale); x < Math.floor(27.4 * scale); x += 1) {
      expect(inkNear(x, centreY, true), `column ${x}`).toBe(true);
    }
  });
});
