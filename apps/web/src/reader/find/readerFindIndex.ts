import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { THREAD_FIND_BLOCK_TAGS } from "@t3tools/shared/threadFindText";

/** A rendered tree as find reads it: the DOM in the app, hast in tests. */
export interface ReaderFindView<Node> {
  readonly children: (node: Node) => ArrayLike<Node>;
  /** The data of a text node, undefined for any other node. */
  readonly text: (node: Node) => string | undefined;
  /** Lower-case tag name of an element, undefined for any other node. */
  readonly tagName: (node: Node) => string | undefined;
  /** An element whose text is not part of the document: chrome, labels, hidden duplicates. */
  readonly isSkipped: (node: Node) => boolean;
}

interface Segment<Node> {
  readonly node: Node;
  /** Where the node's kept characters sit in the chunk text. */
  readonly start: number;
  readonly end: number;
  /** Offset in the node of each kept character; null when they are the node's own offsets. */
  readonly offsets: ReadonlyArray<number> | null;
}

/** The text of one block, as it reads when copied: white space collapsed outside `pre`. */
export interface ReaderFindChunk<Node> {
  /** The innermost block element around the text. */
  readonly owner: Node;
  readonly text: string;
  readonly segments: ReadonlyArray<Segment<Node>>;
}

export interface ReaderFindIndex<Node> {
  readonly chunks: ReadonlyArray<ReaderFindChunk<Node>>;
  /** Owners with no other owner inside them, which can be indexed again on their own. */
  readonly leaves: ReadonlySet<Node>;
}

export interface ReaderFindPoint<Node> {
  readonly node: Node;
  readonly offset: number;
}

export interface ReaderFindMatch<Node> {
  readonly start: ReaderFindPoint<Node>;
  readonly end: ReaderFindPoint<Node>;
}

const SPACE = /[ \t\n\r\f]/u;
/** Text that reads differently once white space is collapsed: anything but lone spaces. */
const NEEDS_COLLAPSE = /[\t\n\r\f]| {2}/u;

/**
 * Reads the text under `root` into one chunk per block. A typeset paragraph splits its words
 * across spans and marks hyphens and line ends with empty ones, so a word broken over two
 * lines is still one run of text here.
 */
export function indexReaderFindText<Node>(
  root: Node,
  view: ReaderFindView<Node>,
  /** Whether `root` sits inside a `pre`, whose spacing is kept. */
  isRootInPre = false,
): ReaderFindIndex<Node> {
  const chunks: Array<ReaderFindChunk<Node>> = [];
  const owners: Array<Node> = [root];
  const nonLeaves = new Set<Node>();
  let text = "";
  let segments: Array<Segment<Node>> = [];
  let afterSpace = true;

  const flush = () => {
    if (text.trim() !== "") {
      const owner = owners.at(-1) ?? root;
      chunks.push({ owner, text, segments });
      for (const outer of owners) if (outer !== owner) nonLeaves.add(outer);
    }
    text = "";
    segments = [];
    afterSpace = true;
  };

  const append = (node: Node, value: string, inPre: boolean) => {
    if (value === "") return;
    const start = text.length;
    if (inPre) {
      text += value;
      afterSpace = false;
      segments.push({ node, start, end: text.length, offsets: null });
      return;
    }
    if (!NEEDS_COLLAPSE.test(value) && !(afterSpace && value.startsWith(" "))) {
      text += value;
      afterSpace = value.endsWith(" ");
      segments.push({ node, start, end: text.length, offsets: null });
      return;
    }
    let kept = "";
    const offsets: Array<number> = [];
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index] ?? "";
      const isSpace = SPACE.test(character);
      if (isSpace && afterSpace) continue;
      kept += isSpace ? " " : character;
      offsets.push(index);
      afterSpace = isSpace;
    }
    if (kept === "") return;
    text += kept;
    segments.push({
      node,
      start,
      end: text.length,
      offsets: kept.length === value.length ? null : offsets,
    });
  };

  const visit = (node: Node, inPre: boolean) => {
    const value = view.text(node);
    if (value !== undefined) {
      append(node, value, inPre);
      return;
    }
    const tagName = view.tagName(node);
    if (tagName === undefined) return;
    if (view.isSkipped(node)) {
      flush();
      return;
    }
    const isBlock = THREAD_FIND_BLOCK_TAGS.has(tagName);
    if (isBlock) {
      flush();
      owners.push(node);
    }
    const children = view.children(node);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child !== undefined) visit(child, inPre || tagName === "pre");
    }
    if (isBlock) {
      flush();
      owners.pop();
    }
  };

  const children = view.children(root);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child !== undefined) visit(child, isRootInPre || view.tagName(root) === "pre");
  }
  flush();

  const leaves = new Set<Node>();
  for (const chunk of chunks) if (!nonLeaves.has(chunk.owner)) leaves.add(chunk.owner);
  return { chunks, leaves };
}

/** The query as it is matched; only white space matches nothing. Code keeps its spacing. */
export function readerFindQuery(query: string): string {
  return query.trim() === "" ? "" : query;
}

function segmentAt<Node>(segments: ReadonlyArray<Segment<Node>>, offset: number, isEnd: boolean) {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (segment === undefined) break;
    if (isEnd ? offset <= segment.start : offset < segment.start) high = middle - 1;
    else if (isEnd ? offset > segment.end : offset >= segment.end) low = middle + 1;
    else return segment;
  }
  return undefined;
}

/** Case-insensitive matches of a `readerFindQuery` in one chunk, in document order. */
export function findInReaderChunk<Node>(
  chunk: ReaderFindChunk<Node>,
  query: string,
): Array<ReaderFindMatch<Node>> {
  if (query === "") return [];
  const matches: Array<ReaderFindMatch<Node>> = [];
  for (const offset of findThreadSearchOccurrences(chunk.text, query)) {
    const end = offset + query.length;
    const first = segmentAt(chunk.segments, offset, false);
    const last = segmentAt(chunk.segments, end, true);
    if (first === undefined || last === undefined) continue;
    const local = offset - first.start;
    const lastLocal = end - 1 - last.start;
    matches.push({
      start: { node: first.node, offset: first.offsets?.[local] ?? local },
      end: { node: last.node, offset: (last.offsets?.[lastLocal] ?? lastLocal) + 1 },
    });
  }
  return matches;
}
