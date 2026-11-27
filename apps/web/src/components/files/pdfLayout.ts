const PDF_PAGE_GAP = 16;
export const PDF_MIN_ZOOM = 0.25;
export const PDF_MAX_ZOOM = 3;
const PDF_ZOOM_STEP = 0.25;

/** `none` stacks one page per row; `odd` pairs pages 1-2, 3-4; `even` sets page 1 alone, as a book's cover. */
export type PdfSpread = "none" | "odd" | "even";
/** A scale, `null` to fit the width, or `page` to fit a whole page in view. */
export type PdfZoom = number | null | "page";

export function pdfSpreadColumns(spread: PdfSpread) {
  return spread === "none" ? 1 : 2;
}

/**
 * Each page's display width. `ratio` is the tallest page's height / width, which `page` fits
 * inside the viewport; `pageWidth` is the widest page's width at 100%.
 */
export function pdfPageWidth(
  viewport: { width: number; height: number },
  pageWidth: number,
  zoom: PdfZoom,
  columns = 1,
  ratio = 1,
) {
  const fitWidth = Math.max(1, (viewport.width - (columns + 1) * PDF_PAGE_GAP) / columns);
  if (typeof zoom === "number") return { scale: zoom, width: pageWidth * zoom };
  const width =
    zoom === "page"
      ? Math.max(1, Math.min(fitWidth, (viewport.height - 2 * PDF_PAGE_GAP) / ratio))
      : fitWidth;
  return { scale: width / pageWidth, width };
}

export function stepPdfZoom(scale: number, direction: 1 | -1) {
  return direction > 0
    ? Math.min(PDF_MAX_ZOOM, scale + PDF_ZOOM_STEP)
    : Math.max(PDF_MIN_ZOOM, scale - PDF_ZOOM_STEP);
}

/** Page ratios as shown after turning every page by `rotation` degrees. */
export function rotatedPdfRatios(ratios: readonly number[], rotation: number) {
  return rotation % 180 === 0 ? ratios : ratios.map((ratio) => 1 / ratio);
}

function pdfRows(count: number, spread: PdfSpread) {
  const rows: number[][] = [];
  let index = 0;
  if (spread === "even" && count > 0) rows.push([index++]);
  while (index < count) {
    rows.push(spread === "none" || index + 1 >= count ? [index] : [index, index + 1]);
    index += rows.at(-1)!.length;
  }
  return rows;
}

export type PdfLayout = {
  /** Top of each page's row. */
  readonly tops: readonly number[];
  /** Top of the row after each page's row, so `ends[i] - tops[i]` is the row and its gap. */
  readonly ends: readonly number[];
  readonly lefts: readonly number[];
  readonly height: number;
  readonly width: number;
};

/** Pages in rows of one or two, each row as tall as its tallest page and centred in the viewport. */
export function pdfLayout(
  ratios: readonly number[],
  width: number,
  spread: PdfSpread = "none",
  viewportWidth = 0,
): PdfLayout {
  const tops: number[] = [];
  const ends: number[] = [];
  const lefts: number[] = [];
  const columns = pdfSpreadColumns(spread);
  const rowWidth = columns * width + (columns - 1) * PDF_PAGE_GAP;
  const start = Math.max(PDF_PAGE_GAP, (viewportWidth - rowWidth) / 2);
  let top = PDF_PAGE_GAP;
  for (const row of pdfRows(ratios.length, spread)) {
    const end = top + width * Math.max(...row.map((index) => ratios[index]!)) + PDF_PAGE_GAP;
    // A book's cover and a lone last page sit on the side they would in a printed spread.
    const column = spread === "even" && row.length === 1 && row[0] === 0 ? 1 : 0;
    row.forEach((index, slot) => {
      tops[index] = top;
      ends[index] = end;
      lefts[index] = start + (column + slot) * (width + PDF_PAGE_GAP);
    });
    top = end;
  }
  return { tops, ends, lefts, height: top, width: rowWidth + 2 * PDF_PAGE_GAP };
}

