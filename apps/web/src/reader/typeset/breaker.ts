import { FORBIDDEN_BREAK, FORCED_BREAK, type Item } from "./items";

export interface BreakOptions {
  readonly width: number;
  readonly firstLineWidth: number;
  /** Lines keep natural spacing: looseness is priced against `raggedStretch`, shrink is not used. */
  readonly ragged: boolean;
  readonly raggedStretch: number;
  /** Lines stretched past this ratio are heavily penalised, and rejected unless `isLastResort`. */
  readonly tolerance: number;
  /** Accept any looseness and force overfull lines instead of failing. */
  readonly isLastResort: boolean;
}

export interface LineBreak {
  /** First item of the line, after the glue discarded at its start. */
  readonly start: number;
  /** The item broken at; `items.length` for the end of the paragraph. */
  readonly end: number;
  /** A last line or a line before a hard break: set at natural width. */
  readonly isNatural: boolean;
}

interface BreakNode {
  readonly position: number;
  readonly lineStart: number;
  readonly previous: BreakNode | undefined;
  readonly demerits: number;
  readonly fitness: number;
  readonly flagged: boolean;
  readonly isNatural: boolean;
}

const LINE_PENALTY = 1;
const FITNESS_DEMERITS = 100;
const DOUBLE_HYPHEN_DEMERITS = 200_000;
const OVER_TOLERANCE_BADNESS = 10_000;
const MIN_REJECT_RATIO = 15;
const RIGID_RATIO = 10_000;

function fitnessClass(ratio: number) {
  if (ratio < -0.5) return 0;
  if (ratio <= 0.5) return 1;
  return ratio <= 1 ? 2 : 3;
}

/**
 * Total-fit line breaking. Returns undefined when no set of breaks satisfies the tolerance; with
 * `isLastResort` it always returns lines, forcing an overfull line where nothing fits.
 */
export function breakLines(
  items: ReadonlyArray<Item>,
  options: BreakOptions,
): Array<LineBreak> | undefined {
  let end = items.length;
  while (end > 0) {
    const last = items[end - 1]!;
    if (last.type === "box" || (last.type === "penalty" && last.cost > FORCED_BREAK)) break;
    end -= 1;
  }
  if (end === 0) return [];

  const widths = new Float64Array(end + 1);
  const stretches = new Float64Array(end + 1);
  const shrinks = new Float64Array(end + 1);
  for (let index = 0; index < end; index += 1) {
    const item = items[index]!;
    widths[index + 1] = widths[index]! + (item.type === "penalty" ? 0 : item.width);
    stretches[index + 1] = stretches[index]! + (item.type === "glue" ? item.stretch : 0);
    shrinks[index + 1] = shrinks[index]! + (item.type === "glue" ? item.shrink : 0);
  }

  const lineStartAfter = (position: number) => {
    const item = items[position];
    if (item === undefined) return position;
    let start = position;
    if (item.type === "penalty") {
      start += 1;
      // Glue after a hard break opens a line the way it opens a paragraph, so it stays.
      if (item.cost <= FORCED_BREAK) return start;
    }
    while (start < end && items[start]!.type === "glue") start += 1;
    return start;
  };

  const rejectAbove = Math.max(options.tolerance, MIN_REJECT_RATIO);
  let active: Array<BreakNode> = [
    {
      position: -1,
      lineStart: 0,
      previous: undefined,
      demerits: 0,
      fitness: 1,
      flagged: false,
      isNatural: false,
    },
  ];

  for (let position = 0; position <= end; position += 1) {
    const item = position < end ? items[position]! : undefined;
    const isEnd = item === undefined;
    const isForced = item?.type === "penalty" && item.cost <= FORCED_BREAK;
    if (item !== undefined) {
      if (item.type === "box") continue;
      if (item.type === "penalty" && item.cost >= FORBIDDEN_BREAK) continue;
      if (item.type === "glue" && (position === 0 || items[position - 1]!.type !== "box")) continue;
    }
    const isNatural = isEnd || isForced;
    const breakWidth = item?.type === "penalty" ? item.width : 0;
    const breakCost = item?.type === "penalty" && !isForced ? item.cost : 0;
    const flagged = item?.type === "penalty" && item.flagged;

    const best: Array<BreakNode | undefined> = [undefined, undefined, undefined, undefined];
    const survivors: Array<BreakNode> = [];
    let fallback: BreakNode | undefined;
    for (const node of active) {
      const start = Math.min(node.lineStart, position);
      const natural = widths[position]! - widths[start]! + breakWidth;
      const stretch = stretches[position]! - stretches[start]!;
      const shrink = shrinks[position]! - shrinks[start]!;
      const lineWidth = node.previous === undefined ? options.firstLineWidth : options.width;
      const difference = lineWidth - natural;
      let ratio = 0;
      if (difference < 0) {
        ratio = !options.ragged && shrink > 0 ? difference / shrink : Number.NEGATIVE_INFINITY;
      } else if (difference > 0 && !isNatural) {
        if (options.ragged) ratio = difference / options.raggedStretch;
        else ratio = stretch > 0 ? Math.min(difference / stretch, RIGID_RATIO) : RIGID_RATIO;
      }

      if (ratio < -1 || isForced) {
        if (
          fallback === undefined ||
          node.position > fallback.position ||
          (node.position === fallback.position && node.demerits < fallback.demerits)
        ) {
          fallback = node;
        }
      } else {
        survivors.push(node);
      }
      if (ratio < -1) continue;
      if (ratio > rejectAbove && ratio !== RIGID_RATIO && !options.isLastResort) continue;

      const badness =
        100 * Math.abs(ratio) ** 3 + (ratio > options.tolerance ? OVER_TOLERANCE_BADNESS : 0);
      const fitness = fitnessClass(ratio);
      let demerits = node.demerits + (LINE_PENALTY + badness + breakCost) ** 2;
      if (Math.abs(fitness - node.fitness) >= 2) demerits += FITNESS_DEMERITS;
      if (node.flagged && flagged) demerits += DOUBLE_HYPHEN_DEMERITS;
      const incumbent = best[fitness];
      if (incumbent === undefined || demerits < incumbent.demerits) {
        best[fitness] = {
          position,
          lineStart: lineStartAfter(position),
          previous: node,
          demerits,
          fitness,
          flagged,
          isNatural,
        };
      }
    }

    for (const node of best) if (node !== undefined) survivors.push(node);
    if (survivors.length === 0) {
      if (!options.isLastResort || fallback === undefined) return undefined;
      survivors.push({
        position,
        lineStart: lineStartAfter(position),
        previous: fallback,
        demerits: fallback.demerits,
        fitness: 0,
        flagged,
        isNatural,
      });
    }
    active = survivors;
  }

  let chosen: BreakNode | undefined;
  for (const node of active) {
    if (node.position === end && (chosen === undefined || node.demerits < chosen.demerits)) {
      chosen = node;
    }
  }
  if (chosen === undefined) return undefined;

  const lines: Array<LineBreak> = [];
  for (let node = chosen; node.previous !== undefined; node = node.previous) {
    lines.push({
      start: Math.min(node.previous.lineStart, node.position),
      end: node.position === end ? items.length : node.position,
      isNatural: node.isNatural,
    });
  }
  return lines.reverse();
}
