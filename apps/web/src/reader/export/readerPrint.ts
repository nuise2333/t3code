type ReaderPaper = "A4" | "letter";

// Where US Letter is the usual paper; everywhere else gets A4.
const LETTER_REGIONS = new Set(["US", "CA", "MX", "PH"]);

export function paperForLocale(locale: string): ReaderPaper {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return region !== undefined && LETTER_REGIONS.has(region) ? "letter" : "A4";
  } catch {
    return "A4";
  }
}

/** One inch margins, the standard margin of a printed page. */
export function readerPrintPageRule(paper: ReaderPaper): string {
  return `@page { size: ${paper}; margin: 72pt; }`;
}

/** The exported document's title, which browsers also offer as the PDF's file name. */
export function readerPrintTitle(documentName: string): string {
  const name = documentName.split(/[\\/]/).at(-1)?.trim() ?? "";
  const stem = name.replace(/\.(?:md|mdx|markdown|mdown|mkd|txt)$/i, "");
  return stem.length > 0 ? stem : "Document";
}
