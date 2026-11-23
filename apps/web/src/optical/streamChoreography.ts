import { type RefObject, useEffect, useRef } from "react";

import { getMotionTier, type MotionTier, OPTICAL_SETTINGS_EVENT } from "./motionEngine";

export const HIGHLIGHT_NAMES = [
  "t3-stream-f0",
  "t3-stream-f1",
  "t3-stream-f2",
  "t3-stream-f3",
  "t3-stream-f4",
] as const;
export const STREAM_FADE_STEP_MS = 60;
export const STREAM_FADE_MS = 300;
export const MAX_FADE_RANGES = 48;
export const MERGE_WINDOW_MS = 64;

const LAST_BUCKET = HIGHLIGHT_NAMES.length - 1;
const STREAM_BATCH_MS = 52;
const CHUNK_CLASS = "optical-stream-chunk";
const CODE_SCAN_CLASS = "optical-code-scan";
// Each class outlives its animation (300ms and 180ms) so a late timer never clips the last frame.
const CHUNK_HOLD_MS = 310;
const CODE_SCAN_HOLD_MS = 240;
const MAX_NEW_BLOCKS_PER_BATCH = 4;
const MAX_UNSEEN_APPEND_CHARS = 28;
const CAUSTIC_ATTR = "data-optical-caustic";
const CAUSTIC_HOLD_MS = 920;
const IGNORE_SELECTOR = "[data-optical-ignore], script, style";
const TAIL_HOST_ATTR = "data-optical-tail-host";
const CONTEXT_SELECTOR = `pre, table, .${CHUNK_CLASS}`;
const OBSERVE_OPTIONS = { childList: true, characterData: true, subtree: true } as const;

const INLINE_TAGS: ReadonlySet<string> = new Set([
  "SPAN",
  "STRONG",
  "EM",
  "B",
  "I",
  "A",
  "CODE",
  "MARK",
  "DEL",
  "SUB",
  "SUP",
]);
const PROSE_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "P",
  "UL",
  "OL",
  "LI",
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

export interface FadeEntry<TNode> {
  readonly node: TNode;
  readonly start: number;
  end: number;
  /** Index into HIGHLIGHT_NAMES: 0 is the faintest ink, 4 is nearly settled. */
  bucket: number;
  readonly startedAt: number;
}

export interface FadeBucketState<TNode> {
  readonly entries: FadeEntry<TNode>[];
  /** When the earliest entry next changes bucket or expires; 0 when nothing is pending. */
  nextDueAt: number;
}

export type FadeEnqueueResult<TNode> =
  | { readonly kind: "rejected" }
  | { readonly kind: "merged"; readonly entry: FadeEntry<TNode> }
  | {
      readonly kind: "added";
      readonly entry: FadeEntry<TNode>;
      readonly evicted: FadeEntry<TNode> | null;
    };

export interface FadeAdvanceResult<TNode> {
  readonly moved: ReadonlyArray<{
    readonly entry: FadeEntry<TNode>;
    readonly from: number;
    readonly to: number;
  }>;
  readonly expired: ReadonlyArray<FadeEntry<TNode>>;
}

export const createFadeBucketState = <TNode>(): FadeBucketState<TNode> => ({
  entries: [],
  nextDueAt: 0,
});

export const isStreamInkTier = (tier: MotionTier): boolean =>
  tier === "standard" || tier === "ultra";

/**
 * Starts fading `[start, end)` of a text node. A slice that continues the newest entry on the
 * same node within the merge window extends it instead, and the oldest entry is evicted at
 * the cap, so a fast stream never grows the range list.
 */
export function enqueueFadeEntry<TNode>(
  state: FadeBucketState<TNode>,
  node: TNode,
  start: number,
  end: number,
  now: number,
): FadeEnqueueResult<TNode> {
  if (start < 0 || end <= start) return { kind: "rejected" };
  const newest = state.entries.at(-1);
  if (
    newest &&
    newest.node === node &&
    newest.end === start &&
    now - newest.startedAt <= MERGE_WINDOW_MS
  ) {
    newest.end = end;
    return { kind: "merged", entry: newest };
  }
  const evicted = state.entries.length >= MAX_FADE_RANGES ? (state.entries.shift() ?? null) : null;
  const entry: FadeEntry<TNode> = { node, start, end, bucket: 0, startedAt: now };
  state.entries.push(entry);
  const due = now + STREAM_FADE_STEP_MS;
  if (state.nextDueAt === 0 || due < state.nextDueAt) state.nextDueAt = due;
  return { kind: "added", entry, evicted };
}

