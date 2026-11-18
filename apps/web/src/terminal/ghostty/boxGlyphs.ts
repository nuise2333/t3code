// Box drawing (U+2500–U+257F) and block elements (U+2580–U+259F) are drawn from the
// cell's own edges, as native Ghostty does, so lines and blocks join across cells and
// rows whatever the font's line height or glyph coverage.

const BOX_FIRST = 0x2500;
const BOX_LAST = 0x259f;

// Arm weights per code point as "up right down left": 0 none, 1 light, 2 heavy, 3 double.
const LINE_ARMS: Readonly<Record<number, string>> = {
  ...armsFrom(
    0x2500,
    "0101 0202 1010 2020 - - - - - - - - 0110 0210 0120 0220 0011 0012 0021 0022 " +
      "1100 1200 2100 2200 1001 1002 2001 2002 1110 1210 2110 1120 2120 2210 1220 2220 " +
      "1011 1012 2011 1021 2021 2012 1022 2022 0111 0112 0211 0212 0121 0122 0221 0222 " +
      "1101 1102 1201 1202 2101 2102 2201 2202 1111 1112 1211 1212 2111 1121 2121 2112 " +
      "2211 1122 1221 2212 1222 2122 2221 2222",
  ),
  ...armsFrom(
    0x2550,
    "0303 3030 0310 0130 0330 0013 0031 0033 1300 3100 3300 1003 3001 3003 1310 3130 " +
      "3330 1013 3031 3033 0313 0131 0333 1303 3101 3303 1313 3131 3333",
  ),
  ...armsFrom(0x2574, "0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010"),
};

// Dashed lines as [count, heavy, vertical].
const DASHES: Readonly<Record<number, readonly [number, boolean, boolean]>> = {
  0x2504: [3, false, false],
  0x2505: [3, true, false],
  0x2506: [3, false, true],
  0x2507: [3, true, true],
  0x2508: [4, false, false],
  0x2509: [4, true, false],
  0x250a: [4, false, true],
  0x250b: [4, true, true],
  0x254c: [2, false, false],
  0x254d: [2, true, false],
  0x254e: [2, false, true],
  0x254f: [2, true, true],
};

// Quadrant bits: 1 upper left, 2 upper right, 4 lower left, 8 lower right.
const QUADRANTS = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14] as const;

function armsFrom(first: number, table: string): Record<number, string> {
  const entries: Record<number, string> = {};
  table.split(" ").forEach((arms, index) => {
    if (arms !== "-") entries[first + index] = arms;
  });
  return entries;
}

function boxCodePoint(text: string): number | null {
  if (text.length !== 1) return null;
  const codePoint = text.charCodeAt(0);
  return codePoint >= BOX_FIRST && codePoint <= BOX_LAST ? codePoint : null;
}

export function isBoxGlyph(text: string): boolean {
  return boxCodePoint(text) !== null;
}

interface DeviceCell {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly light: number;
}

/** Start and end of a stroke `thickness` wide, `offset` from `center`, on whole device pixels. */
function span(center: number, offset: number, thickness: number): readonly [number, number] {
  const start = Math.round(center + offset - thickness / 2);
  return [start, start + thickness];
}

