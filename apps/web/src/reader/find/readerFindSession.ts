import { stepThreadFindIndex } from "~/components/chat/threadFind";

import {
  findInReaderChunk,
  indexReaderFindText,
  readerFindQuery,
  type ReaderFindChunk,
  type ReaderFindView,
} from "./readerFindIndex";

const HIGHLIGHT_NAME = "t3-reader-find";
const ACTIVE_HIGHLIGHT_NAME = "t3-reader-find-active";
// Not the document's text: block chrome, the language label, navigation beside the document,
// screen-reader-only headings and KaTeX's MathML twin of the drawn formula.
const SKIPPED_SELECTOR =
  'svg, nav, [data-thread-find-ignore], [role="toolbar"], .select-none, .sr-only, .katex-mathml';
const FOLD_SELECTOR = "[hidden], [data-thread-find-fold]";
/** Room the find bar takes over the top of the document. */
const TOP_CLEARANCE = 56;
const BOTTOM_CLEARANCE = 16;

const DOM_VIEW: ReaderFindView<Node> = {
  children: (node) => node.childNodes,
  text: (node) => (node.nodeType === Node.TEXT_NODE ? (node as Text).data : undefined),
  tagName: (node) =>
    node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName.toLowerCase() : undefined,
  isSkipped: (node) => node instanceof Element && node.matches(SKIPPED_SELECTOR),
};

export interface ReaderFindState {
  readonly count: number;
  readonly active: number;
}

function foldsHiding(range: Range, container: HTMLElement): Element[] {
  const folds: Element[] = [];
  for (
    let fold = range.startContainer.parentElement?.closest(FOLD_SELECTOR);
    fold && container.contains(fold);
    fold = fold.parentElement?.closest(FOLD_SELECTOR)
  ) {
    if (
      fold.hasAttribute("hidden") ||
      range.getBoundingClientRect().bottom > fold.getBoundingClientRect().bottom
    )
      folds.push(fold);
  }
  return folds;
}

const isLaidOut = (rect: DOMRect) => rect.width > 0 || rect.height > 0;

/**
 * Find over one rendered document: the text index, its CSS highlights and the scroll position
 * of the current match. The index is built once and kept current block by block as the
 * document changes underneath (a paragraph being typeset, a fold opening); a new query only
 * searches the indexed text.
 */