/** Promotes each entry to the bucket its age has reached and expires those past the fade. */
export function advanceFadeBuckets<TNode>(
  state: FadeBucketState<TNode>,
  now: number,
  isLive: (entry: FadeEntry<TNode>) => boolean = () => true,
): FadeAdvanceResult<TNode> {
  const moved: Array<{ entry: FadeEntry<TNode>; from: number; to: number }> = [];
  const expired: FadeEntry<TNode>[] = [];
  let kept = 0;
  let earliestDue = Infinity;
  for (const entry of state.entries) {
    const age = Math.max(0, now - entry.startedAt);
    if (age >= STREAM_FADE_MS || !isLive(entry)) {
      expired.push(entry);
      continue;
    }
    const bucket = Math.min(LAST_BUCKET, Math.floor(age / STREAM_FADE_STEP_MS));
    if (bucket !== entry.bucket) {
      moved.push({ entry, from: entry.bucket, to: bucket });
      entry.bucket = bucket;
    }
    earliestDue = Math.min(earliestDue, entry.startedAt + (bucket + 1) * STREAM_FADE_STEP_MS);
    state.entries[kept++] = entry;
  }
  state.entries.length = kept;
  state.nextDueAt = kept > 0 ? earliestDue : 0;
  return { moved, expired };
}

export interface StreamInkHighlighter {
  /** False where the CSS Custom Highlight API is missing; every call is then a no-op. */
  readonly supported: boolean;
  readonly enqueue: (node: Text, start: number, end: number, now: number) => boolean;
  readonly flush: () => void;
}

/**
 * Fades freshly streamed characters in through five `::highlight()` buckets. Ranges live in
 * `CSS.highlights`, so the fade paints without touching the DOM or triggering layout. Steps
 * are scheduled one at a time (a timer to the next due moment, then one frame); nothing
 * runs while no range is fading.
 */
function createStreamInkHighlighter(): StreamInkHighlighter {
  const supported =
    typeof CSS !== "undefined" &&
    typeof CSS.highlights !== "undefined" &&
    typeof Highlight === "function" &&
    typeof document !== "undefined";
  if (!supported) return { supported, enqueue: () => false, flush: () => {} };

  const state = createFadeBucketState<Text>();
  const ranges = new Map<FadeEntry<Text>, Range>();
  let frame = 0;
  let timer = 0;

  // Resolved per use: other highlighters share these registry entries and may remove them.
  const resolveBuckets = () =>
    HIGHLIGHT_NAMES.map((name) => {
      const existing = CSS.highlights.get(name);
      if (existing) return existing;
      const created = new Highlight();
      CSS.highlights.set(name, created);
      return created;
    });

  const dropRange = (entry: FadeEntry<Text>, bucket: number, buckets: ReadonlyArray<Highlight>) => {
    const range = ranges.get(entry);
    if (!range) return;
    buckets[bucket]?.delete(range);
    ranges.delete(entry);
  };

  const flush = () => {
    if (timer) window.clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    timer = 0;
    frame = 0;
    for (const name of HIGHLIGHT_NAMES) {
      const highlight = CSS.highlights.get(name);
      if (!highlight) continue;
      for (const range of ranges.values()) highlight.delete(range);
      if (highlight.size === 0) CSS.highlights.delete(name);
    }
    ranges.clear();
    state.entries.length = 0;
    state.nextDueAt = 0;
  };

  const canPaint = () => !document.hidden && isStreamInkTier(getMotionTier());

  const schedule = (now: number) => {
    if (state.entries.length === 0 || frame || timer) return;
    const delay = state.nextDueAt > 0 ? state.nextDueAt - now : 0;
    if (delay <= 18) {
      frame = requestAnimationFrame(step);
      return;
    }
    timer = window.setTimeout(
      () => {
        timer = 0;
        frame = requestAnimationFrame(step);
      },
      Math.max(8, Math.round(delay - 6)),
    );
  };

  function step(now: number) {
    frame = 0;
    if (!canPaint()) {
      flush();
      return;
    }
    if (state.nextDueAt > 0 && now < state.nextDueAt - 1) {
      schedule(now);
      return;
    }
    const buckets = resolveBuckets();
    const { moved, expired } = advanceFadeBuckets(
      state,
      now,
      ({ node, end }) => node.isConnected && node.length >= end,
    );
    for (const entry of expired) dropRange(entry, entry.bucket, buckets);
    for (const { entry, from, to } of moved) {
      const range = ranges.get(entry);
      if (!range) continue;
      buckets[from]?.delete(range);
      buckets[to]?.add(range);
    }
    if (state.entries.length > 0) schedule(now);
    else flush();
  }

  const enqueue = (node: Text, start: number, end: number, now: number) => {
    if (!canPaint()) {
      flush();
      return false;
    }
    if (end > node.length || !/\S/.test(node.data.slice(start, end))) return false;
    const result = enqueueFadeEntry(state, node, start, end, now);
    if (result.kind === "rejected") return false;
    if (result.kind === "merged") {
      ranges.get(result.entry)?.setEnd(node, end);
      return true;
    }
    const buckets = resolveBuckets();
    if (result.evicted) dropRange(result.evicted, result.evicted.bucket, buckets);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    buckets[0]?.add(range);
    ranges.set(result.entry, range);
    schedule(now);
    return true;
  };

  return { supported, enqueue, flush };
}

