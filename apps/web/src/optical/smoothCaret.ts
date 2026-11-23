import { OPTICAL_SETTINGS_EVENT, prefersReducedMotion } from "./motionEngine";

const EDITOR_SELECTOR = '[data-testid="composer-editor"]';
const CARET_CLASS = "optical-smooth-caret";
const CARET_SELECTOR = `:scope > .${CARET_CLASS}`;
const NATIVE_HIDDEN_ATTR = "data-optical-smooth-caret";
const HOST_ATTR = "data-optical-caret-host";
const VISIBLE_ATTR = "data-optical-caret-visible";
const TYPING_ATTR = "data-optical-caret-typing";
const BLINK_ANIMATION = "optical-caret-blink";
const TYPING_HOLD_MS = 420;
const MIN_CARET_HEIGHT_PX = 15;
const MAX_PROBE_HEIGHT_PX = 36;

export interface SmoothCaretQueueOptions {
  /** Holds the caret steady (no blink) for a moment, as a native caret does while typing. */
  readonly typing?: boolean;
  /** Measures and writes now instead of on the next frame. */
  readonly immediate?: boolean;
  /** Re-reads font and padding metrics for the editor. */
  readonly refreshMetrics?: boolean;
  /** The editor scrolled, so its scroll offsets must be re-read. */
  readonly scroll?: boolean;
}

export interface SmoothCaretController {
  readonly start: () => void;
  readonly teardown: () => void;
  readonly bumpMetricsEpoch: () => void;
  readonly queue: (options?: SmoothCaretQueueOptions) => void;
}

interface EditorMetrics {
  readonly paddingLeft: number;
  readonly lineHeight: number;
  readonly glyphHeight: number;
  readonly emptyTopOffset: number;
  readonly epoch: number;
}

interface CaretBox {
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

interface EmptyProbe {
  readonly dx: number;
  readonly dy: number;
  readonly height: number;
  readonly epoch: number;
}

interface SelectionSignature {
  readonly epoch: number;
  readonly rangeCount: number;
  readonly collapsed: boolean;
  readonly focusNode: Node | null;
  readonly focusOffset: number;
  readonly childCount: number;
  readonly textSig: number;
  readonly editorScrollLeft: number;
  readonly editorScrollTop: number;
  readonly hostScrollLeft: number;
  readonly hostScrollTop: number;
  readonly hidden: boolean;
}

interface CaretSnapshot {
  readonly editor: HTMLElement;
  readonly host: HTMLElement;
  /** Null hides the custom caret and gives the native one back. */
  readonly placement: {
    readonly box: CaretBox;
    readonly hostRect: DOMRect;
    readonly clientLeft: number;
    readonly clientTop: number;
    readonly scrollLeft: number;
    readonly scrollTop: number;
    readonly empty: boolean;
    readonly scrolledOnly: boolean;
  } | null;
}

interface CaretState {
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly empty: boolean;
}

function snapDevicePx(value: number, devicePixelRatio = 1): number {
  const input = Number.isFinite(value) ? value : 0;
  const ratio =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(4, devicePixelRatio) : 1;
  return Number((Math.round(input * ratio) / ratio).toFixed(3));
}

const hasOrigin = (rect: DOMRect) => rect.left > 0 || rect.top > 0;

const isLineBreak = (node: Node | null | undefined): node is HTMLBRElement =>
  node?.nodeName === "BR";

/** ProseMirror renders an empty document as one block holding only its trailing `<br>`. */
function isEditorEmpty(editor: HTMLElement): boolean {
  if (editor.childElementCount > 1) return false;
  const block = editor.firstElementChild;
  if (!block) return true;
  return (
    block.childNodes.length === 0 ||
    (block.childNodes.length === 1 && isLineBreak(block.firstChild))
  );
}

function isSmoothCaretEnabled(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.opticalSmoothCaret === "1" && !prefersReducedMotion();
}

/**
 * Draws a gliding caret over the composer's ProseMirror editor. Each frame reads layout in
 * one pass and writes styles in a second, so a caret move never forces a reflow. The native
 * caret is hidden only while the custom one is visible, and returns during IME composition.
 */
export function createSmoothCaretController(): SmoothCaretController {
  let started = false;
  let frame = 0;
  let typingTimer = 0;
  let typingCaret: HTMLElement | null = null;
  let pendingTyping = false;
  let pendingRefresh = false;
  let pendingScroll = false;
  let composing = false;
  let metricsEpoch = 1;
  let reducedMotionQuery: MediaQueryList | null = null;

  const shownEditors = new Set<HTMLElement>();
  const hosts = new Set<HTMLElement>();
  const metricsCache = new WeakMap<HTMLElement, EditorMetrics>();
  let emptyProbeCache = new WeakMap<HTMLElement, EmptyProbe>();
  const caretNodes = new WeakMap<HTMLElement, HTMLElement>();
  const caretStates = new WeakMap<HTMLElement, CaretState>();
  const signatures = new WeakMap<HTMLElement, SelectionSignature>();

  const focusedEditor = (): HTMLElement | null => {
    if (!document.hasFocus()) return null;
    const active = document.activeElement;
    return active instanceof HTMLElement ? active.closest<HTMLElement>(EDITOR_SELECTOR) : null;
  };

  const clearTyping = () => {
    if (typingTimer) window.clearTimeout(typingTimer);
    typingTimer = 0;
    typingCaret?.removeAttribute(TYPING_ATTR);
    typingCaret = null;
  };

  const restoreNativeCarets = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pendingTyping = false;
    pendingRefresh = false;
    pendingScroll = false;
    clearTyping();
    for (const editor of shownEditors) editor.removeAttribute(NATIVE_HIDDEN_ATTR);
    shownEditors.clear();
    for (const host of hosts) {
      host.querySelector(CARET_SELECTOR)?.remove();
      host.removeAttribute(HOST_ATTR);
    }
    hosts.clear();
  };

