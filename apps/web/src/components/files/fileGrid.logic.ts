import type { ProjectEntry } from "@t3tools/contracts";

const GRID_TILE_WIDTH = 88;
export const GRID_ROW_HEIGHT = 96;
export const GRID_PADDING = 8;
/** Above this many items a folder shows as a list; tiles would only be scrolled past. */
export const GRID_MAX_ENTRIES = 5_000;

export interface GridEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: ProjectEntry["kind"];
  readonly ignored: boolean;
}

let collator: Intl.Collator | undefined;

/** Folders first, then a natural-order name sort, as the tree shows them. */
export function sortGridEntries(entries: readonly ProjectEntry[]): GridEntry[] {
  collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const compare = collator.compare;
  return entries
    .map((entry) => ({
      path: entry.path,
      name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
      kind: entry.kind,
      ignored: entry.ignored === true,
    }))
    .toSorted((left, right) =>
      left.kind === right.kind
        ? compare(left.name, right.name)
        : left.kind === "directory"
          ? -1
          : 1,
    );
}

export function gridColumnCount(width: number): number {
  return Math.max(1, Math.floor((width - GRID_PADDING * 2) / GRID_TILE_WIDTH));
}

/** The tile an arrow key moves to; null when the key is not a grid move. */
export function moveGridIndex(
  index: number,
  key: string,
  columns: number,
  count: number,
): number | null {
  if (count === 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowLeft":
      return Math.max(0, index - 1);
    case "ArrowRight":
      return Math.min(last, index + 1);
    case "ArrowUp":
      return index - columns < 0 ? index : index - columns;
    case "ArrowDown": {
      if (index + columns <= last) return index + columns;
      // A short last row still takes a move down from the row above it.
      return Math.floor(index / columns) < Math.floor(last / columns) ? last : index;
    }
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/** Shift-click: every path between the anchor and the target, in grid order. */
export function gridRangePaths(
  paths: readonly string[],
  anchor: string | null,
  target: string,
): string[] {
  const end = paths.indexOf(target);
  const start = anchor === null ? -1 : paths.indexOf(anchor);
  if (end < 0) return [];
  if (start < 0) return [target];
  return paths.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** The child of a project folder that a retained breadcrumb trail passes through. */
export function gridReturnPath(folder: string, trail: string | null): string | null {
  if (trail === null || trail === folder) return null;
  const prefix = folder === "" ? "" : `${folder}/`;
  if (!trail.startsWith(prefix)) return null;
  const child = trail.slice(prefix.length).split("/")[0];
  return child ? `${prefix}${child}` : null;
}
