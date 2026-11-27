import {
  findPlanQuoteLine,
  planTextAnchor,
  resolvePlanTextAnchor,
  type PlanTextAnchor,
} from "@t3tools/client-runtime/planReview";

export interface PlanTextSelection {
  readonly quote: string;
  readonly anchor: PlanTextAnchor;
  readonly line: number | undefined;
  /** Viewport rectangle of the selection's last line, where its actions go. */
  readonly rect: { readonly left: number; readonly right: number; readonly bottom: number };
}

/** The reader's selection inside the rendered plan, or null when it is empty or leaves the plan. */
export function capturePlanTextSelection(
  root: HTMLElement,
  markdown: string,
  selection: Selection | null,
): PlanTextSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const quote = selection.toString().trim();
  if (!quote) return null;

  const before = root.ownerDocument.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const raw = range.toString();
  const start = before.toString().length + (raw.length - raw.trimStart().length);
  const end = start + raw.trim().length;
  if (end <= start) return null;

  const text = root.textContent ?? "";
  const firstLine = quote.split("\n", 1)[0] ?? quote;
  const rects = range.getClientRects();
  const last = rects.item(rects.length - 1) ?? range.getBoundingClientRect();
  return {
    quote,
    anchor: planTextAnchor(text, start, end),
    line: findPlanQuoteLine(
      markdown,
      quote,
      planTextAnchor(text, start, start + firstLine.length).occurrence,
    ),
    rect: { left: last.left, right: last.right, bottom: last.bottom },
  };
}

function rangeForAnchor(root: HTMLElement, anchor: PlanTextAnchor): Range | null {
  const offsets = resolvePlanTextAnchor(root.textContent ?? "", anchor);
  if (!offsets) return null;
  const range = root.ownerDocument.createRange();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let position = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && offsets.start < position + length) {
      range.setStart(node, offsets.start - position);
      started = true;
    }
    if (started && offsets.end <= position + length) {
      range.setEnd(node, offsets.end - position);
      return range;
    }
    position += length;
  }
  return null;
}

export type PlanHighlightKind = "delete" | "replace" | "comment" | "focus";

export interface PlanHighlightMark {
  readonly anchor: PlanTextAnchor;
  readonly kind: PlanHighlightKind;
}

const HIGHLIGHT_NAMES: Record<PlanHighlightKind, string> = {
  delete: "t3-plan-review-delete",
  replace: "t3-plan-review-replace",
  comment: "t3-plan-review-comment",
  focus: "t3-plan-review-focus",
};

/** Paints the marks over the rendered plan without touching its DOM; returns the cleanup. */
export function paintPlanHighlights(
  root: HTMLElement,
  marks: ReadonlyArray<PlanHighlightMark>,
): () => void {
  if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") {
    return () => {};
  }
  const painted: Array<[string, Highlight]> = [];
  for (const [kind, name] of Object.entries(HIGHLIGHT_NAMES)) {
    const ranges = marks.flatMap((mark) => {
      const range = mark.kind === kind ? rangeForAnchor(root, mark.anchor) : null;
      return range ? [range] : [];
    });
    if (ranges.length === 0) continue;
    const highlight = new Highlight(...ranges);
    if (kind === "focus") highlight.priority = 1;
    CSS.highlights.set(name, highlight);
    painted.push([name, highlight]);
  }
  return () => {
    for (const [name, highlight] of painted) {
      if (CSS.highlights.get(name) === highlight) CSS.highlights.delete(name);
    }
  };
}

/** Scrolls the plan to an annotation's text. */
export function revealPlanAnchor(root: HTMLElement, anchor: PlanTextAnchor): void {
  const start = rangeForAnchor(root, anchor)?.startContainer;
  (start instanceof Element ? start : start?.parentElement)?.scrollIntoView({ block: "center" });
}

/** The first of `anchors` whose text covers a click at the viewport point. */
export function planAnchorIndexAtPoint(
  root: HTMLElement,
  anchors: ReadonlyArray<PlanTextAnchor | undefined>,
  point: { readonly x: number; readonly y: number },
): number {
  return anchors.findIndex((anchor) => {
    const range = anchor ? rangeForAnchor(root, anchor) : null;
    return Array.from(range?.getClientRects() ?? []).some(
      (rect) =>
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom,
    );
  });
}
