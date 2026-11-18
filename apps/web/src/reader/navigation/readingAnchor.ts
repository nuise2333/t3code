/**
 * A place in the document independent of its layout: the innermost block at the top edge of
 * the view, found by child indices from the reader root, and how far into that block the edge
 * falls. After a width or font change the same fraction of the same block is the same line.
 */
export interface ReadingAnchor {
  readonly path: ReadonlyArray<number>;
  /** How far into the block the view's top edge falls, as a share of the block's height. */
  readonly fraction: number;
  /** Where the edge falls in the gap above the block instead, in px. */
  readonly gap: number;
  /** The raw position, for a document whose blocks no longer match the path. */
  readonly scrollTop: number;
}

export interface AnchorTree<Node> {
  readonly children: (node: Node) => ArrayLike<Node>;
  /** Top and bottom in the scrolled content's coordinates; null for a block that is not drawn. */
  readonly box: (node: Node) => { readonly top: number; readonly bottom: number } | null;
  /** Whether the anchor may move into this block's children. */
  readonly isContainer: (node: Node) => boolean;
}

const MAX_DEPTH = 12;

type Box = { readonly top: number; readonly bottom: number } | null;

/**
 * The first drawn child whose bottom is below `y`, or -1. Blocks stack downward, so a binary
 * search finds it in a document of thousands of blocks; undrawn ones are stepped over.
 */
export function firstEndingAfter<Node>(
  children: ArrayLike<Node>,
  box: (node: Node) => Box,
  y: number,
): number {
  const drawnFrom = (index: number) => {
    for (let at = index; at < children.length; at += 1) {
      const child = children[at];
      const found = child === undefined ? null : box(child);
      if (found !== null) return { at, found };
    }
    return null;
  };
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const drawn = drawnFrom(middle);
    if (drawn === null) high = middle;
    else if (drawn.found.bottom <= y) low = drawn.at + 1;
    else high = middle;
  }
  return drawnFrom(low)?.at ?? -1;
}

/** The anchor for a view whose top edge is at `y`. */
export function locateAnchor<Node>(tree: AnchorTree<Node>, root: Node, y: number): ReadingAnchor {
  const path: number[] = [];
  let node = root;
  let fraction = 0;
  let gap = 0;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const children = tree.children(node);
    const picked = firstEndingAfter(children, tree.box, y);
    const child = children[picked];
    const pickedBox = child === undefined ? null : tree.box(child);
    if (child === undefined || pickedBox === null) break;
    path.push(picked);
    node = child;
    const height = pickedBox.bottom - pickedBox.top;
    gap = Math.max(0, pickedBox.top - y);
    fraction = gap > 0 || height <= 0 ? 0 : (y - pickedBox.top) / height;
    if (gap > 0 || !tree.isContainer(child)) break;
  }
  return { path, fraction, gap, scrollTop: y };
}

/** Where the view's top edge goes to show the anchor again, or its raw position if it is gone. */
export function anchorScrollTop<Node>(
  tree: AnchorTree<Node>,
  root: Node,
  anchor: ReadingAnchor,
): number {
  if (anchor.path.length === 0) return anchor.scrollTop;
  let node = root;
  for (const index of anchor.path) {
    const child = tree.children(node)[index];
    if (child === undefined) return anchor.scrollTop;
    node = child;
  }
  const box = tree.box(node);
  if (box === null) return anchor.scrollTop;
  return box.top + anchor.fraction * (box.bottom - box.top) - anchor.gap;
}