  const bumpMetricsEpoch = () => {
    metricsEpoch += 1;
    emptyProbeCache = new WeakMap();
  };

  const readMetrics = (editor: HTMLElement, refresh: boolean): EditorMetrics => {
    const cached = metricsCache.get(editor);
    if (cached && !refresh && cached.epoch === metricsEpoch) return cached;
    const style = getComputedStyle(editor);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const fontSize = Number.parseFloat(style.fontSize) || 14;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
    const glyphHeight = Math.max(16, Math.min(24, Math.round(fontSize * 1.28)));
    const lineBox = Math.max(16, Math.min(28, lineHeight));
    const metrics: EditorMetrics = {
      paddingLeft,
      lineHeight,
      glyphHeight,
      emptyTopOffset: paddingTop + Math.max(0, Math.round((lineBox - glyphHeight) / 2)),
      epoch: metricsEpoch,
    };
    metricsCache.set(editor, metrics);
    return metrics;
  };

  const measureCaretBox = (
    editor: HTMLElement,
    range: Range | null,
    refresh: boolean,
  ): CaretBox | null => {
    const editorRect = editor.getBoundingClientRect();
    const metrics = readMetrics(editor, refresh);

    // The editor is its own scroll container; a caret scrolled out of it must not float outside.
    const withinViewport = (box: CaretBox): CaretBox | null => {
      const scrolls = editor.scrollHeight > editor.clientHeight + 2 && editorRect.height > 0;
      if (!scrolls) return box;
      const outside = box.top < editorRect.top - 4 || box.top + box.height > editorRect.bottom + 6;
      return outside ? null : box;
    };

    const rememberEmptyProbe = (box: CaretBox) => {
      if (box.height <= 0 || box.height >= MAX_PROBE_HEIGHT_PX || editorRect.height <= 0) return;
      emptyProbeCache.set(editor, {
        dx: box.left - editorRect.left,
        dy: box.top - editorRect.top,
        height: box.height,
        epoch: metricsEpoch,
      });
    };

    // A neighbouring block or inline atom gives an edge to stand at, centred on its first line.
    const besideElement = (element: Element, edge: "left" | "right"): CaretBox | null => {
      const rect = element.getBoundingClientRect();
      // ProseMirror's zero-height separator image sits on the baseline, which is not a line box.
      if (rect.height <= 0 || !hasOrigin(rect)) return null;
      const height = Math.min(metrics.glyphHeight, rect.height);
      const lineBox = Math.min(rect.height, Math.max(height, metrics.lineHeight));
      return { left: rect[edge], top: rect.top + Math.max(0, (lineBox - height) / 2), height };
    };

    if (range && editor.contains(range.startContainer)) {
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (rect && rect.height > 0 && hasOrigin(rect)) {
        return withinViewport({ left: rect.left, top: rect.top, height: rect.height });
      }

      // A collapsed range on an empty line has no rects; its `<br>` marks where the line is.
      const container = range.startContainer;
      const offset = range.startOffset;
      const emptyDocument = isEditorEmpty(editor);
      if (isLineBreak(container)) {
        const breakRect = container.getBoundingClientRect();
        if (breakRect.height > 0 && hasOrigin(breakRect)) {
          const box = { left: breakRect.left, top: breakRect.top, height: breakRect.height };
          if (emptyDocument) rememberEmptyProbe(box);
          return withinViewport(box);
        }
      }
      if (container instanceof Element) {
        const next = container.childNodes[offset];
        const previous = offset > 0 ? container.childNodes[offset - 1] : null;
        if (isLineBreak(next)) {
          const breakRect = next.getBoundingClientRect();
          if (breakRect.height > 0 && hasOrigin(breakRect)) {
            const box = { left: breakRect.left, top: breakRect.top, height: breakRect.height };
            if (emptyDocument) rememberEmptyProbe(box);
            return withinViewport(box);
          }
        }
        if (isLineBreak(previous)) {
          const breakRect = previous.getBoundingClientRect();
          if (breakRect.height > 0 && hasOrigin(breakRect)) {
            // Past a hard break the caret starts the next line; past the trailing break of an
            // otherwise empty block it is still on that block's only line.
            const sameLine =
              container.childNodes.length === 1 ||
              previous.classList.contains("ProseMirror-trailingBreak");
            const blockRect = container.getBoundingClientRect();
            const box = {
              left: sameLine
                ? breakRect.left
                : hasOrigin(blockRect)
                  ? blockRect.left
                  : breakRect.left,
              top: sameLine ? breakRect.top : breakRect.bottom,
              height: breakRect.height,
            };
            if (sameLine && emptyDocument) rememberEmptyProbe(box);
            return withinViewport(box);
          }
        }
        const beside =
          (next instanceof Element ? besideElement(next, "left") : null) ??
          (previous instanceof Element ? besideElement(previous, "right") : null) ??
          (container !== editor ? besideElement(container, "left") : null);
        if (beside) return withinViewport(beside);
      }
    }

    const probe = emptyProbeCache.get(editor);
    if (probe && probe.epoch === metricsEpoch) {
      return withinViewport({
        left: editorRect.left + probe.dx,
        top: editorRect.top + probe.dy,
        height: probe.height,
      });
    }
    return withinViewport({
      left: editorRect.left + metrics.paddingLeft,
      top: editorRect.top + metrics.emptyTopOffset,
      height: metrics.glyphHeight,
    });
  };

