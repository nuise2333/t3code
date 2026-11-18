import { observeResize } from "~/lib/observeResize";

import { type LineSlot, mergeLineRects, padLineSlots, pageTarget } from "./readerPaging";
import {
  anchorScrollTop,
  type AnchorTree,
  firstEndingAfter,
  locateAnchor,
  type ReadingAnchor,
} from "./readingAnchor";

const MAX_POSITIONS = 50;
// Tab switches unmount the reader; keep the most recent documents' places.
const positions = new Map<string, ReadingAnchor>();

const SETTLE_MS = 120;

const CONTAINER_TAGS = new Set([
  "ASIDE",
  "BLOCKQUOTE",
  "DETAILS",
  "DIV",
  "DL",
  "FIGURE",
  "LI",
  "OL",
  "SECTION",
  "TABLE",
  "TBODY",
  "TFOOT",
  "THEAD",
  "UL",
]);
const ATOMIC_TAGS = new Set(["CANVAS", "IFRAME", "IMG", "PICTURE", "VIDEO", "svg"]);
const ATOMIC_SELECTOR = ".katex, .reader-atom";

// Keys pressed here keep their own meaning.
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"], [role="slider"]';
// The Markdown file editor: keys type, but the page keys still page.
const READER_EDITOR_SELECTOR = "[data-reader-editor]";
const ACTIVATES_ON_SPACE_SELECTOR =
  'audio, button, summary, video, [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="menuitem"], [role="option"], [role="tab"]';

function rememberPosition(key: string, anchor: ReadingAnchor) {
  positions.delete(key);
  positions.set(key, anchor);
  const oldest = positions.keys().next();
  if (positions.size > MAX_POSITIONS && !oldest.done) positions.delete(oldest.value);
}

function contentOrigin(viewport: HTMLElement) {
  return viewport.getBoundingClientRect().top - viewport.scrollTop;
}

function anchorTree(origin: number): AnchorTree<Element> {
  return {
    children: (node) => node.children,
    box: (node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return null;
      return { top: rect.top - origin, bottom: rect.bottom - origin };
    },
    isContainer: (node) => CONTAINER_TAGS.has(node.tagName),
  };
}

/** The lines of everything drawn between `top` and `bottom`, in the content's coordinates. */
function lineSlotsBetween(root: Element, origin: number, top: number, bottom: number) {
  const rects: LineSlot[] = [];
  const range = document.createRange();
  const add = (rect: DOMRect) => {
    const slot = { top: rect.top - origin, bottom: rect.bottom - origin };
    if (rect.width > 0 && slot.bottom > top && slot.top < bottom) rects.push(slot);
  };
  const accept = (node: Node) => {
    if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT;
    const rect = node.getBoundingClientRect();
    // `display: contents` wrappers have no box of their own but draw their children.
    if (rect.width === 0 && rect.height === 0) return NodeFilter.FILTER_SKIP;
    if (rect.bottom - origin <= top || rect.top - origin >= bottom) {
      return NodeFilter.FILTER_REJECT;
    }
    if (ATOMIC_TAGS.has(node.tagName) || node.matches(ATOMIC_SELECTOR)) {
      add(rect);
      return NodeFilter.FILTER_REJECT;
    }
    return NodeFilter.FILTER_SKIP;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: accept,
  });
  const blocks = root.children;
  const box = (node: Element) => {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { top: rect.top - origin, bottom: rect.bottom - origin };
  };
  const first = firstEndingAfter(blocks, box, top);
  if (first < 0) return [];
  for (let index = first; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) break;
    const blockBox = box(block);
    if (blockBox !== null && blockBox.top >= bottom) break;
    if (accept(block) === NodeFilter.FILTER_REJECT) continue;
    walker.currentNode = block;
    for (
      let node = walker.nextNode();
      node !== null && block.contains(node);
      node = walker.nextNode()
    ) {
      if (!(node instanceof Text) || !node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) add(rect);
    }
  }
  return mergeLineRects(rects);
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function pageKeyDirection(event: KeyboardEvent): "down" | "up" | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return null;
  if (event.key === "PageDown") return "down";
  if (event.key === "PageUp") return "up";
  if (event.key === " ") return event.shiftKey ? "up" : "down";
  return null;
}

/**
 * Paging keys and the remembered reading position for one reader view. `content` is the
 * rendered document inside the scrolled `viewport`.
 */
