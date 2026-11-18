import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { type InlineStyle, readerHanItalicSeam } from "../readerFlow";
import { type ReaderLineDecoration, readerLineDecorations } from "../readerLines";
import {
  columnWidth,
  inlineStyleOf,
  observeColumn,
  readerMeasurer,
  readerTracking,
  subscribeReaderLayoutEpoch,
} from "../readerTypesetDom";
import { typesetParagraph, type TypesetOptions } from "../typeset";
import { type EditorFlow, editorFlow, editorInlineRuns } from "./editorFlow";
import {
  inlineSyntaxKey,
  type InlineSyntaxMeta,
  leafReveal,
  leafTextOf,
} from "./inlineSyntaxPlugin";
import {
  editableLeafKind,
  type InlineAnalysis,
  type InlineReveal,
  rememberedInlineAnalysis,
} from "./markdownFileInline";

export interface LeafLayout {
  readonly flow: EditorFlow;
  /** The engine's lines over the flow's runs. */
  readonly decorations: ReadonlyArray<ReaderLineDecoration>;
}

type FlowOptions = Omit<TypesetOptions, "width">;

interface LeafMetrics {
  readonly epoch: number;
  readonly width: number;
  readonly options: FlowOptions;
  readonly baseFont: string;
}

/**
 * What typesetting an editable leaf needs from the laid-out page: its column width, paragraph
 * settings and the fonts of its styles. Measured once a leaf is near the view; an edited leaf
 * takes over its predecessor's, so a keystroke sets its paragraph again without reading layout.
 */
export class TypesetController {
  /** Bumped whenever measurements may be stale; metrics carry the epoch they were read in. */
  epoch = 0;
  composing = false;
  private metrics = new WeakMap<ProseMirrorNode, LeafMetrics>();
  // Per paragraph font and style path: the same in every leaf of the same kind.
  private readonly fonts = new Map<string, InlineStyle>();
  // A typeset leaf's own `text-align` and `text-indent` give way to the typeset rules, so the
  // settings read from an untypeset leaf of the same kind are kept.
  private readonly settings = new Map<string, { justify: boolean; indent: number }>();
  private readonly layouts = new WeakMap<
    ProseMirrorNode,
    { readonly reveal: string; readonly metrics: LeafMetrics; readonly layout: LeafLayout | null }
  >();

  layoutFor(
    node: ProseMirrorNode,
    text: string,
    analysis: InlineAnalysis,
    reveal: InlineReveal,
  ): LeafLayout | null {
    const metrics = this.metrics.get(node);
    if (!metrics || metrics.epoch !== this.epoch || text === "") return null;
    const known = this.layouts.get(node);
    if (known?.reveal === reveal.key && known.metrics === metrics) return known.layout;
    const layout = this.compute(text, analysis, reveal, metrics);
    this.layouts.set(node, { reveal: reveal.key, metrics, layout });
    return layout;
  }

  private compute(
    text: string,
    analysis: InlineAnalysis,
    reveal: InlineReveal,
    metrics: LeafMetrics,
  ): LeafLayout | null {
    try {
      const flow = editorFlow(text, analysis, reveal);
      const measurer = readerMeasurer();
      if (!flow || !measurer || !(metrics.width > 0)) return null;
      const runs = editorInlineRuns(flow, (kinds) => this.fonts.get(this.fontKey(metrics, kinds)));
      if (!runs) return null;
      const { lines } = typesetParagraph(
        runs,
        { ...metrics.options, width: metrics.width },
        measurer,
      );
      if (lines.length === 0) return null;
      return { flow, decorations: readerLineDecorations(lines, runs, readerTracking) };
    } catch {
      return null;
    }
  }

  private fontKey(metrics: LeafMetrics, kinds: string) {
    return `${metrics.baseFont}\u0001${kinds}`;
  }

  carry(old: ProseMirrorNode, fresh: ProseMirrorNode) {
    const metrics = this.metrics.get(old);
    if (metrics) this.metrics.set(fresh, metrics);
  }

  /** Whether the leaf is set from measurements of this epoch, with every font it needs. */
  isMeasured(node: ProseMirrorNode, text: string, analysis: InlineAnalysis, reveal: InlineReveal) {
    const metrics = this.metrics.get(node);
    if (!metrics || metrics.epoch !== this.epoch) return false;
    const flow = editorFlow(text, analysis, reveal);
    if (!flow) return true;
    return flow.runs.every(
      (run) => run.kind === "break" || this.fonts.has(this.fontKey(metrics, run.kinds)),
    );
  }

