import "./readerPrint.css";

import { paperForLocale, readerPrintPageRule, readerPrintTitle } from "./readerPrint";

type ReaderExportResult = "saved" | "canceled" | "printing";

let isExporting = false;

/** Marks `reader` as the only thing to print and returns the undo. */
function prepareReaderPrint(reader: HTMLElement, title: string): () => void {
  const root = document.documentElement;
  const path: HTMLElement[] = [];
  for (let node = reader.parentElement; node !== null && node !== document.body;) {
    path.push(node);
    node = node.parentElement;
  }
  const pageRule = document.createElement("style");
  pageRule.textContent = readerPrintPageRule(paperForLocale(navigator.language));
  const previousTitle = document.title;

  root.setAttribute("data-reader-printing", "");
  reader.setAttribute("data-reader-print-target", "");
  for (const node of path) node.setAttribute("data-reader-print-path", "");
  document.head.append(pageRule);
  // Browsers name the saved PDF after the document's title.
  document.title = title;

  let isDone = false;
  return () => {
    if (isDone) return;
    isDone = true;
    root.removeAttribute("data-reader-printing");
    reader.removeAttribute("data-reader-print-target");
    for (const node of path) node.removeAttribute("data-reader-print-path");
    pageRule.remove();
    // The app retitles the window as threads change; keep a title written during the export.
    if (document.title === title) document.title = previousTitle;
  };
}

/** Pictures below the scrolled view may not have loaded; the page is printed whole. */
async function loadReaderImages(reader: HTMLElement): Promise<void> {
  const images = [...reader.querySelectorAll("img")];
  for (const image of images) if (image.loading === "lazy") image.loading = "eager";
  await Promise.all([
    document.fonts.ready,
    ...images.map((image) => image.decode().catch(() => undefined)),
  ]);
}

/**
 * Prints the reading view alone on white paper. The desktop app asks where to save and writes
 * the PDF itself; a browser opens its print dialog, where the PDF is one of the destinations.
 */
export async function exportReaderAsPdf(
  reader: HTMLElement,
  documentName: string,
): Promise<ReaderExportResult> {
  if (isExporting) return "canceled";
  isExporting = true;
  const title = readerPrintTitle(documentName);
  const restore = prepareReaderPrint(reader, title);
  let awaitsAfterPrint = false;
  try {
    await loadReaderImages(reader);
    const bridge = window.desktopBridge;
    if (typeof bridge?.exportReaderPdf === "function") {
      return await bridge.exportReaderPdf({ title });
    }
    window.addEventListener("afterprint", restore, { once: true });
    awaitsAfterPrint = true;
    // Blocks until the dialog closes in most browsers; others print later and then fire afterprint.
    window.print();
    return "printing";
  } catch (error) {
    restore();
    throw error;
  } finally {
    if (!awaitsAfterPrint) restore();
    isExporting = false;
  }
}
