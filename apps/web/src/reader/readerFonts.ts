import type { DesktopReaderFontFace } from "@t3tools/contracts";

// Ranges are the fonts' own wght axes: New York 400..1000, SF Mono 294.67..900.
const READER_FONT_FAMILIES = {
  serif: { family: "T3 Reader Serif", weight: "400 1000" },
  mono: { family: "T3 Reader Mono", weight: "300 900" },
} as const;

/** The upright serif again with tabular figures on: a canvas cannot ask for them otherwise. */
export const READER_SERIF_FIGURES = "T3 Reader Serif Figures";

export function readerFontFaceInput(face: Pick<DesktopReaderFontFace, "family" | "style">) {
  const { family, weight } = READER_FONT_FAMILIES[face.family];
  return { family, descriptors: { style: face.style, weight } };
}

export interface ReaderFontSource {
  readonly read: () => Promise<readonly DesktopReaderFontFace[]> | undefined;
  readonly register: (face: DesktopReaderFontFace) => Promise<void>;
}

/** Never rejects: a face that cannot be read or parsed leaves the CSS fallback stack in use. */
export function makeEnsureReaderFonts(source: ReaderFontSource) {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= (async () => {
      const faces = await source.read();
      await Promise.allSettled((faces ?? []).map((face) => source.register(face)));
    })().catch(() => undefined));
}

export const ensureReaderFonts = makeEnsureReaderFonts({
  read: () => (typeof window === "undefined" ? undefined : window.desktopBridge?.readReaderFonts()),
  register: async (face) => {
    const { family, descriptors } = readerFontFaceInput(face);
    const data = new Uint8Array(face.data);
    document.fonts.add(await new FontFace(family, data, descriptors).load());
    if (face.family === "serif" && face.style === "normal") {
      const figures = { ...descriptors, featureSettings: '"tnum"' };
      document.fonts.add(await new FontFace(READER_SERIF_FIGURES, data, figures).load());
    }
  },
});