  /** Reads the leaf's measurements from its DOM; false when it cannot be typeset. */
  measure(
    view: EditorView,
    pos: number,
    node: ProseMirrorNode,
    text: string,
    analysis: InlineAnalysis,
    reveal: InlineReveal,
  ): boolean {
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;
    const box = node.attrs.flow ? dom.parentElement : dom;
    if (!box) return false;
    const style = getComputedStyle(dom);
    if (
      style.direction !== "ltr" ||
      !(style.letterSpacing === "normal" || Number.parseFloat(style.letterSpacing) === 0) ||
      (Number.parseFloat(style.wordSpacing) || 0) !== 0
    ) {
      return false;
    }
    const base = inlineStyleOf(style);
    const kind = `${dom.tagName}|${dom.className}|${dom.parentElement === view.dom}|${base.font}`;
    if (!dom.hasAttribute("data-reader-typeset")) {
      this.settings.set(kind, {
        justify: style.textAlign === "justify",
        indent: Number.parseFloat(style.textIndent) || 0,
      });
    }
    const settings = this.settings.get(kind);
    if (!settings) return false;
    const metrics: LeafMetrics = {
      epoch: this.epoch,
      width: columnWidth(box),
      baseFont: base.font,
      options: {
        em: base.fontSize,
        justify: settings.justify,
        firstLineIndent: settings.indent,
        hanItalicSeam: readerHanItalicSeam(
          document.documentElement.getAttribute("data-reader-typography"),
        ),
      },
    };
    this.fonts.set(this.fontKey(metrics, ""), base);
    const flow = editorFlow(text, analysis, reveal);
    if (flow) {
      const leaf = leafTextOf(node, pos);
      for (const run of flow.runs) {
        if (run.kind === "break") continue;
        const key = this.fontKey(metrics, run.kinds);
        if (this.fonts.has(key)) continue;
        const element = elementAt(view, leaf.startPos(run.sources[0]!));
        if (element) this.fonts.set(key, inlineStyleOf(getComputedStyle(element)));
      }
    }
    this.metrics.set(node, metrics);
    return true;
  }

  /** Fonts or settings changed: every leaf is measured again. */
  invalidate() {
    this.epoch += 1;
    this.fonts.clear();
    this.settings.clear();
    this.metrics = new WeakMap();
  }
}

/** The element holding the text at a position. */
function elementAt(view: EditorView, pos: number): Element | null {
  const { node, offset } = view.domAtPos(pos, 1);
  let target: Node | null =
    node.nodeType === Node.TEXT_NODE ? node : (node.childNodes[offset] ?? node);
  while (target && target.nodeType !== Node.TEXT_NODE && target.firstChild) {
    target = target.firstChild;
  }
  return target?.nodeType === Node.TEXT_NODE ? target.parentElement : (target as Element | null);
}

// How far outside the scrolled view a leaf is set ahead of being seen, in view heights.
const AHEAD = 1.5;

export function scrollerOf(element: Element): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/** The top-level blocks near the scrolled view, as their positions and nodes. */
export function nearBlocks(view: EditorView): Array<{ pos: number; node: ProseMirrorNode }> {
  const { doc } = view.state;
  const starts: number[] = [];
  let at = 0;
  doc.forEach((child) => {
    starts.push(at);
    at += child.nodeSize;
  });
  const reach = window.innerHeight * AHEAD;
  const top = -reach;
  const bottom = window.innerHeight + reach;
  const rectOf = (index: number) => {
    const dom = view.nodeDOM(starts[index]!);
    return dom instanceof Element ? dom.getBoundingClientRect() : null;
  };
  // The first block whose bottom reaches the band.
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const rect = rectOf(middle);
    if (rect && rect.bottom < top) low = middle + 1;
    else high = middle;
  }
  const found: Array<{ pos: number; node: ProseMirrorNode }> = [];
  for (let index = low; index < starts.length; index++) {
    const rect = rectOf(index);
    if (rect && rect.top > bottom) break;
    found.push({ pos: starts[index]!, node: doc.child(index) });
  }
  return found;
}