function addLines(context: CanvasRenderingContext2D, cell: DeviceCell, arms: string): void {
  const { light } = cell;
  const weights = [...arms].map(Number);
  const thickness = (weight: number) => (weight === 2 ? light * 2 : light);
  const centerX = (cell.x0 + cell.x1) / 2;
  const centerY = (cell.y0 + cell.y1) / 2;

  // How far a stroke at `offset` across its arm reaches past the cell centre, given the
  // opposite arm and the two perpendicular arms, so corners, tees and doubles meet cleanly.
  const overshoot = (
    offset: number,
    opposite: number,
    perpendicularBefore: number,
    perpendicularAfter: number,
  ): number => {
    if (offset !== 0) {
      const blocker = offset < 0 ? perpendicularBefore : perpendicularAfter;
      if (blocker === 3) return -light / 2;
      if (blocker !== 0) return thickness(blocker) / 2;
      if (opposite !== 0) return 0;
      const far = offset < 0 ? perpendicularAfter : perpendicularBefore;
      if (far === 3) return light * 1.5;
      return far === 0 ? 0 : thickness(far) / 2;
    }
    if (opposite !== 0) return 0;
    if (perpendicularBefore === 3 || perpendicularAfter === 3) return -light / 2;
    return (
      Math.max(
        perpendicularBefore === 0 ? 0 : thickness(perpendicularBefore),
        perpendicularAfter === 0 ? 0 : thickness(perpendicularAfter),
      ) / 2
    );
  };

  const strokes = (weight: number): readonly number[] => {
    if (weight === 0) return [];
    return weight === 3 ? [-light, light] : [0];
  };

  const [up = 0, right = 0, down = 0, left = 0] = weights;
  for (const offset of strokes(left)) {
    const [top, bottom] = span(centerY, offset, thickness(left));
    const end = Math.round(centerX + overshoot(offset, right, up, down));
    context.rect(cell.x0, top, end - cell.x0, bottom - top);
  }
  for (const offset of strokes(right)) {
    const [top, bottom] = span(centerY, offset, thickness(right));
    const start = Math.round(centerX - overshoot(offset, left, up, down));
    context.rect(start, top, cell.x1 - start, bottom - top);
  }
  for (const offset of strokes(up)) {
    const [start, end] = span(centerX, offset, thickness(up));
    const bottom = Math.round(centerY + overshoot(offset, down, left, right));
    context.rect(start, cell.y0, end - start, bottom - cell.y0);
  }
  for (const offset of strokes(down)) {
    const [start, end] = span(centerX, offset, thickness(down));
    const top = Math.round(centerY - overshoot(offset, up, left, right));
    context.rect(start, top, end - start, cell.y1 - top);
  }
}

function addDashes(
  context: CanvasRenderingContext2D,
  cell: DeviceCell,
  [count, heavy, vertical]: readonly [number, boolean, boolean],
): void {
  const thickness = heavy ? cell.light * 2 : cell.light;
  const [low, high] = vertical ? [cell.y0, cell.y1] : [cell.x0, cell.x1];
  const center = vertical ? (cell.x0 + cell.x1) / 2 : (cell.y0 + cell.y1) / 2;
  const [across, acrossEnd] = span(center, 0, thickness);
  const segment = (high - low) / count;
  // Half a gap at each cell edge keeps the dash rhythm even across neighbouring cells.
  const gap = Math.max(1, Math.round(segment / 3));
  for (let index = 0; index < count; index += 1) {
    const start = low + Math.round(index * segment + gap / 2);
    const end = low + Math.round((index + 1) * segment - gap / 2);
    if (end <= start) continue;
    if (vertical) context.rect(across, start, acrossEnd - across, end - start);
    else context.rect(start, across, end - start, acrossEnd - across);
  }
}

function addBlock(
  context: CanvasRenderingContext2D,
  cell: DeviceCell,
  left: number,
  top: number,
  right: number,
  bottom: number,
): void {
  const width = cell.x1 - cell.x0;
  const height = cell.y1 - cell.y0;
  const x = cell.x0 + Math.round(left * width);
  const y = cell.y0 + Math.round(top * height);
  context.rect(
    x,
    y,
    cell.x0 + Math.round(right * width) - x,
    cell.y0 + Math.round(bottom * height) - y,
  );
}

