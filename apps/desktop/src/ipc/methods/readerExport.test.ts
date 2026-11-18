import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";
import type * as Electron from "electron";

const { fromId, fromWebContents, showSaveDialog } = vi.hoisted(() => ({
  fromId: vi.fn(),
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { fromId },
  BrowserWindow: { fromWebContents },
  dialog: { showSaveDialog },
}));

import { exportReaderPdf, readerPdfFileName } from "./readerExport.ts";

function setup(choice: { canceled: boolean; filePath?: string }) {
  const printToPDF = vi.fn((_options: Electron.PrintToPDFOptions) =>
    Promise.resolve(Buffer.from([1, 2, 3])),
  );
  const owner = { id: 1 };
  fromId.mockReset().mockImplementation((id: number) => (id === 7 ? { printToPDF } : undefined));
  fromWebContents.mockReset().mockReturnValue(owner);
  showSaveDialog.mockReset().mockResolvedValue(choice);
  const writes: Array<{ path: string; data: Uint8Array }> = [];
  const fileSystem = FileSystem.layerNoop({
    writeFile: (path, data) => {
      writes.push({ path, data });
      return Effect.void;
    },
  });
  const run = (title: string, senderId = 7) =>
    exportReaderPdf
      .handler({ title }, { sender: { id: senderId } })
      .pipe(Effect.provide(fileSystem));
  return { owner, printToPDF, writes, run };
}

describe("exportReaderPdf", () => {
  it.effect("prints the calling page to the chosen file", () =>
    Effect.gen(function* () {
      const { owner, printToPDF, writes, run } = setup({
        canceled: false,
        filePath: "/tmp/notes.pdf",
      });
      assert.strictEqual(yield* run("../notes"), "saved");
      assert.deepEqual(showSaveDialog.mock.calls[0], [
        owner,
        { defaultPath: "notes.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] },
      ]);
      assert.include(printToPDF.mock.calls[0]?.[0], {
        preferCSSPageSize: true,
        printBackground: true,
      });
      assert.deepEqual(writes, [{ path: "/tmp/notes.pdf", data: new Uint8Array([1, 2, 3]) }]);
    }),
  );

  it.effect("prints nothing when the save dialog is dismissed", () =>
    Effect.gen(function* () {
      const { printToPDF, writes, run } = setup({ canceled: true });
      assert.strictEqual(yield* run("notes"), "canceled");
      assert.strictEqual(printToPDF.mock.calls.length, 0);
      assert.deepEqual(writes, []);
    }),
  );

  it.effect("fails for a sender that is gone", () =>
    Effect.gen(function* () {
      const { run } = setup({ canceled: false, filePath: "/tmp/notes.pdf" });
      const exit = yield* Effect.exit(run("notes", 8));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(showSaveDialog.mock.calls.length, 0);
    }),
  );
});

describe("readerPdfFileName", () => {
  it("keeps only a plain file name ending in .pdf", () => {
    assert.strictEqual(readerPdfFileName("notes"), "notes.pdf");
    assert.strictEqual(readerPdfFileName("notes.PDF"), "notes.pdf");
    assert.strictEqual(readerPdfFileName("docs/guide/intro"), "intro.pdf");
    assert.strictEqual(readerPdfFileName("..\\..\\secret"), "secret.pdf");
    assert.strictEqual(readerPdfFileName('a:b*c?"d'), "abcd.pdf");
    assert.strictEqual(readerPdfFileName(".hidden"), "hidden.pdf");
    assert.strictEqual(readerPdfFileName("  "), "Document.pdf");
  });
});
