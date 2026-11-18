const finite = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Content widths of a table's columns sharing `available`: every column gets its natural
 * width when they all fit; otherwise columns that fit under one common cap keep their natural
 * width and the rest share what is left equally; when not even the minimums fit, the widest
 * minimums are cut to an equal share.
 */
export function allocateTableColumns(
  mins: ReadonlyArray<number>,
  maxs: ReadonlyArray<number>,
  available: number,
): Array<number> {
  const low = mins.map(finite);
  const high = maxs.map((value, index) => Math.max(finite(value), low[index]!));
  const avail = finite(available);
  const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);
  if (sum(high) <= avail) return high;
  if (sum(low) < avail) {
    const capped = (cap: number) => sum(low.map((min, index) => clamp(cap, min, high[index]!)));
    const levels = [...new Set([...low, ...high])].sort((a, b) => a - b);
    let lo = levels[0]!;
    let hi = lo;
    for (const level of levels.slice(1)) {
      hi = level;
      if (capped(level) >= avail) break;
      lo = level;
    }
    const open = low.filter((min, index) => min <= lo && high[index]! >= hi).length;
    const cap = lo + (avail - capped(lo)) / Math.max(open, 1);
    return low.map((min, index) => clamp(cap, min, high[index]!));
  }
  if (avail <= 0 || sum(low) <= 0) return low;
  let remaining = avail;
  let count = low.length;
  let cap = Number.POSITIVE_INFINITY;
  for (const min of [...low].sort((a, b) => a - b)) {
    const share = remaining / count;
    if (share < min) {
      cap = share;
      break;
    }
    remaining -= min;
    count -= 1;
  }
  return low.map((min) => Math.min(min, cap));
}