interface StreamTail {
  readonly schedule: () => void;
  readonly detach: () => void;
}

/**
 * A caret that rides the last streamed character. Its position is measured at most once per
 * frame, only after the text changed, and it is removed the moment streaming stops.
 */
function createStreamTail(container: HTMLElement): StreamTail {
  const caret = document.createElement("span");
  caret.className = "optical-stream-tail";
  caret.setAttribute("aria-hidden", "true");
  caret.setAttribute("data-optical-ignore", "");
  container.setAttribute(TAIL_HOST_ATTR, "1");
  container.append(caret);
  let frame = 0;

  const lastTextNode = (): Text | null => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest(IGNORE_SELECTOR) || !/\S/.test(node.nodeValue ?? "")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    walker.currentNode = container;
    return walker.lastChild() as Text | null;
  };

  const place = () => {
    frame = 0;
    const node = lastTextNode();
    if (!node || node.parentElement?.closest("pre")) {
      caret.removeAttribute("data-visible");
      return;
    }
    const end = node.data.trimEnd().length;
    const range = document.createRange();
    range.setStart(node, Math.max(0, end - 1));
    range.setEnd(node, end);
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1];
    if (!rect) return;
    const host = container.getBoundingClientRect();
    caret.style.height = `${Math.round(rect.height)}px`;
    caret.style.transform = `translate3d(${(rect.right - host.left + 1.5).toFixed(1)}px, ${(rect.top - host.top).toFixed(1)}px, 0)`;
    // The first placement jumps; later ones glide.
    if (caret.hasAttribute("data-visible")) caret.setAttribute("data-gliding", "");
    caret.setAttribute("data-visible", "");
  };

  return {
    schedule: () => {
      if (!frame && !document.hidden) frame = requestAnimationFrame(place);
    },
    detach: () => {
      if (frame) cancelAnimationFrame(frame);
      caret.remove();
      container.removeAttribute(TAIL_HOST_ATTR);
    },
  };
}

/**
 * Choreographs one streaming message: ink-fades appended characters, lifts new prose blocks
 * in, and scans new code blocks and tables. Returns a detach that undoes all of it.
 */
