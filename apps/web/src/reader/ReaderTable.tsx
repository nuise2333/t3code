import {
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";

import { MarkdownTable } from "../components/chat/MarkdownTable";
import { allocateTableColumns } from "./readerTableColumns";
import {
  columnWidth,
  inlineStyleOf,
  observeColumn,
  readerLayoutEpoch,
  readerTracking,
  subscribeReaderLayoutEpoch,
} from "./readerTypesetDom";

// The native reader's cell padding, a plain length on every side.
const CELL_PADDING = 8;

interface Columns {
  readonly epoch: number;
  readonly widths: ReadonlyArray<number>;
  readonly tracking: number;
}

const zoomOf = (element: Element) =>
  (element as Element & { readonly currentCSSZoom?: number }).currentCSSZoom ?? 1;

/** Natural content width of each column: every cell set on one line. */
function naturalColumnWidths(table: HTMLTableElement) {
  table.classList.add("reader-table-natural");
  try {
    const row = table.rows[0];
    if (row === undefined) return null;
    return [...row.cells].map(
      (cell) => cell.getBoundingClientRect().width / zoomOf(cell) - 2 * CELL_PADDING,
    );
  } finally {
    table.classList.remove("reader-table-natural");
  }
}

/**
 * A table of the reading view. Columns that fit keep their natural width and the long ones
 * share the rest of the column equally, which the browser's own table layout does not do.
 */
export function ReaderTable({ style, children, ...props }: ComponentProps<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  const epoch = useSyncExternalStore(
    subscribeReaderLayoutEpoch,
    readerLayoutEpoch,
    readerLayoutEpoch,
  );
  const [columns, setColumns] = useState<Columns | null>(null);

  const measure = useEffectEvent(() => {
    const table = ref.current;
    const container = table?.closest(".chat-markdown-table-container");
    if (!table || !container) return;
    const tableStyle = getComputedStyle(table);
    const { font } = inlineStyleOf(tableStyle);
    const tracking = readerTracking(font);
    table.style.setProperty("--reader-cell-tracking", `${tracking}px`);
    const natural = naturalColumnWidths(table);
    if (natural === null) return;
    const base = Number.parseFloat(tableStyle.fontSize) || 16;
    const padding = 2 * CELL_PADDING * natural.length;
    const content = allocateTableColumns(
      // Native minimum: the base size, or the widest single character when wider (not measured here).
      natural.map(() => base),
      natural,
      columnWidth(container) - padding,
    );
    const widths = content.map((width) => width + 2 * CELL_PADDING);
    const isSame =
      columns?.epoch === epoch &&
      columns.tracking === tracking &&
      columns.widths.length === widths.length &&
      columns.widths.every((width, index) => Math.abs(width - widths[index]!) < 0.01);
    if (!isSame) setColumns({ epoch, widths, tracking });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- column widths come from the natural widths of the laid-out cells and the column's width, read before paint after every change of the cells
  useLayoutEffect(() => measure());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the columns are shared out again when the reader's column changes width
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    return observeColumn(table, measure);
  }, []);

  const current = columns?.epoch === epoch ? columns : null;
  const sized = current && {
    "--reader-cell-tracking": `${current.tracking}px`,
    tableLayout: "fixed" as const,
    width: current.widths.reduce((total, width) => total + width, 0),
  };
  return (
    <MarkdownTable {...props} ref={ref} style={sized ? { ...style, ...sized } : style}>
      {current ? (
        <colgroup>
          {current.widths.map((width, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- a column is its position
            <col key={index} style={{ width }} />
          ))}
        </colgroup>
      ) : null}
      {children}
    </MarkdownTable>
  );
}
