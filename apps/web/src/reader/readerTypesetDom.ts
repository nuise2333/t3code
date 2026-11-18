import { observeResize } from "../lib/observeResize";
import type { InlineBox, InlineStyle, InlineView } from "./readerFlow";
import { ensureReaderFonts, READER_SERIF_FIGURES } from "./readerFonts";
import { createCachedMeasurer, type TextMeasurer } from "./typeset";
import { newYorkTracking, trackedGlyphCount } from "./typeset/tracking";

let measurer: TextMeasurer | null | undefined;
const trackingByFont = new Map<string, number>();
let inkContext: CanvasRenderingContext2D | null | undefined;
const figureInks = new Map<string, FigureInk | null>();

const READER_SERIF = "T3 Reader Serif";

/**
 * Per-glyph tracking the Latin face of `font` gets, in px. Only the bridged New York carries a
 * `trak` table among the reader's Latin faces; a fallback serif in its place is set untracked.
 */
export function readerTracking(font: string): number {
  let tracking = trackingByFont.get(font);
  if (tracking !== undefined) return tracking;
  const match = /(\d+(?:\.\d+)?)px\s+"?([^",]+)"?/.exec(font);
  const fontSize = Number(match?.[1] ?? 0);
  const isNewYork =
    match?.[2] === READER_SERIF &&
    [...document.fonts].some((face) => face.family === READER_SERIF && face.status === "loaded");
  tracking = isNewYork ? newYorkTracking(fontSize) : 0;
  trackingByFont.set(font, tracking);
  return tracking;
}

/** One canvas for every paragraph. Null where there is no 2D canvas to measure with. */
export function readerMeasurer(): TextMeasurer | null {
  if (measurer !== undefined) return measurer;
  const context = document.createElement("canvas").getContext("2d");
  if (context === null) return (measurer = null);
  let current = "";
  return (measurer = createCachedMeasurer((text, font) => {
    if (font !== current) {
      context.font = font;
      current = font;
    }
    return context.measureText(text).width + trackedGlyphCount(text) * readerTracking(font);
  }));
}

export interface FigureInk {
  /** Ink edges, in px from the pen origin. */
  readonly left: number;
  readonly right: number;
  readonly advance: number;
}

/** Ink of `text` in `font` with tabular figures, as list numbers are set; null without a canvas. */
export function readerFigureInk(text: string, font: string): FigureInk | null {
  const key = `${font}|${text}`;
  const known = figureInks.get(key);
  if (known !== undefined) return known;
  inkContext ??= document.createElement("canvas").getContext("2d");
  let ink: FigureInk | null = null;
  if (inkContext !== null) {
    inkContext.font = font.replace(
      `"${READER_SERIF}"`,
      `"${READER_SERIF_FIGURES}", "${READER_SERIF}"`,
    );
    const metrics = inkContext.measureText(text);
    ink = {
      left: -metrics.actualBoundingBoxLeft,
      right: metrics.actualBoundingBoxRight,
      advance: metrics.width,
    };
  }
  figureInks.set(key, ink);
  return ink;
}

let epoch = 0;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | undefined;

function invalidate(haveFontsChanged: boolean) {
  // The engine caches per measurer, and a measurer's answers change with the loaded fonts.
  if (haveFontsChanged) {
    measurer = undefined;
    trackingByFont.clear();
    figureInks.clear();
  }
  epoch += 1;
  for (const listener of listeners) listener();
}

function watch() {
  const root = document.documentElement;
  const signature = () =>
    [
      root.getAttribute("data-reader-typography"),
      root.getAttribute("data-reader-justify"),
      root.getAttribute("data-reader-limit-width"),
      root.style.getPropertyValue("--reader-font-size"),
      root.style.getPropertyValue("--reader-zoom"),
    ].join("|");
  let applied = signature();
  const settings = new MutationObserver(() => {
    const next = signature();
    if (next === applied) return;
    applied = next;
    invalidate(false);
  });
  settings.observe(root, {
    attributes: true,
    attributeFilter: [
      "data-reader-typography",
      "data-reader-justify",
      "data-reader-limit-width",
      "style",
    ],
  });

  const onFontsLoaded = () => invalidate(true);
  document.fonts.addEventListener("loadingdone", onFontsLoaded);
  // Faces registered already loaded announce nothing, so compare the set around the registration.
  const faces = document.fonts.size;
  let isWatching = true;
  void ensureReaderFonts().then(() => {
    if (isWatching && document.fonts.size !== faces) invalidate(true);
  });

  return () => {
    isWatching = false;
    // Unwatched, a font could load unnoticed: the next reader starts from fresh measurements.
    measurer = undefined;
    trackingByFont.clear();
    figureInks.clear();
    settings.disconnect();
    document.fonts.removeEventListener("loadingdone", onFontsLoaded);
  };
}

/** Changes whenever typeset lines may be stale: fonts finished loading, or a reader setting changed. */
export function subscribeReaderLayoutEpoch(listener: () => void): () => void {
  listeners.add(listener);
  stopWatching ??= watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopWatching?.();
    stopWatching = undefined;
  };
}

export const readerLayoutEpoch = () => epoch;

const pixels = (value: string) => Number.parseFloat(value) || 0;