function observeStreamingContainer(container: HTMLElement): () => void {
  if (typeof MutationObserver !== "function") return () => {};

  const ink = createStreamInkHighlighter();
  const seenLengths = new WeakMap<Text, number>();
  const seenBlocks = new WeakSet<Element>();
  const transientClasses = new Map<Element, { readonly name: string; readonly timer: number }>();
  let lastScanAt = -Infinity;
  let observing = false;
  let tail: StreamTail | null = null;

  const markTransient = (element: Element, name: string, holdMs: number) => {
    if (transientClasses.has(element)) return;
    element.classList.add(name);
    const timer = window.setTimeout(() => {
      transientClasses.delete(element);
      element.classList.remove(name);
    }, holdMs);
    transientClasses.set(element, { name, timer });
  };

  const clearArtifacts = () => {
    ink.flush();
    tail?.detach();
    tail = null;
    for (const [element, { name, timer }] of transientClasses) {
      window.clearTimeout(timer);
      element.classList.remove(name);
    }
    transientClasses.clear();
  };

  /** Notes the newest text nodes as already seen, so only what streams in later is inked. */
  const recordLengths = (root: Node, limit: number) => {
    const pending: Node[] = [root];
    let remaining = limit;
    while (remaining > 0) {
      const node = pending.pop();
      if (!node) return;
      if (node instanceof Text) {
        seenLengths.set(node, node.length);
        remaining--;
        continue;
      }
      // Popping takes the last child first, which visits text newest-first.
      for (let child = node.firstChild; child; child = child.nextSibling) pending.push(child);
    }
  };

  const fadeLeafTexts = (root: Node, now: number, limit: number) => {
    const pending: Node[] = [root];
    let remaining = limit;
    while (remaining > 0) {
      const node = pending.pop();
      if (!node) return;
      if (node instanceof Text) {
        seenLengths.set(node, node.length);
        if (node.length > 0) {
          ink.enqueue(node, 0, node.length, now);
          remaining--;
        }
        continue;
      }
      for (let child = node.lastChild; child; child = child.previousSibling) pending.push(child);
    }
  };

  const onMutations = (records: MutationRecord[]) => {
    if (!isStreamInkTier(getMotionTier())) {
      sync();
      return;
    }
    const now = performance.now();
    let newBlocks = 0;
    tail?.schedule();

    // A parent that also lost an element is being re-rendered; its new children are not new text.
    const rerendered = new Set<Node>();
    for (const record of records) {
      for (const removed of record.removedNodes) {
        if (removed instanceof Element) {
          rerendered.add(record.target);
          break;
        }
      }
    }

    for (const record of records) {
      const target = record.target;
      const base = target instanceof Element ? target : target.parentElement;
      if (!base || base.closest(IGNORE_SELECTOR)) continue;

      if (record.type === "characterData") {
        if (!(target instanceof Text)) continue;
        const length = target.length;
        const previous = seenLengths.get(target);
        seenLengths.set(target, length);
        // An unseen node that is already long was rendered before we attached; do not flash it.
        if (previous === undefined) {
          if (length > 0 && length <= MAX_UNSEEN_APPEND_CHARS) ink.enqueue(target, 0, length, now);
        } else if (length > previous) {
          ink.enqueue(target, previous, length, now);
        }
        continue;
      }
      if (record.addedNodes.length === 0) continue;

      // React replaces a text node outright when its element gains mixed children.
      const addedText = record.addedNodes[0];
      const removedText = record.removedNodes[0];
      if (
        record.addedNodes.length === 1 &&
        record.removedNodes.length === 1 &&
        addedText instanceof Text &&
        removedText instanceof Text
      ) {
        seenLengths.set(addedText, addedText.length);
        if (addedText.length > removedText.length) {
          ink.enqueue(addedText, removedText.length, addedText.length, now);
        }
        continue;
      }

      const context = base.closest(CONTEXT_SELECTOR);
      const inCode = context?.tagName === "PRE";
      const inTable = context?.tagName === "TABLE";
      const inChunk = context !== null && !inCode && !inTable;
      const replacing = rerendered.has(target);

      for (const added of record.addedNodes) {
        if (added instanceof Text) {
          // Syntax highlighting rebuilds a code block's spans, so its text is never "new".
          if (inCode || replacing) seenLengths.set(added, added.length);
          else fadeLeafTexts(added, now, 1);
          continue;
        }
        if (!(added instanceof Element)) continue;
        if (inCode || replacing) {
          recordLengths(added, 24);
          continue;
        }
        if (inTable) {
          fadeLeafTexts(added, now, 3);
          continue;
        }
        const tag = added.tagName;
        if (tag === "PRE" || tag === "TABLE" || added.querySelector("pre, table")) {
          recordLengths(added, 16);
          if (!seenBlocks.has(added) && now - lastScanAt >= STREAM_BATCH_MS) {
            seenBlocks.add(added);
            lastScanAt = now;
            markTransient(added, CODE_SCAN_CLASS, CODE_SCAN_HOLD_MS);
          }
        } else if (inChunk || INLINE_TAGS.has(tag)) {
          fadeLeafTexts(added, now, 4);
        } else if (
          PROSE_BLOCK_TAGS.has(tag) &&
          !seenBlocks.has(added) &&
          newBlocks < MAX_NEW_BLOCKS_PER_BATCH
        ) {
          seenBlocks.add(added);
          newBlocks++;
          recordLengths(added, 12);
          markTransient(added, CHUNK_CLASS, CHUNK_HOLD_MS);
        } else {
          fadeLeafTexts(added, now, 4);
        }
      }
    }
  };

  const observer = new MutationObserver(onMutations);

  function sync() {
    const enabled = isStreamInkTier(getMotionTier());
    if (enabled === observing) return;
    observing = enabled;
    if (enabled) {
      recordLengths(container, 24);
      tail = createStreamTail(container);
      tail.schedule();
      observer.observe(container, OBSERVE_OPTIONS);
    } else {
      observer.disconnect();
      clearArtifacts();
    }
  }

  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  window.addEventListener(OPTICAL_SETTINGS_EVENT, sync);
  reducedMotionQuery.addEventListener("change", sync);
  sync();

  return () => {
    window.removeEventListener(OPTICAL_SETTINGS_EVENT, sync);
    reducedMotionQuery.removeEventListener("change", sync);
    observer.disconnect();
    observing = false;
    clearArtifacts();
  };
}

