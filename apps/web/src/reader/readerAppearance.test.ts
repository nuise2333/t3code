import {
  DEFAULT_CLIENT_SETTINGS,
  MAX_READER_ZOOM,
  MIN_READER_ZOOM,
  READER_ZOOM_STEP,
} from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { readerRootAppearance } from "./readerAppearance";

describe("readerRootAppearance", () => {
  it("names the default look on the document root", () => {
    expect(readerRootAppearance(DEFAULT_CLIENT_SETTINGS)).toEqual({
      attributes: {
        "data-reader-typography": "serif",
        "data-reader-theme": "mono",
        "data-reader-table-style": "booktabs",
        "data-reader-justify": "true",
        "data-reader-limit-width": "true",
      },
      variables: { "--reader-font-size": "16px", "--reader-zoom": "1" },
    });
  });

  it("follows every reader setting", () => {
    expect(
      readerRootAppearance({
        readerTypography: "serif-charter",
        readerFontSize: 18,
        readerJustify: false,
        readerLimitWidth: false,
        readerTheme: "app",
        readerTableStyle: "grid",
        readerZoom: 130,
      }),
    ).toEqual({
      attributes: {
        "data-reader-typography": "serif-charter",
        "data-reader-theme": "app",
        "data-reader-table-style": "grid",
        "data-reader-justify": "false",
        "data-reader-limit-width": "false",
      },
      variables: { "--reader-font-size": "18px", "--reader-zoom": "1.3" },
    });
  });

  it("writes each zoom step as a short factor, free of floating point noise", () => {
    const steps = Array.from(
      { length: (MAX_READER_ZOOM - MIN_READER_ZOOM) / READER_ZOOM_STEP + 1 },
      (_, index) => MIN_READER_ZOOM + index * READER_ZOOM_STEP,
    );
    const factors = steps.map(
      (readerZoom) =>
        readerRootAppearance({ ...DEFAULT_CLIENT_SETTINGS, readerZoom }).variables["--reader-zoom"],
    );
    expect(factors.join(" ")).toBe("0.8 0.9 1 1.1 1.2 1.3 1.4 1.5 1.6 1.7 1.8 1.9 2");
  });
});