export function attachReaderScroll(input: {
  readonly viewport: HTMLElement;
  readonly content: HTMLElement;
  readonly positionKey: string | undefined;
}): () => void {
  const { viewport, content, positionKey } = input;
  let anchor = positionKey === undefined ? undefined : positions.get(positionKey);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let appliedScrollTop = Number.NaN;
  // Where the view was when `anchor` described it; a view moved since then has a newer place.
  let anchoredAt = Number.NaN;
  let pageBase: number | null = null;

  const documentRoot = () =>
    content.querySelector<HTMLElement>(".chat-markdown.markdown-reader") ?? content;

  const capture = () => {
    if (viewport.clientHeight === 0 || !viewport.isConnected) return;
    const origin = contentOrigin(viewport);
    anchor = locateAnchor(anchorTree(origin), documentRoot(), viewport.scrollTop);
    anchoredAt = viewport.scrollTop;
    if (positionKey !== undefined) rememberPosition(positionKey, anchor);
  };

  const apply = () => {
    if (anchor === undefined || viewport.clientHeight === 0) return;
    const origin = contentOrigin(viewport);
    const top = Math.round(anchorScrollTop(anchorTree(origin), documentRoot(), anchor));
    if (Math.abs(viewport.scrollTop - top) >= 1) {
      viewport.scrollTop = top;
      appliedScrollTop = viewport.scrollTop;
    }
    anchoredAt = viewport.scrollTop;
  };

  const settle = () => {
    settleTimer = undefined;
    pageBase = null;
    capture();
  };

  const scheduleSettle = () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  };

  const onScroll = () => {
    if (Math.abs(viewport.scrollTop - appliedScrollTop) < 1) return;
    appliedScrollTop = Number.NaN;
    scheduleSettle();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const direction = pageKeyDirection(event);
    const focused = event.target;
    if (direction === null || !(focused instanceof Element)) return;
    const editor = event.key === " " ? null : focused.closest<HTMLElement>(READER_EDITOR_SELECTOR);
    if (editor === null && focused.closest(EDITABLE_SELECTOR)) return;
    if (event.key === " " && focused !== viewport && focused.closest(ACTIVATES_ON_SPACE_SELECTOR)) {
      return;
    }
    event.preventDefault();
    const viewportHeight = viewport.clientHeight;
    const scrollTop = pageBase ?? viewport.scrollTop;
    const origin = contentOrigin(viewport);
    const half = viewportHeight / 2;
    const [bandTop, bandBottom] =
      direction === "down"
        ? [scrollTop + half, scrollTop + viewportHeight]
        : [scrollTop, scrollTop + half];
    const style = getComputedStyle(documentRoot());
    // Rects come zoomed; the computed line height does not.
    const zoom = Number.parseFloat(style.zoom) || 1;
    const lineHeight = (Number.parseFloat(style.lineHeight) || 24) * zoom;
    const lines = padLineSlots(
      lineSlotsBetween(documentRoot(), origin, bandTop, bandBottom),
      lineHeight,
    );
    const target = pageTarget({
      direction,
      scrollTop,
      viewportHeight,
      maxScrollTop: viewport.scrollHeight - viewportHeight,
      lines,
      fallbackOverlap: lineHeight * 2,
    });
    if (target === null) return;
    const jumps = event.repeat || prefersReducedMotion() || editor !== null;
    pageBase = jumps ? null : target;
    const caretX = editor === null ? null : caretLeft();
    viewport.scrollTo({ top: target, behavior: jumps ? "instant" : "smooth" });
    if (editor !== null) placeCaret(editor, viewport, caretX, lineHeight);
  };

  apply();
  viewport.addEventListener("scroll", onScroll, { passive: true });
  viewport.addEventListener("keydown", onKeyDown);
  // A paragraph set later, a font arriving or a new width moves the anchored line; between
  // scrolls, put it back. While the reader is scrolling, its own position is the newer one.
  const stopResize = observeResize([viewport, content], () => {
    if (settleTimer !== undefined) return;
    // A jump whose scroll event has not arrived yet leaves the anchor behind.
    if (Math.abs(viewport.scrollTop - anchoredAt) >= 1) scheduleSettle();
    else apply();
  });
  return () => {
    clearTimeout(settleTimer);
    stopResize();
    viewport.removeEventListener("scroll", onScroll);
    viewport.removeEventListener("keydown", onKeyDown);
    // Untouched since a restore, the view may still be short of the anchor (a page not yet
    // laid out to full height); the anchor is the truer place.
    const isRestored = Math.abs(viewport.scrollTop - appliedScrollTop) < 1;
    if (isRestored && anchor !== undefined && positionKey !== undefined) {
      rememberPosition(positionKey, anchor);
    } else {
      capture();
    }
  };
}

/** The caret's left edge in the viewport, or null without a caret. */
function caretLeft(): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const rects = selection.getRangeAt(0).getClientRects();
  return rects[0]?.left ?? null;
}

/**
 * After a page in the editor, the caret goes to the first line wholly in view, at the column
 * it had; the editor picks the new selection up from the document.
 */
function placeCaret(editor: HTMLElement, viewport: HTMLElement, x: number | null, line: number) {
  const top = viewport.getBoundingClientRect().top;
  const left = x ?? editor.getBoundingClientRect().left + 1;
  for (const y of [top + line * 0.5, top + line * 1.5]) {
    const position = document.caretPositionFromPoint?.(left, y);
    if (!position || !editor.contains(position.offsetNode)) continue;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (rect.top < top - 1) continue;
    window.getSelection()?.collapse(position.offsetNode, position.offset);
    return;
  }
}

export function scrollReaderTo(viewport: HTMLElement, element: Element) {
  const top = element.getBoundingClientRect().top - contentOrigin(viewport);
  viewport.scrollTo({ top: Math.max(0, Math.round(top)), behavior: "instant" });
}
