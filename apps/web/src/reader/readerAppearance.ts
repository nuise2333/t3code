import type { ClientSettings } from "@t3tools/contracts/settings";

type ReaderSettings = Pick<
  ClientSettings,
  | "readerTypography"
  | "readerFontSize"
  | "readerJustify"
  | "readerLimitWidth"
  | "readerTheme"
  | "readerTableStyle"
  | "readerZoom"
>;

/** What the reader stylesheet reads from the document root. It renders the defaults without them. */
export function readerRootAppearance(settings: ReaderSettings) {
  return {
    attributes: {
      "data-reader-typography": settings.readerTypography,
      "data-reader-theme": settings.readerTheme,
      "data-reader-table-style": settings.readerTableStyle,
      "data-reader-justify": String(settings.readerJustify),
      "data-reader-limit-width": String(settings.readerLimitWidth),
    },
    variables: {
      "--reader-font-size": `${settings.readerFontSize}px`,
      "--reader-zoom": String(settings.readerZoom / 100),
    },
  };
}

export function applyReaderAppearance(root: HTMLElement, settings: ReaderSettings): void {
  const { attributes, variables } = readerRootAppearance(settings);
  for (const [name, value] of Object.entries(attributes)) root.setAttribute(name, value);
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
}