/** Positions of the editable leaves inside the top-level blocks near the scrolled view. */
function nearLeaves(view: EditorView): Array<{ pos: number; node: ProseMirrorNode }> {
  const found: Array<{ pos: number; node: ProseMirrorNode }> = [];
  for (const { pos: start, node: block } of nearBlocks(view)) {
    if (block.isTextblock) {
      if (editableLeafKind(block)) found.push({ pos: start, node: block });
      continue;
    }
    block.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (editableLeafKind(node)) found.push({ pos: start + 1 + pos, node });
      return false;
    });
  }
  return found;
}

const typesetKey = new PluginKey("md-typeset");

/**
 * Typesets the editable leaves near the view with the reading view's engine: measures each
 * once, then has the inline syntax plugin draw it with the engine's lines. A doc change
 * typesets only the leaves it touched, and nothing is set while a composition is in progress.
 */
export function createTypesetPlugin(controller: TypesetController): Plugin {
  return new Plugin({
    key: typesetKey,
    props: {
      handleDOMEvents: {
        compositionstart: () => {
          controller.composing = true;
          return false;
        },
      },
    },
    view: (view) => {
      let frame = 0;
      let queued = false;
      // Layout and style are first read in the scan, after the commit that made the view: a
      // view destroyed within that commit never lays out its document.
      let width = -1;
      let detach: (() => void) | null = null;
      const scan = () => {
        queued = false;
        if (view.isDestroyed || view.composing) return;
        detach ??= attach();
        const inline = inlineSyntaxKey.getState(view.state);
        if (!inline) return;
        const rebuild: number[] = [];
        for (const { pos, node } of nearLeaves(view)) {
          const analysis = rememberedInlineAnalysis(node);
          if (!analysis) continue;
          const leaf = leafTextOf(node, pos);
          if (leaf.text === "") continue;
          // A leaf is measured as drawn, with its styles' elements in place.
          if (!inline.drawn.has(node)) {
            rebuild.push(pos);
            continue;
          }
          const reveal = leafReveal(view.state, inline.focused, pos, leaf, analysis);
          if (controller.isMeasured(node, leaf.text, analysis, reveal)) continue;
          if (controller.measure(view, pos, node, leaf.text, analysis, reveal)) rebuild.push(pos);
        }
        if (rebuild.length === 0) return;
        const meta: InlineSyntaxMeta = { rebuild };
        view.dispatch(view.state.tr.setMeta(inlineSyntaxKey, meta).setMeta("addToHistory", false));
      };
      // Lands before paint: a microtask runs ahead of the frame the change is drawn in.
      const schedule = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(scan);
      };
      const onScroll = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          scan();
        });
      };
      const resetAll = () => {
        if (view.isDestroyed) return;
        controller.invalidate();
        const meta: InlineSyntaxMeta = { rebuild: "typeset" };
        view.dispatch(view.state.tr.setMeta(inlineSyntaxKey, meta).setMeta("addToHistory", false));
        schedule();
      };
      const onColumn = () => {
        if (view.dom.clientWidth === width) return;
        width = view.dom.clientWidth;
        resetAll();
      };
      const attach = () => {
        width = view.dom.clientWidth;
        const stopEpoch = subscribeReaderLayoutEpoch(resetAll);
        const stopColumn = observeColumn(view.dom, onColumn);
        const scroller = scrollerOf(view.dom);
        scroller?.addEventListener("scroll", onScroll, { passive: true });
        return () => {
          stopEpoch();
          stopColumn();
          scroller?.removeEventListener("scroll", onScroll);
        };
      };
      schedule();
      return {
        update: (_view: EditorView, previous: EditorState) => {
          if (controller.composing && !view.composing) {
            controller.composing = false;
            const meta: InlineSyntaxMeta = { flush: true };
            queueMicrotask(() => {
              if (view.isDestroyed) return;
              view.dispatch(
                view.state.tr.setMeta(inlineSyntaxKey, meta).setMeta("addToHistory", false),
              );
            });
          }
          if (view.state.doc !== previous.doc || view.state.selection !== previous.selection) {
            schedule();
          }
        },
        destroy: () => {
          cancelAnimationFrame(frame);
          detach?.();
        },
      };
    },
  });
}