// Rects are in viewport px, so they include the reader's view zoom; fonts and lengths do not.
const zoomOf = (element: Element) =>
  (element as Element & { readonly currentCSSZoom?: number }).currentCSSZoom ?? 1;

export function inlineStyleOf(style: CSSStyleDeclaration): InlineStyle {
  const fontSize = pixels(style.fontSize);
  return {
    font: `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`,
    fontSize,
    isItalic: style.fontStyle !== "normal",
  };
}

const collapsesSpace = (style: CSSStyleDeclaration) =>
  style.whiteSpace === "normal" || style.whiteSpace === "nowrap";

/** Whether the browser sets this block's text the plain way the engine reproduces. */
export function isPlainTextBlock(style: CSSStyleDeclaration) {
  return (
    style.direction === "ltr" &&
    collapsesSpace(style) &&
    (style.letterSpacing === "normal" || pixels(style.letterSpacing) === 0) &&
    pixels(style.wordSpacing) === 0
  );
}

function boxOf(node: Node, tagName: string): InlineBox {
  if (!(node instanceof Element)) return { kind: "unsupported" };
  const style = getComputedStyle(node);
  if (style.position === "absolute" || style.position === "fixed") return { kind: "outOfFlow" };
  const sideWidth =
    pixels(style.paddingLeft) +
    pixels(style.paddingRight) +
    pixels(style.borderLeftWidth) +
    pixels(style.borderRightWidth);
  const margins = pixels(style.marginLeft) + pixels(style.marginRight);
  if (
    node.localName === tagName &&
    style.display === "inline" &&
    sideWidth === 0 &&
    margins === 0 &&
    collapsesSpace(style)
  ) {
    return { kind: "wrapper", style: inlineStyleOf(style) };
  }
  if (!style.display.startsWith("inline")) return { kind: "unsupported" };
  // An inline box the browser broke across lines has one rect per line.
  let width = 0;
  for (const rect of node.getClientRects()) width += rect.width;
  return { kind: "atom", advance: width / zoomOf(node) + margins };
}

export const renderedInlineView: InlineView<Node> = {
  children: (parent) => parent.childNodes,
  text: (node) => (node instanceof Text ? node.data : undefined),
  box: boxOf,
};

/** Width of an atom's wrapper in a typeset line, which holds the atom and its margins. */
export function atomWidth(wrapper: Element) {
  return wrapper.getBoundingClientRect().width / zoomOf(wrapper);
}

/** Content width of the block the lines are set in. */
export function columnWidth(box: Element) {
  const style = getComputedStyle(box);
  return (
    box.getBoundingClientRect().width / zoomOf(box) -
    pixels(style.paddingLeft) -
    pixels(style.paddingRight) -
    pixels(style.borderLeftWidth) -
    pixels(style.borderRightWidth)
  );
}

// How far outside the scrolled view a paragraph is set ahead of being seen, in view heights.
const AHEAD = 1.5;

export function isNearViewport(element: Element) {
  if (typeof IntersectionObserver === "undefined") return true;
  const rect = element.getBoundingClientRect();
  const reach = window.innerHeight * AHEAD;
  return rect.bottom > -reach && rect.top < window.innerHeight + reach;
}

interface NearObserver {
  readonly observer: IntersectionObserver;
  // A list item's stretches of text share the item as their box.
  readonly callbacks: Map<Element, Set<(isNear: boolean) => void>>;
}

const scrollers = new WeakMap<Element, Element | null>();
const nearObservers = new WeakMap<Element | Document, NearObserver>();

function scrollerOf(element: Element): Element | null {
  const reader = element.closest(".markdown-reader") ?? element;
  const known = scrollers.get(reader);
  if (known !== undefined) return known;
  let scroller: Element | null = null;
  for (let node = reader.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    scroller = node;
    break;
  }
  scrollers.set(reader, scroller);
  return scroller;
}

/**
 * Reports when the reader's column may have changed width. It watches the scrolled view, not
 * the reader: setting lines changes the reader's height, and an observer whose callback
 * resizes its own target is cut off by the browser with a loop error.
 */
export function observeColumn(element: Element, callback: () => void): () => void {
  const scroller = scrollerOf(element);
  if (scroller !== null) return observeResize(scroller, callback);
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

/**
 * Reports when the element comes within reach of its scrolled view, and when it leaves. The
 * first report arrives a frame late, so a caller that cannot wait asks `isNearViewport`.
 */
export function observeNearViewport(
  element: Element,
  callback: (isNear: boolean) => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  const scroller = scrollerOf(element);
  const key = scroller ?? document;
  let near = nearObservers.get(key);
  if (near === undefined) {
    const callbacks: NearObserver["callbacks"] = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          for (const notify of callbacks.get(entry.target) ?? []) notify(entry.isIntersecting);
        }
      },
      { root: scroller, rootMargin: `${AHEAD * 100}% 0px` },
    );
    near = { observer, callbacks };
    nearObservers.set(key, near);
  }
  const { observer, callbacks } = near;
  const shared = callbacks.get(element);
  if (shared === undefined) {
    callbacks.set(element, new Set([callback]));
    observer.observe(element);
  } else {
    shared.add(callback);
  }
  return () => {
    const remaining = callbacks.get(element);
    remaining?.delete(callback);
    if (remaining?.size !== 0) return;
    callbacks.delete(element);
    observer.unobserve(element);
  };
}
