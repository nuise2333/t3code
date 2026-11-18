/** A line's vertical extent, in the scrolled content's coordinates. */
export interface LineSlot {
  readonly top: number;
  readonly bottom: number;
}

export type PageDirection = "down" | "up";

/** How many lines of the old screen stay on the new one. */
const KEPT_LINES = 2;
// Rects from layout carry sub-pixel noise; a line within this of an edge counts as inside.
const EDGE = 0.5;

/**
 * Turns the per-fragment rects of one stretch of text into line slots: fragments that share
 * most of their height (a word, its link, an inline formula) sit on one line.
 */
export function mergeLineRects(rects: ReadonlyArray<LineSlot>): LineSlot[] {
  const sorted = rects
    .filter((rect) => rect.bottom - rect.top > 0)
    .toSorted((a, b) => a.top - b.top || a.bottom - b.bottom);
  const lines: LineSlot[] = [];
  for (const rect of sorted) {
    const last = lines.at(-1);
    const overlap = last ? Math.min(last.bottom, rect.bottom) - Math.max(last.top, rect.top) : 0;
    const shorter = last ? Math.min(last.bottom - last.top, rect.bottom - rect.top) : 0;
    if (last && overlap >= shorter / 2) {
      lines[lines.length - 1] = {
        top: Math.min(last.top, rect.top),
        bottom: Math.max(last.bottom, rect.bottom),
      };
    } else {
      lines.push(rect);
    }
  }
  return lines;
}

/**
 * Grows each text slot to its line box, a glyph box being shorter than the line it sits on,
 * without reaching past the middle of the gap to a neighbour.
 */
export function padLineSlots(lines: ReadonlyArray<LineSlot>, lineHeight: number): LineSlot[] {
  return lines.map((line, index) => {
    const pad = Math.max(0, (lineHeight - (line.bottom - line.top)) / 2);
    const previous = lines[index - 1];
    const next = lines[index + 1];
    const top = previous
      ? Math.max(line.top - pad, (previous.bottom + line.top) / 2)
      : line.top - pad;
    const bottom = next
      ? Math.min(line.bottom + pad, (line.bottom + next.top) / 2)
      : line.bottom + pad;
    return { top: Math.min(top, line.top), bottom: Math.max(bottom, line.bottom) };
  });
}

export interface PageInput {
  readonly direction: PageDirection;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly maxScrollTop: number;
  /** Lines near the edge the page turns over, sorted and not overlapping. */
  readonly lines: ReadonlyArray<LineSlot>;
  /** The overlap kept where no whole line is in view, such as over a tall picture. */
  readonly fallbackOverlap: number;
}

/**
 * Where one page step scrolls to, or null at the start or end. The last two lines of the old
 * screen stay at the top of the new one, so a line the bottom edge cuts comes through whole;
 * every step moves at least half a screen.
 */
export function pageTarget(input: PageInput): number | null {
  const { scrollTop, viewportHeight, maxScrollTop, lines, fallbackOverlap } = input;
  const screenBottom = scrollTop + viewportHeight;
  const half = viewportHeight / 2;
  const whole = lines.filter(
    (line) => line.top >= scrollTop - EDGE && line.bottom <= screenBottom + EDGE,
  );

  if (input.direction === "down") {
    if (scrollTop >= maxScrollTop - EDGE) return null;
    const kept = whole.at(-Math.min(KEPT_LINES, whole.length));
    let target = kept ? kept.top : screenBottom - fallbackOverlap;
    const least = scrollTop + half;
    if (target < least) {
      const aligned = lines.find((line) => line.top >= least && line.top < screenBottom);
      target = aligned ? aligned.top : least;
    }
    target = Math.min(target, maxScrollTop);
    return target > scrollTop + EDGE ? target : null;
  }

  if (scrollTop <= EDGE) return null;
  const kept = whole[Math.min(KEPT_LINES, whole.length) - 1];
  const keptBottom = kept ? kept.bottom : scrollTop + fallbackOverlap;
  const target = Math.max(0, Math.min(keptBottom - viewportHeight, scrollTop - half));
  return target < scrollTop - EDGE ? target : null;
}