export function currentPdfPage(layout: PdfLayout, scrollTop: number) {
  const index = layout.ends.findIndex((end) => end > scrollTop + PDF_PAGE_GAP + 1);
  return Math.max(0, index);
}

/** Pages within one viewport above and two below the visible area stay mounted. */
export function visiblePdfPages(
  ratios: readonly number[],
  layout: PdfLayout,
  scrollTop: number,
  viewportHeight: number,
) {
  return ratios.flatMap((ratio, index) =>
    layout.ends[index]! >= scrollTop - viewportHeight &&
    layout.tops[index]! <= scrollTop + viewportHeight * 3
      ? [{ index, ratio }]
      : [],
  );
}

export function pdfPageScrollTop(layout: PdfLayout, index: number) {
  return Math.max(0, (layout.tops[index] ?? PDF_PAGE_GAP) - PDF_PAGE_GAP);
}

/** A saved offset was taken at `savedWidth`; a reloaded document can have fewer or shorter pages. */
export function pdfRestoredScrollTop(
  ratios: readonly number[],
  width: number,
  view: { page: number; offset: number },
  savedWidth = width,
  spread: PdfSpread = "none",
) {
  const page = Math.min(view.page, ratios.length - 1);
  const layout = pdfLayout(ratios, width, spread);
  return (
    layout.tops[page]! -
    PDF_PAGE_GAP +
    Math.min(
      (view.offset * width) / savedWidth,
      Math.max(0, layout.ends[page]! - layout.tops[page]! - PDF_PAGE_GAP - 1),
    )
  );
}

export function pdfPageText(
  items: readonly ({ str: string; hasEOL: boolean } | { type: string })[],
) {
  return items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("");
}

// A typed straight quote finds a typeset curly one, as pdf.js's own find does.
function foldQuotes(text: string) {
  return text.replace(/[\u2018-\u201b]/g, "'").replace(/[\u201c-\u201f]/g, '"');
}

/**
 * Lowercased search text with each whitespace run, line ends included, read as one space, and a
 * hyphen that ends a line between letters dropped, as pdf.js's own find does. `owner` maps each
 * character back to the run it came from.
 */
function pdfFindText(runs: readonly string[]) {
  const chars = runs.flatMap((run, index) =>
    Array.from(foldQuotes(run.toLowerCase()), (char) => ({ char, run: index })),
  );
  let text = "";
  let last = "";
  const owner: number[] = [];
  for (let index = 0; index < chars.length; index++) {
    const { char, run } = chars[index]!;
    if (/\s/.test(char)) {
      if (!text.endsWith(" ")) {
        text += " ";
        last = " ";
        owner.push(run);
      }
    } else if (
      char === "-" &&
      chars[index + 1]?.char === "\n" &&
      /\p{L}/u.test(last) &&
      /\p{L}/u.test(chars[index + 2]?.char ?? "")
    ) {
      index++;
    } else {
      text += char;
      last = char;
      for (let unit = 0; unit < char.length; unit++) owner.push(run);
    }
  }
  return { text, owner };
}

/** Whether a page's text holds the query, under the same rules as `pdfFindMatchRuns`, without
 * mapping characters back to runs: the page scan checks every page on each query. */
export function pdfFindIncludes(text: string, query: string) {
  const needle = foldQuotes(query.toLowerCase()).replace(/\s+/g, " ");
  if (!needle.trim()) return false;
  return foldQuotes(text.toLowerCase())
    .replace(/(\p{L})-\n(?=\p{L})/gu, "$1")
    .replace(/\s+/g, " ")
    .includes(needle);
}

/** Which text runs hold part of a case-insensitive match, when pdf.js splits words across spans. */
export function pdfFindMatchRuns(runs: readonly string[], query: string) {
  const { text, owner } = pdfFindText(runs);
  const needle = foldQuotes(query.toLowerCase()).replace(/\s+/g, " ");
  const hits = runs.map(() => false);
  if (!needle.trim()) return hits;
  for (
    let match = text.indexOf(needle);
    match !== -1;
    match = text.indexOf(needle, match + needle.length)
  )
    for (let index = match; index < match + needle.length; index++) hits[owner[index]!] = true;
  return hits;
}