  /** Read phase: layout reads only, and none at all when the selection has not moved. */
  const measure = (refresh: boolean, checkScroll: boolean): CaretSnapshot[] => {
    const snapshots: CaretSnapshot[] = [];
    const focused = focusedEditor();

    for (const editor of shownEditors) {
      if (editor === focused && !composing) continue;
      signatures.delete(editor);
      const host = editor.parentElement;
      if (host) snapshots.push({ editor, host, placement: null });
      else shownEditors.delete(editor);
    }

    const host = focused?.parentElement;
    if (!focused || !host) return snapshots;
    if (composing) {
      signatures.delete(focused);
      return snapshots;
    }

    const selection = document.getSelection();
    const rangeCount = selection?.rangeCount ?? 0;
    const range = selection && rangeCount > 0 ? selection.getRangeAt(0) : null;
    const collapsed = range ? range.collapsed : true;
    const focusNode = range ? range.endContainer : null;
    const focusOffset = range ? range.endOffset : -1;
    const childCount = focused.childNodes.length;
    const textSig =
      focusNode instanceof CharacterData ? focusNode.length : (focusNode?.childNodes.length ?? 0);
    const previous = signatures.get(focused);
    const synced =
      previous !== undefined && (focused.hasAttribute(NATIVE_HIDDEN_ATTR) || previous.hidden);

    let sameSelection = false;
    if (!refresh && previous && synced) {
      sameSelection =
        previous.epoch === metricsEpoch &&
        previous.rangeCount === rangeCount &&
        previous.collapsed === collapsed &&
        previous.focusNode === focusNode &&
        previous.focusOffset === focusOffset &&
        previous.childCount === childCount &&
        previous.textSig === textSig;
      // Scroll offsets are layout reads; skip them unless a scroll was actually reported.
      if (sameSelection && !checkScroll) return snapshots;
    }

    const editorScrollLeft = focused.scrollLeft;
    const editorScrollTop = focused.scrollTop;
    const hostScrollLeft = host.scrollLeft;
    const hostScrollTop = host.scrollTop;
    let scrolledOnly = false;
    if (previous && sameSelection) {
      const sameScroll =
        previous.editorScrollLeft === editorScrollLeft &&
        previous.editorScrollTop === editorScrollTop &&
        previous.hostScrollLeft === hostScrollLeft &&
        previous.hostScrollTop === hostScrollTop;
      if (sameScroll) return snapshots;
      scrolledOnly = true;
    }

    const box = collapsed ? measureCaretBox(focused, range, refresh) : null;
    signatures.set(focused, {
      epoch: metricsEpoch,
      rangeCount,
      collapsed,
      focusNode,
      focusOffset,
      childCount,
      textSig,
      editorScrollLeft,
      editorScrollTop,
      hostScrollLeft,
      hostScrollTop,
      hidden: box === null,
    });
    snapshots.push({
      editor: focused,
      host,
      placement: box && {
        box,
        hostRect: host.getBoundingClientRect(),
        clientLeft: host.clientLeft,
        clientTop: host.clientTop,
        scrollLeft: hostScrollLeft,
        scrollTop: hostScrollTop,
        empty: isEditorEmpty(focused),
        scrolledOnly,
      },
    });
    return snapshots;
  };

