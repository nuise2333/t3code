import type { DesktopReaderFontFace } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeEnsureReaderFonts, readerFontFaceInput } from "./readerFonts";

const face = (
  family: DesktopReaderFontFace["family"],
  style: DesktopReaderFontFace["style"],
): DesktopReaderFontFace => ({ family, style, data: new Uint8Array([1]) });

describe("readerFontFaceInput", () => {
  it("maps each face to its reader family and the font's weight axis", () => {
    expect(readerFontFaceInput(face("serif", "italic"))).toEqual({
      family: "T3 Reader Serif",
      descriptors: { style: "italic", weight: "400 1000" },
    });
    expect(readerFontFaceInput(face("mono", "normal"))).toEqual({
      family: "T3 Reader Mono",
      descriptors: { style: "normal", weight: "300 900" },
    });
  });
});

describe("makeEnsureReaderFonts", () => {
  it("reads once for concurrent and later callers and survives a face that fails", async () => {
    const faces = [face("serif", "normal"), face("mono", "normal")];
    const read = vi.fn(async () => faces);
    const register = vi.fn(async (input: DesktopReaderFontFace) => {
      if (input.family === "serif") throw new Error("unparseable");
    });
    const ensure = makeEnsureReaderFonts({ read, register });

    expect(read).not.toHaveBeenCalled();
    await Promise.all([ensure(), ensure()]);
    await ensure();

    expect(read).toHaveBeenCalledTimes(1);
    expect(register.mock.calls).toEqual(faces.map((input) => [input]));
  });

  it("resolves without registering when there is no bridge or the bridge fails", async () => {
    const register = vi.fn(async () => undefined);
    await makeEnsureReaderFonts({ read: () => undefined, register })();
    await makeEnsureReaderFonts({ read: () => Promise.reject(new Error("ipc")), register })();
    expect(register).not.toHaveBeenCalled();
  });
});
