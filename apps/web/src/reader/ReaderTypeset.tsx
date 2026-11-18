import type { Element as HastElement } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import {
  Component,
  Fragment,
  isValidElement,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";

import {
  collectReaderFlow,
  readerFlowText,
  readerHanItalicSeam,
  readerListItemParts,
  type ReaderFlow,
} from "./readerFlow";
import { readerLineNodes, readerLinesText } from "./readerLines";
import {
  atomWidth,
  columnWidth,
  inlineStyleOf,
  isNearViewport,
  isPlainTextBlock,
  observeColumn,
  observeNearViewport,
  readerLayoutEpoch,
  readerMeasurer,
  readerTracking,
  renderedInlineView,
  subscribeReaderLayoutEpoch,
} from "./readerTypesetDom";
import { typesetParagraph, type TypesetOptions } from "./typeset";

export type ReaderInlineComponents = Partial<Components>;

type FlowOptions = Omit<TypesetOptions, "width">;

interface FlowKey {
  /** The element whose children `start` to `end` are the text to set. */
  readonly source: HastElement | undefined;
  readonly start: number;
  readonly end: number;
  readonly epoch: number;
}

interface Typeset extends FlowKey {
  readonly flow: ReaderFlow;
  readonly options: FlowOptions;
  readonly width: number;
  readonly content: ReactNode;
}

const isSameFlow = (a: FlowKey, b: FlowKey) =>
  a.source === b.source && a.start === b.start && a.end === b.end && a.epoch === b.epoch;

// Atoms settle within a hair of their first measurement; only a real change is worth new breaks.
const ATOM_TOLERANCE = 0.05;
const WIDTH_TOLERANCE = 0.01;

/** Null when the lines cannot be trusted; the paragraph then stays with the browser. */
function setLines(
  flow: ReaderFlow,
  options: FlowOptions,
  width: number,
  components: ReaderInlineComponents,
): ReactNode | null {
  try {
    const measurer = readerMeasurer();
    if (measurer === null || !(width > 0)) return null;
    const { lines } = typesetParagraph(flow.runs, { ...options, width }, measurer);
    if (lines.length === 0) return null;
    const nodes = readerLineNodes(lines, flow, readerTracking);
    // Copying a typeset paragraph must give the words the source has, in every case.
    if (readerLinesText(nodes, flow) !== readerFlowText(flow.runs)) return null;
    return toJsxRuntime(
      { type: "root", children: nodes },
      { Fragment, components, ignoreInvalidStyle: true, jsx, jsxs, passKeys: true, passNode: true },
    );
  } catch {
    return null;
  }
}

/** Reads the browser-laid-out text: its runs, their fonts and the block's paragraph style. */
function measureFlow(element: Element, key: FlowKey) {
  if (key.source === undefined) return null;
  try {
    const style = getComputedStyle(element);
    if (!isPlainTextBlock(style)) return null;
    const base = inlineStyleOf(style);
    const flow = collectReaderFlow(
      key.source.children.slice(key.start, key.end),
      element,
      base,
      renderedInlineView,
    );
    if (flow === null) return null;
    const options: FlowOptions = {
      em: base.fontSize,
      justify: style.textAlign === "justify",
      firstLineIndent: Number.parseFloat(style.textIndent) || 0,
      hanItalicSeam: readerHanItalicSeam(
        document.documentElement.getAttribute("data-reader-typography"),
      ),
    };
    return { flow, options };
  } catch {
    return null;
  }
}

/**
 * Sets one stretch of inline text with the typesetting engine. The browser lays the text out
 * first, which is what the engine's input is read from; its lines replace that layout before
 * paint once the element is near the view, and give way to it again whenever they cannot be
 * kept right. Lines change only when the text, the column width or the layout epoch does.
 */
function useReaderTypeset<Rendered extends HTMLElement>(input: {
  readonly source: HastElement | undefined;
  readonly start: number;
  readonly end: number;
  readonly components: ReaderInlineComponents;
  readonly isEnabled: boolean;
  /** The block whose content width is the column: the element itself, or its parent. */
  readonly column: "self" | "parent";
  /** The text as the browser sets it. */
  readonly fallback: ReactNode;
}) {
  const { source, start, end, components, isEnabled, column } = input;
  const ref = useRef<Rendered>(null);
  const epoch = useSyncExternalStore(
    subscribeReaderLayoutEpoch,
    readerLayoutEpoch,
    readerLayoutEpoch,
  );
  const [typeset, setTypeset] = useState<Typeset | null>(null);
  const unsupported = useRef<FlowKey | null>(null);
  const key: FlowKey = { source, start, end, epoch };
  const current = isEnabled && typeset !== null && isSameFlow(typeset, key) ? typeset : null;
  const isTypeset = current !== null;

  const columnOf = (element: Element) => (column === "parent" ? element.parentElement : element);

  const attempt = useEffectEvent((flowKey: FlowKey) => {
    const element = ref.current;
    const box = element && columnOf(element);
    if (!isEnabled || isTypeset || !element || !box) return;
    if (unsupported.current !== null && isSameFlow(unsupported.current, flowKey)) return;
    if (!isNearViewport(box)) return;
    const measured = measureFlow(element, flowKey);
    if (measured === null) {
      unsupported.current = flowKey;
      return;
    }
    const width = columnWidth(box);
    const content = setLines(measured.flow, measured.options, width, components);
    if (content !== null) setTypeset({ ...flowKey, ...measured, width, content });
  });

  const onNear = useEffectEvent(() => attempt(key));

  const onColumnResize = useEffectEvent(() => {
    const element = ref.current;
    const box = element && columnOf(element);
    if (current === null || !box) return;
    const width = columnWidth(box);
    if (Math.abs(width - current.width) < WIDTH_TOLERANCE) return;
    // Far from the view the browser's own layout is as good, and costs nothing to keep right.
    const content = isNearViewport(box)
      ? setLines(current.flow, current.options, width, components)
      : null;
    setTypeset(content === null ? null : { ...current, width, content });
  });

  const onAtomChange = useEffectEvent(() => {
    const element = ref.current;
    if (current === null || !element) return;
    const runs = [...current.flow.runs];
    let hasChanged = false;
    for (const wrapper of element.querySelectorAll("[data-reader-atom]")) {
      const index = Number(wrapper.getAttribute("data-reader-atom"));
      const run = runs[index];
      const advance = atomWidth(wrapper);
      if (run?.kind !== "atom" || Math.abs(run.advance - advance) < ATOM_TOLERANCE) continue;
      runs[index] = { kind: "atom", advance };
      hasChanged = true;
    }
    if (!hasChanged) return;
    const flow = { ...current.flow, runs };
    const content = setLines(flow, current.options, current.width, components);
    setTypeset(content === null ? null : { ...current, flow, content });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- typesetting needs the laid-out DOM: the column width and the computed fonts of the browser's own paragraph, swapped for lines before paint
  useLayoutEffect(() => {
    if (isEnabled && !isTypeset) attempt({ source, start, end, epoch });
  }, [isEnabled, isTypeset, source, start, end, epoch]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the reader's scrolled view changing size and to the paragraph coming near the scrolled view
  useLayoutEffect(() => {
    const element = ref.current;
    const box = element && (column === "parent" ? element.parentElement : element);
    if (!isEnabled || !box) return;
    const stopResize = observeColumn(box, onColumnResize);
    const stopNear = observeNearViewport(box, (isNear) => {
      if (isNear) onNear();
    });
    return () => {
      stopResize();
      stopNear();
    };
  }, [isEnabled, column]);

  const hasAtoms = current?.flow.hasAtoms === true;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an atom (a formula, a chip) can change width after it is placed, which only its rendered DOM tells
  useLayoutEffect(() => {
    const element = ref.current;
    if (!hasAtoms || !element) return;
    onAtomChange();
    // Mutations, not sizes: new lines from a resize callback would resize what others observe.
    const mutations = new MutationObserver(onAtomChange);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    return () => mutations.disconnect();
  }, [hasAtoms]);

  const giveUp = () => {
    unsupported.current = key;
    setTypeset(null);
  };
  const lines =
    current === null ? null : (
      <TypesetBoundary fallback={input.fallback} onError={giveUp}>
        {current.content}
      </TypesetBoundary>
    );
  return { ref, lines };
}

/** A piece that fails to render sends the whole paragraph back to the browser's layout. */
class TypesetBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: ReactNode; readonly onError: () => void },
  { readonly hasFailed: boolean }
> {
  override state = { hasFailed: false };

  static getDerivedStateFromError() {
    return { hasFailed: true };
  }

  override componentDidCatch() {
    this.props.onError();
  }

  override render() {
    return this.state.hasFailed ? this.props.fallback : this.props.children;
  }
}

/** A paragraph or heading of the reading view. `children` is the block as the browser sets it. */
export function ReaderParagraph({
  as: Tag = "p",
  node,
  components,
  isEnabled,
  children,
  ...props
}: ComponentProps<"p"> & {
  readonly as?: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  readonly node: HastElement | undefined;
  readonly components: ReaderInlineComponents;
  readonly isEnabled: boolean;
}) {
  // One ref that fits every tag this renders as.
  const { ref, lines } = useReaderTypeset<HTMLParagraphElement & HTMLHeadingElement>({
    source: node,
    start: 0,
    end: node?.children.length ?? 0,
    components,
    isEnabled,
    column: "self",
    fallback: children,
  });
  return (
    <Tag {...props} ref={ref} data-reader-typeset={lines === null ? undefined : ""}>
      {lines ?? children}
    </Tag>
  );
}

function ReaderListItemText(props: {
  readonly node: HastElement;
  readonly start: number;
  readonly end: number;
  readonly components: ReaderInlineComponents;
  readonly isEnabled: boolean;
  readonly children: ReactNode;
}) {
  const { ref, lines } = useReaderTypeset<HTMLSpanElement>({
    source: props.node,
    start: props.start,
    end: props.end,
    components: props.components,
    isEnabled: props.isEnabled,
    column: "parent",
    fallback: props.children,
  });
  return (
    <span ref={ref} className="reader-flow" data-reader-typeset={lines === null ? undefined : ""}>
      {lines ?? props.children}
    </span>
  );
}

/**
 * A list item's children in the reading view: text that sits directly in the item is set like
 * a paragraph, and the blocks around it render as they are.
 */
export function ReaderListItemContent(props: {
  readonly node: HastElement | undefined;
  readonly components: ReaderInlineComponents;
  readonly isEnabled: boolean;
  /** Finishes a run of the item's rendered children the way the item itself would. */
  readonly renderInline: (children: ReactNode) => ReactNode;
  readonly children: ReactNode;
}) {
  const { node, children } = props;
  const rendered: ReadonlyArray<ReactNode> = Array.isArray(children) ? children : [children];
  // Each rendered child must stand for the hast child at its index, or the text cannot be cut out.
  const isAligned =
    node !== undefined &&
    rendered.length === node.children.length &&
    node.children.every((child, index) =>
      // An enclosing item has already wrapped the strings of a nested one.
      child.type === "text"
        ? typeof rendered[index] === "string" || isValidElement(rendered[index])
        : child.type === "element" && isValidElement(rendered[index]),
    );
  const parts = isAligned ? readerListItemParts(node.children) : [];
  if (node === undefined || !parts.some((part) => part.isFlow)) {
    return props.renderInline(children);
  }
  return parts.map((part) => {
    const slice = props.renderInline(rendered.slice(part.start, part.end));
    return part.isFlow ? (
      <ReaderListItemText
        key={part.start}
        node={node}
        start={part.start}
        end={part.end}
        components={props.components}
        isEnabled={props.isEnabled}
      >
        {slice}
      </ReaderListItemText>
    ) : (
      <Fragment key={part.start}>{slice}</Fragment>
    );
  });
}