  const resolveCaret = (host: HTMLElement): HTMLElement => {
    const cached = caretNodes.get(host);
    if (cached && cached.parentElement === host) return cached;
    let caret = host.querySelector<HTMLElement>(CARET_SELECTOR);
    if (!caret) {
      caret = document.createElement("div");
      caret.className = CARET_CLASS;
      caret.setAttribute("aria-hidden", "true");
      host.append(caret);
    }
    if (!hosts.has(host)) {
      for (const known of hosts) if (!known.isConnected) hosts.delete(known);
      hosts.add(host);
      host.setAttribute(HOST_ATTR, "1");
    }
    caretNodes.set(host, caret);
    return caret;
  };

  /** Write phase: style and attribute writes only. */
  const apply = (snapshots: ReadonlyArray<CaretSnapshot>, typing: boolean) => {
    for (const { editor, host, placement } of snapshots) {
      if (!placement) {
        const caret = caretNodes.get(host);
        if (caret === typingCaret) clearTyping();
        caret?.removeAttribute(VISIBLE_ATTR);
        editor.removeAttribute(NATIVE_HIDDEN_ATTR);
        shownEditors.delete(editor);
        continue;
      }

      const caret = resolveCaret(host);
      const ratio = window.devicePixelRatio || 1;
      const { box, hostRect } = placement;
      const x = snapDevicePx(
        box.left - hostRect.left - placement.clientLeft + placement.scrollLeft,
        ratio,
      );
      const y = snapDevicePx(
        box.top - hostRect.top - placement.clientTop + placement.scrollTop,
        ratio,
      );
      const height = Math.max(MIN_CARET_HEIGHT_PX, snapDevicePx(box.height || 18, ratio));
      const wasVisible = caret.getAttribute(VISIBLE_ATTR) === "1";
      const previous = caretStates.get(caret);
      const clearedToEmpty = previous?.empty === false && placement.empty;
      const moved = previous !== undefined && (previous.x !== x || previous.y !== y);

      // Appearing, clearing the prompt, and scrolling are jumps, not glides.
      if (!wasVisible || clearedToEmpty || placement.scrolledOnly) {
        caret.style.transition = "none";
        caret.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        caret.style.height = `${height}px`;
        requestAnimationFrame(() => {
          caret.style.transition = "";
        });
      } else {
        if (!previous || moved) caret.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (previous?.height !== height) caret.style.height = `${height}px`;
      }
      caretStates.set(caret, { x, y, height, empty: placement.empty });

      if (!wasVisible) caret.setAttribute(VISIBLE_ATTR, "1");
      if (!shownEditors.has(editor)) {
        shownEditors.add(editor);
        editor.setAttribute(NATIVE_HIDDEN_ATTR, "1");
      }
      if (typing) {
        if (typingCaret !== caret) clearTyping();
        if (typingTimer) window.clearTimeout(typingTimer);
        typingCaret = caret;
        caret.setAttribute(TYPING_ATTR, "1");
        typingTimer = window.setTimeout(clearTyping, TYPING_HOLD_MS);
      } else if (moved) {
        for (const animation of caret.getAnimations()) {
          if (animation instanceof CSSAnimation && animation.animationName === BLINK_ANIMATION) {
            animation.currentTime = 0;
          }
        }
      }
    }
  };

