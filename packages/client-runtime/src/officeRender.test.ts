import { describe, expect, it } from "vite-plus/test";

import {
  officePreviewView,
  officeRenderFallback,
  prepareOfficeRender,
  type OfficeRenderState,
} from "./officeRender.ts";

const pdf: OfficeRenderState = { _tag: "pdf", url: "https://host/render" };
const fallback = (reason: "unavailable" | "failed" | "unsupported"): OfficeRenderState => ({
  _tag: "fallback",
  reason,
});
const sheet = { renderKind: "spreadsheet", hasParser: true, hasSource: true } as const;
const doc = {
  renderKind: "document",
  hasParser: true,
  hasSource: true,
  sheetView: "layout",
} as const;

describe("officePreviewView", () => {
  it.each([
    ["a rendered document", { ...doc, render: pdf }, "pdf", null, false],
    ["a converting document", { ...doc, render: { _tag: "loading" } }, "loading", null, false],
    [
      "a host without LibreOffice",
      { ...doc, render: fallback("unavailable") },
      "parser",
      "Install LibreOffice on this computer to see the original layout.",
      false,
    ],
    [
      "a file LibreOffice rejects",
      { ...doc, render: fallback("failed") },
      "parser",
      "LibreOffice couldn't open this file; showing a simplified preview.",
      false,
    ],
    [
      "a host that predates rendering",
      { ...doc, render: fallback("unsupported") },
      "parser",
      null,
      false,
    ],
    [
      "a file not yet on the host",
      { ...doc, hasSource: false, render: pdf },
      "parser",
      null,
      false,
    ],
    ["a spreadsheet", { ...sheet, sheetView: "layout", render: pdf }, "pdf", null, true],
    [
      "a spreadsheet in grid view",
      { ...sheet, sheetView: "grid", render: pdf },
      "parser",
      null,
      true,
    ],
    [
      "a spreadsheet LibreOffice rejects",
      { ...sheet, sheetView: "layout", render: fallback("failed") },
      "parser",
      "LibreOffice couldn't open this file; showing a simplified preview.",
      false,
    ],
    [
      "a legacy spreadsheet, which has no grid",
      { ...sheet, hasParser: false, sheetView: "grid", render: pdf },
      "pdf",
      null,
      false,
    ],
    [
      "a legacy document LibreOffice rejects",
      { ...doc, hasParser: false, render: fallback("failed") },
      "none",
      "LibreOffice couldn't open this file.",
      false,
    ],
    ["a notebook", { ...doc, renderKind: null, render: pdf }, "parser", null, false],
  ] as const)("shows %s", (_name, input, body, notice, sheetToggle) => {
    expect(officePreviewView(input)).toEqual({ body, notice, sheetToggle });
  });
});

describe("prepareOfficeRender", () => {
  const signal = new AbortController().signal;
  const respond = (status: number) => async () => ({ ok: status < 300, status, body: null });

  it.each([
    [206, pdf],
    [503, fallback("unavailable")],
    [422, fallback("failed")],
    [404, fallback("unsupported")],
  ])("maps HTTP %i from the conversion", async (status, expected) => {
    const requests: Array<Record<string, string>> = [];
    const result = await prepareOfficeRender({
      mint: async () => "https://host/render",
      fetch: (_url, init) => {
        requests.push(init.headers);
        return respond(status)();
      },
      signal,
    });
    expect(result).toEqual(expected);
    expect(requests).toEqual([{ Range: "bytes=0-0" }]);
  });

  it.each([
    [{ _tag: "AssetOfficeRendererUnavailableError" }, "unavailable"],
    [{ _tag: "AssetOfficeRenderError" }, "failed"],
    [new Error("Unknown asset resource"), "unsupported"],
  ] as const)("maps a refused URL to a fallback", async (cause, reason) => {
    expect(officeRenderFallback(cause)).toBe(reason);
    const result = await prepareOfficeRender({
      mint: () => Promise.reject(cause),
      fetch: respond(200),
      signal,
    });
    expect(result).toEqual(fallback(reason));
  });

  it("falls back without a connection", async () => {
    const result = await prepareOfficeRender({
      mint: async () => null,
      fetch: respond(200),
      signal,
    });
    expect(result).toEqual(fallback("unsupported"));
  });
});