export function createReaderFindSession(
  container: HTMLElement,
  onChange: (state: ReaderFindState) => void,
) {
  const document = container.ownerDocument;
  const canPaint = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";
  const inactive = canPaint ? new Highlight() : null;
  const current = canPaint ? new Highlight() : null;
  if (inactive && current) {
    CSS.highlights.set(HIGHLIGHT_NAME, inactive);
    CSS.highlights.set(ACTIVE_HIGHLIGHT_NAME, current);
  }

  let chunks: Array<ReaderFindChunk<Node>> = [];
  let leaves = new Set<Node>();
  let rangesByChunk: Array<Array<Range>> = [];
  let ranges: Array<Range> = [];
  let query = "";
  let active = 0;
  /** A fold was asked to open for the current match, which is scrolled to once it has. */
  let isRevealing = false;

  const rangesOf = (chunk: ReaderFindChunk<Node>) =>
    findInReaderChunk(chunk, query).map((match) => {
      const range = document.createRange();
      range.setStart(match.start.node, match.start.offset);
      range.setEnd(match.end.node, match.end.offset);
      return range;
    });

  const index = () => {
    const built = indexReaderFindText<Node>(container, DOM_VIEW);
    chunks = [...built.chunks];
    leaves = new Set(built.leaves);
    rangesByChunk = chunks.map(rangesOf);
  };

  const scrollTo = (range: Range) => {
    const viewport = container.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const rect = range.getBoundingClientRect();
    if (viewport === null || !isLaidOut(rect)) return;
    const view = viewport.getBoundingClientRect();
    if (rect.top >= view.top + TOP_CLEARANCE && rect.bottom <= view.bottom - BOTTOM_CLEARANCE)
      return;
    viewport.scrollTop += rect.top + rect.height / 2 - (view.top + view.height / 2);
  };

  /** Moves the current-match highlight, opening folds around it first. */
  const selectActive = (scroll: boolean) => {
    current?.clear();
    const selected = ranges[active];
    if (selected === undefined) return;
    inactive?.delete(selected);
    const folds = foldsHiding(selected, container);
    if (folds.length > 0) {
      isRevealing = true;
      for (const fold of folds) fold.dispatchEvent(new Event("beforematch"));
      return;
    }
    current?.add(selected);
    if (scroll || isRevealing) scrollTo(selected);
    isRevealing = false;
  };

  const paint = (scroll: boolean) => {
    ranges = rangesByChunk.flat();
    active = ranges.length === 0 ? 0 : Math.min(active, ranges.length - 1);
    inactive?.clear();
    if (inactive) {
      for (const range of ranges) {
        if (foldsHiding(range, container).length === 0) inactive.add(range);
      }
    }
    selectActive(scroll);
    onChange({ count: ranges.length, active });
  };

  /** The first match at or below the top of the view, so typing does not jump back to the start. */
  const firstInView = () => {
    const viewport = container.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (viewport === null) return 0;
    const top = viewport.getBoundingClientRect().top;
    const found = ranges.findIndex((range) => {
      const rect = range.getBoundingClientRect();
      return isLaidOut(rect) && rect.bottom >= top;
    });
    return Math.max(found, 0);
  };

  const reindexChanged = (records: ReadonlyArray<MutationRecord>) => {
    const dirty = new Set<Node>();
    let isFullRebuild = false;
    let changesText = false;
    for (const record of records) {
      if (record.type === "attributes") continue;
      changesText = true;
      let node: Node | null = record.target;
      while (node !== null && node !== container && !leaves.has(node)) node = node.parentNode;
      if (node === null || node === container) {
        isFullRebuild = true;
        break;
      }
      dirty.add(node);
    }
    if (!changesText) return;
    if (isFullRebuild || [...dirty].some((leaf) => !container.contains(leaf))) {
      index();
      return;
    }
    for (const leaf of dirty) {
      const from = chunks.findIndex((chunk) => chunk.owner === leaf);
      if (from === -1) continue;
      let to = from;
      while (chunks[to]?.owner === leaf) to += 1;
      const isInPre = leaf instanceof Element && leaf.closest("pre") !== null;
      const fresh = indexReaderFindText<Node>(leaf, DOM_VIEW, isInPre).chunks;
      chunks.splice(from, to - from, ...fresh);
      rangesByChunk.splice(from, to - from, ...fresh.map(rangesOf));
      if (fresh.length === 0) leaves.delete(leaf);
    }
  };

  let frame: number | null = null;
  let pending: Array<MutationRecord> = [];
  const observer = new MutationObserver((records) => {
    pending.push(...records);
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const records = pending;
      pending = [];
      reindexChanged(records);
      if (query !== "") paint(false);
    });
  });
  observer.observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden", "data-thread-find-fold"],
  });
  index();

  return {
    /** The current match, if any. */
    activeRange(): Range | null {
      return ranges[active] ?? null;
    },
    setQuery(next: string) {
      query = readerFindQuery(next);
      rangesByChunk = chunks.map(rangesOf);
      ranges = rangesByChunk.flat();
      active = firstInView();
      isRevealing = false;
      paint(true);
    },
    step(delta: number) {
      if (ranges.length === 0) return;
      const previous = ranges[active];
      active = stepThreadFindIndex(active, ranges.length, delta);
      if (previous && foldsHiding(previous, container).length === 0) inactive?.add(previous);
      selectActive(true);
      onChange({ count: ranges.length, active });
    },
    dispose() {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      if (canPaint) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
        CSS.highlights.delete(ACTIVE_HIGHLIGHT_NAME);
      }
    },
  };
}

export type ReaderFindSession = ReturnType<typeof createReaderFindSession>;