  const flush = () => {
    frame = 0;
    const typing = pendingTyping;
    const refresh = pendingRefresh;
    const scroll = pendingScroll;
    pendingTyping = false;
    pendingRefresh = false;
    pendingScroll = false;
    if (!isSmoothCaretEnabled()) {
      restoreNativeCarets();
      return;
    }
    apply(measure(refresh, scroll), typing);
  };

  const queue = (options: SmoothCaretQueueOptions = {}) => {
    if (!started) return;
    if (!isSmoothCaretEnabled()) {
      restoreNativeCarets();
      return;
    }
    if (shownEditors.size === 0 && !focusedEditor()) return;
    if (options.typing) pendingTyping = true;
    if (options.refreshMetrics) pendingRefresh = true;
    if (options.scroll) pendingScroll = true;
    if (options.immediate) {
      if (frame) cancelAnimationFrame(frame);
      flush();
      return;
    }
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const inEditor = (event: Event) =>
    event.target instanceof Element && event.target.closest(EDITOR_SELECTOR) !== null;

  const onTyping = (event: Event) => {
    if (inEditor(event)) queue({ typing: true });
  };
  const onSelection = () => queue();
  const onFocusIn = (event: Event) => {
    if (inEditor(event)) queue({ refreshMetrics: true });
  };
  // Hiding reads no layout, so a blur gives the native caret back at once. The extra frame
  // covers a window blur, where focus is only reported as lost after this event.
  const onFocusOut = () => {
    queue({ immediate: true });
    queue();
  };
  const onScroll = (event: Event) => {
    if (event.target instanceof Element && event.target.matches(EDITOR_SELECTOR)) {
      queue({ scroll: true });
    }
  };
  const onCompositionActive = () => {
    if (composing) return;
    composing = true;
    queue({ immediate: true });
  };
  const onCompositionEnd = () => {
    composing = false;
    queue({ typing: true });
  };
  const onResize = () => {
    bumpMetricsEpoch();
    queue({ refreshMetrics: true });
  };

  const documentListeners: ReadonlyArray<readonly [string, (event: Event) => void]> = [
    ["keyup", onTyping],
    ["input", onTyping],
    ["mouseup", onSelection],
    ["selectionchange", onSelection],
    ["focusin", onFocusIn],
    ["focusout", onFocusOut],
    ["compositionstart", onCompositionActive],
    ["compositionupdate", onCompositionActive],
    ["compositionend", onCompositionEnd],
  ];
  const scrollOptions = { capture: true, passive: true } as const;

  const start = () => {
    if (started || typeof document === "undefined") return;
    started = true;
    for (const [type, listener] of documentListeners) {
      document.addEventListener(type, listener, { passive: true });
    }
    document.addEventListener("scroll", onScroll, scrollOptions);
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener(OPTICAL_SETTINGS_EVENT, onResize);
    reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionQuery.addEventListener("change", onResize);
    queue({ refreshMetrics: true });
  };

  const teardown = () => {
    if (!started) return;
    started = false;
    composing = false;
    for (const [type, listener] of documentListeners) {
      document.removeEventListener(type, listener);
    }
    document.removeEventListener("scroll", onScroll, scrollOptions);
    window.removeEventListener("resize", onResize);
    window.removeEventListener(OPTICAL_SETTINGS_EVENT, onResize);
    reducedMotionQuery?.removeEventListener("change", onResize);
    reducedMotionQuery = null;
    restoreNativeCarets();
  };

  return { start, teardown, bumpMetricsEpoch, queue };
}
