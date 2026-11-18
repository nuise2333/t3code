import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// Nodes are immutable, so a block's source never changes; after an edit only the edited
// top-level block is serialized again.
const blockSources = new WeakMap<ProseMirrorNode, string>();
const blockStartsByDoc = new WeakMap<ProseMirrorNode, ReadonlyArray<number>>();

const BOM = "﻿";

const isLeaf = (node: ProseMirrorNode) => node.isTextblock || node.isAtom;

/** The bytes between `before` and the content, and between the content and `after`. */
function fills(node: ProseMirrorNode): readonly [string, string] {
  if (node.content.size === 0 || node.type.name !== "codeBlock") return ["", ""];
  return [node.attrs.fillBefore as string, node.attrs.fillAfter as string];
}

/** The bytes of a leaf's content: its text with the line prefixes put back. */
export function leafContentSource(node: ProseMirrorNode): string {
  let source = "";
  node.forEach((child) => {
    source += child.isText ? child.text! : (child.attrs.text as string);
  });
  return source;
}

/** A leaf's text without its line prefixes, which inline analysis offsets index. */
export function leafText(node: ProseMirrorNode): string {
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text;
  });
  return text;
}

function serializeBlock(node: ProseMirrorNode): string {
  let source = blockSources.get(node);
  if (source !== undefined) return source;
  if (isLeaf(node)) {
    const [fillBefore, fillAfter] = fills(node);
    source = `${node.attrs.before}${fillBefore}${leafContentSource(node)}${fillAfter}${node.attrs.after}`;
  } else {
    source = "";
    node.forEach((child) => {
      source += serializeBlock(child);
    });
  }
  blockSources.set(node, source);
  return source;
}

/** Offsets of each top-level block's first byte, then the end of the file. */
export function blockStarts(doc: ProseMirrorNode): ReadonlyArray<number> {
  let starts = blockStartsByDoc.get(doc);
  if (starts) return starts;
  const list: number[] = [];
  let offset = (doc.attrs.bom ? 1 : 0) + (doc.attrs.lead as string).length;
  doc.forEach((child) => {
    list.push(offset);
    offset += serializeBlock(child).length;
  });
  list.push(offset);
  blockStartsByDoc.set(doc, list);
  return list;
}

export function serializeMarkdownFile(doc: ProseMirrorNode): string {
  const parts: string[] = [doc.attrs.bom ? BOM : "", doc.attrs.lead as string];
  doc.forEach((child) => {
    parts.push(serializeBlock(child));
  });
  return parts.join("");
}

export interface LeafPlacement {
  readonly node: ProseMirrorNode;
  /** Document position of the leaf node. */
  readonly pos: number;
  /** Source offset of the leaf's first line, where `before` starts. */
  readonly lineStart: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  /** Where `after` ends: the next leaf's first line. */
  readonly end: number;
}

/** Calls `visit` for each leaf of the top-level blocks `[from, to)`, in order, with its offsets. */
export function forEachLeaf(
  doc: ProseMirrorNode,
  visit: (leaf: LeafPlacement) => boolean | void,
  from = 0,
  to = doc.childCount,
) {
  const starts = blockStarts(doc);
  let pos = 0;
  for (let index = 0; index < from; index++) pos += doc.child(index).nodeSize;
  // Returns false once `visit` asked to stop.
  const walk = (node: ProseMirrorNode, nodePos: number, offset: number): boolean => {
    if (isLeaf(node)) {
      const [fillBefore, fillAfter] = fills(node);
      const contentStart = offset + (node.attrs.before as string).length + fillBefore.length;
      const contentEnd = contentStart + leafContentSource(node).length;
      const end = contentEnd + fillAfter.length + (node.attrs.after as string).length;
      return (
        visit({ node, pos: nodePos, lineStart: offset, contentStart, contentEnd, end }) !== false
      );
    }
    let childPos = nodePos + 1;
    let childOffset = offset;
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (!walk(child, childPos, childOffset)) return false;
      childPos += child.nodeSize;
      childOffset += serializeBlock(child).length;
    }
    return true;
  };
  for (let index = from; index < to; index++) {
    const child = doc.child(index);
    if (!walk(child, pos, starts[index]!)) return;
    pos += child.nodeSize;
  }
}

function topIndexAtOffset(doc: ProseMirrorNode, offset: number) {
  const starts = blockStarts(doc);
  let low = 0;
  let high = doc.childCount - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Document position of a position inside a leaf's content, by offset into its source. */
function posInContent(node: ProseMirrorNode, pos: number, offset: number) {
  let remaining = offset;
  let at = pos + 1;
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child.isText) {
      if (remaining <= child.text!.length) return at + remaining;
      remaining -= child.text!.length;
      at += child.text!.length;
    } else {
      const length = (child.attrs.text as string).length;
      // Inside a line prefix: the caret goes to the start of that line's content.
      if (remaining === 0) return at;
      if (remaining <= length) return at + 1;
      remaining -= length;
      at += 1;
    }
  }
  return at;
}

/**
 * The document position for a source offset. Offsets in `before`, `after` or the lead clamp to
 * the nearest content edge of that leaf.
 */
export function posAtSourceOffset(doc: ProseMirrorNode, offset: number): number {
  let result = 0;
  forEachLeaf(
    doc,
    (leaf) => {
      const atom = leaf.node.isAtom;
      const startPos = atom ? leaf.pos : leaf.pos + 1;
      const endPos = atom ? leaf.pos : leaf.pos + leaf.node.nodeSize - 1;
      if (offset >= leaf.end) {
        result = endPos;
        return true;
      }
      if (offset <= leaf.contentStart) result = startPos;
      else if (offset >= leaf.contentEnd) result = endPos;
      else result = posInContent(leaf.node, leaf.pos, offset - leaf.contentStart);
      return false;
    },
    topIndexAtOffset(doc, offset),
  );
  return result;
}

/** The source offset of a document position; positions between leaves take the next leaf's start. */
export function sourceOffsetAt(doc: ProseMirrorNode, pos: number): number {
  let result = blockStarts(doc).at(-1)!;
  forEachLeaf(
    doc,
    (leaf) => {
      const node = leaf.node;
      const endPos = node.isAtom ? leaf.pos : leaf.pos + node.nodeSize - 1;
      if (pos > endPos) {
        result = leaf.end;
        return true;
      }
      if (node.isAtom || pos <= leaf.pos) {
        result = leaf.lineStart;
        return false;
      }
      let offset = leaf.contentStart;
      let at = leaf.pos + 1;
      node.forEach((child) => {
        if (at >= pos) return;
        if (child.isText) {
          const take = Math.min(child.text!.length, pos - at);
          offset += take;
          at += take;
        } else {
          offset += (child.attrs.text as string).length;
          at += 1;
        }
      });
      result = offset;
      return false;
    },
    doc.resolve(pos).index(0),
  );
  return result;
}