/** Adds the block element's rectangles, returning the shade alpha it fills with. */
function addBlockElement(context: CanvasRenderingContext2D, cell: DeviceCell, codePoint: number) {
  if (codePoint === 0x2580) addBlock(context, cell, 0, 0, 1, 0.5);
  else if (codePoint <= 0x2588) addBlock(context, cell, 0, 1 - (codePoint - 0x2580) / 8, 1, 1);
  else if (codePoint <= 0x258f) addBlock(context, cell, 0, 0, (0x2590 - codePoint) / 8, 1);
  else if (codePoint === 0x2590) addBlock(context, cell, 0.5, 0, 1, 1);
  else if (codePoint <= 0x2593) {
    addBlock(context, cell, 0, 0, 1, 1);
    return (codePoint - 0x2590) / 4;
  } else if (codePoint === 0x2594) addBlock(context, cell, 0, 0, 1, 1 / 8);
  else if (codePoint === 0x2595) addBlock(context, cell, 7 / 8, 0, 1, 1);
  else {
    const quadrants = QUADRANTS[codePoint - 0x2596] ?? 0;
    if (quadrants & 1) addBlock(context, cell, 0, 0, 0.5, 0.5);
    if (quadrants & 2) addBlock(context, cell, 0.5, 0, 1, 0.5);
    if (quadrants & 4) addBlock(context, cell, 0, 0.5, 0.5, 1);
    if (quadrants & 8) addBlock(context, cell, 0.5, 0.5, 1, 1);
  }
  return 1;
}

function strokeArc(context: CanvasRenderingContext2D, cell: DeviceCell, codePoint: number): void {
  // ╭ ╮ ╯ ╰ curve from the vertical arm towards the horizontal one.
  const towardsRight = codePoint === 0x256d || codePoint === 0x2570;
  const towardsDown = codePoint === 0x256d || codePoint === 0x256e;
  const [lineX] = span((cell.x0 + cell.x1) / 2, 0, cell.light);
  const [lineY] = span((cell.y0 + cell.y1) / 2, 0, cell.light);
  const x = lineX + cell.light / 2;
  const y = lineY + cell.light / 2;
  const endX = towardsRight ? cell.x1 : cell.x0;
  const endY = towardsDown ? cell.y1 : cell.y0;
  const radius = Math.min(Math.abs(endX - x), Math.abs(endY - y));
  context.beginPath();
  context.moveTo(x, endY);
  context.arcTo(x, y, endX, y, radius);
  context.lineTo(endX, y);
  context.stroke();
}

function strokeDiagonals(context: CanvasRenderingContext2D, cell: DeviceCell, codePoint: number) {
  context.beginPath();
  if (codePoint !== 0x2572) {
    context.moveTo(cell.x0, cell.y1);
    context.lineTo(cell.x1, cell.y0);
  }
  if (codePoint !== 0x2571) {
    context.moveTo(cell.x0, cell.y0);
    context.lineTo(cell.x1, cell.y1);
  }
  context.stroke();
}

/**
 * Draws a box drawing or block element character in the current fill style, inside the
 * cell at the given CSS pixel box. `cellWidth` is the unsnapped grid width, so every cell
 * shares one line thickness.
 */
export function drawBoxGlyph(
  context: CanvasRenderingContext2D,
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
  cellWidth: number,
): void {
  const codePoint = boxCodePoint(text);
  if (codePoint === null) return;
  const { a: scaleX, d: scaleY } = context.getTransform();
  const cell: DeviceCell = {
    x0: Math.round(left * scaleX),
    x1: Math.round((left + width) * scaleX),
    y0: Math.round(top * scaleY),
    y1: Math.round((top + height) * scaleY),
    light: Math.max(1, Math.round((cellWidth * scaleX) / 8)),
  };
  context.save();
  context.resetTransform();
  context.beginPath();
  context.rect(cell.x0, cell.y0, cell.x1 - cell.x0, cell.y1 - cell.y0);
  context.clip();
  context.beginPath();
  const arms = LINE_ARMS[codePoint];
  const dashes = DASHES[codePoint];
  if (arms !== undefined) addLines(context, cell, arms);
  else if (dashes !== undefined) addDashes(context, cell, dashes);
  else if (codePoint >= 0x2580) context.globalAlpha = addBlockElement(context, cell, codePoint);
  else {
    context.strokeStyle = context.fillStyle;
    context.lineWidth = cell.light;
    if (codePoint <= 0x2570) strokeArc(context, cell, codePoint);
    else strokeDiagonals(context, cell, codePoint);
    context.restore();
    return;
  }
  context.fill();
  context.restore();
}
