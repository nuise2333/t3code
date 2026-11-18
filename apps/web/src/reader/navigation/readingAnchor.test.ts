import { describe, expect, it } from "vite-plus/test";

import { anchorScrollTop, type AnchorTree, firstEndingAfter, locateAnchor } from "./readingAnchor";

interface Block {
  readonly tag: string;
  top: number;
  bottom: number;
  readonly children: Block[];
}

const block = (tag: string, top: number, bottom: number, children: Block[] = []): Block => ({
  tag,
  top,
  bottom,
  children,
});

const tree: AnchorTree<Block> = {
  children: (node) => node.children,
  box: (node) => (node.bottom > node.top ? { top: node.top, bottom: node.bottom } : null),
  isContainer: (node) => node.tag === "ul" || node.tag === "li",
};

/** A document laid out at `scale` times its base height, as after a width or font change. */
function documentAt(scale: number) {
  const at = (value: number) => value * scale;
  return block("root", 0, at(1000), [
    block("p", at(32), at(200)),
    block("ul", at(220), at(600), [
      block("li", at(220), at(400), [block("p", at(220), at(300)), block("p", at(310), at(400))]),
      block("li", at(410), at(600)),
    ]),
    block("details", 0, 0),
    block("p", at(620), at(1000)),
  ]);
}

describe("locateAnchor", () => {
  it("anchors to the innermost block at the top edge and finds the same line after reflow", () => {
    const anchor = locateAnchor(tree, documentAt(1), 340);
    expect(anchor).toEqual({ path: [1, 0, 1], fraction: 1 / 3, gap: 0, scrollTop: 340 });
    expect(anchorScrollTop(tree, documentAt(1.5), anchor)).toBeCloseTo(510);
  });

  it("keeps a top edge that falls in the gap above a block, and skips undrawn blocks", () => {
    const anchor = locateAnchor(tree, documentAt(1), 610);
    expect(anchor).toEqual({ path: [3], fraction: 0, gap: 10, scrollTop: 610 });
    expect(anchorScrollTop(tree, documentAt(2), anchor)).toBe(1230);
    expect(locateAnchor(tree, documentAt(1), 0)).toMatchObject({ path: [0], gap: 32 });
  });

  it("falls back to the raw position when the block is gone", () => {
    const anchor = locateAnchor(tree, documentAt(1), 340);
    const shorter = block("root", 0, 500, [block("p", 0, 500)]);
    expect(anchorScrollTop(tree, shorter, anchor)).toBe(340);
  });
});

describe("firstEndingAfter", () => {
  it("finds the first drawn block ending below a point, stepping over undrawn ones", () => {
    const blocks = Array.from({ length: 1000 }, (_, index) =>
      index % 7 === 3 ? block("details", 0, 0) : block("p", index * 10, index * 10 + 8),
    );
    expect(firstEndingAfter(blocks, tree.box, 5000)).toBe(501);
    expect(firstEndingAfter(blocks, tree.box, 29)).toBe(4);
    expect(firstEndingAfter(blocks, tree.box, 20_000)).toBe(-1);
  });
});