/**
 * Attaches the streaming choreography to one message container, and only while that message
 * streams at motion tier "standard" or "ultra". The observer is scoped to the container, so a
 * virtualized timeline can mount and unmount rows freely.
 */
export function useStreamingInkChoreography(
  containerRef: RefObject<HTMLElement | null>,
  isStreaming: boolean,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches DOM mutations of the streaming message, an external system, only while it streams
  useEffect(() => {
    const container = containerRef.current;
    if (!isStreaming || !container) return;
    return observeStreamingContainer(container);
  }, [containerRef, isStreaming]);
}

const causticTimers = new WeakMap<HTMLElement, number>();

/** Sweeps a one-shot caustic across the composer when a long run completes. Tier "ultra" only. */
function triggerComposerCaustic(element: HTMLElement | null): void {
  if (!element || getMotionTier() !== "ultra") return;
  const pending = causticTimers.get(element);
  if (pending !== undefined) window.clearTimeout(pending);
  element.setAttribute(CAUSTIC_ATTR, "1");
  causticTimers.set(
    element,
    window.setTimeout(() => {
      causticTimers.delete(element);
      element.removeAttribute(CAUSTIC_ATTR);
    }, CAUSTIC_HOLD_MS),
  );
}

const LONG_TURN_CAUSTIC_MS = 6000;

/**
 * Fires the composer completion caustic when an active turn ends cleanly after >= 6s on the same
 * thread. Kept in a dedicated hook so `ChatView` stays free of transition tracking state.
 */
export function useOpticalCompletionCaustic(options: {
  readonly isWorking: boolean;
  readonly workStartedAtMs: number | null;
  readonly threadKey: string | null;
  readonly hasError: boolean;
  readonly composerOverlayElement: HTMLElement | null;
}): void {
  const { isWorking, workStartedAtMs, threadKey, hasError, composerOverlayElement } = options;
  const previousRef = useRef<{
    active: boolean;
    startedAtMs: number | null;
    threadKey: string | null;
  }>({
    active: isWorking,
    startedAtMs: workStartedAtMs,
    threadKey,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fires one-shot DOM caustic animation on the falling edge of a long turn
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = {
      active: isWorking,
      startedAtMs: workStartedAtMs,
      threadKey,
    };
    if (
      previous.active &&
      !isWorking &&
      previous.threadKey !== null &&
      previous.threadKey === threadKey &&
      !hasError &&
      previous.startedAtMs !== null &&
      Date.now() - previous.startedAtMs >= LONG_TURN_CAUSTIC_MS
    ) {
      const fxHost = composerOverlayElement?.querySelector<HTMLElement>(
        '[data-optical-composer-fx="1"]',
      );
      if (fxHost) {
        triggerComposerCaustic(fxHost);
      }
    }
  }, [composerOverlayElement, hasError, isWorking, threadKey, workStartedAtMs]);
}
