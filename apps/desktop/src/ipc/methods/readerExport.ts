import {
  DesktopReaderPdfExportInputSchema,
  DesktopReaderPdfExportResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class DesktopReaderPdfExportError extends Schema.TaggedError<DesktopReaderPdfExportError>()(
  "DesktopReaderPdfExportError",
  {
    step: Schema.Literals(["sender", "dialog", "print", "write"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Exporting the reading view as PDF failed at the ${this.step} step.`;
  }
}

/** A plain file name for the save dialog, whatever the page sent as the document's title. */
export function readerPdfFileName(title: string): string {
  const name = (title.split(/[\\/]/).at(-1) ?? "")
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .trim()
    .replace(/^\.+/, "");
  const stem = name.replace(/\.pdf$/i, "");
  return `${stem.length > 0 ? stem : "Document"}.pdf`;
}

const PAGE_NUMBER_FOOTER =
  '<div style="width:100%;text-align:center;font:8pt -apple-system,system-ui,sans-serif;color:#7c7c7c"><span class="pageNumber"></span></div>';

export const exportReaderPdf = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXPORT_READER_PDF_CHANNEL,
  payload: DesktopReaderPdfExportInputSchema,
  result: DesktopReaderPdfExportResultSchema,
  handler: Effect.fn("desktop.ipc.readerExport.exportPdf")(function* (input, event) {
    const contents = event === undefined ? undefined : Electron.webContents.fromId(event.sender.id);
    if (contents === undefined) {
      return yield* new DesktopReaderPdfExportError({ step: "sender" });
    }
    const owner = Electron.BrowserWindow.fromWebContents(contents);
    const options: Electron.SaveDialogOptions = {
      defaultPath: readerPdfFileName(input.title),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const choice = yield* Effect.tryPromise({
      try: () =>
        owner === null
          ? Electron.dialog.showSaveDialog(options)
          : Electron.dialog.showSaveDialog(owner, options),
      catch: (cause) => new DesktopReaderPdfExportError({ step: "dialog", cause }),
    });
    if (choice.canceled || !choice.filePath) return "canceled" as const;

    // Paper size and margins come from the page's @page rule; the footer numbers the pages.
    const pdf = yield* Effect.tryPromise({
      try: () =>
        contents.printToPDF({
          preferCSSPageSize: true,
          printBackground: true,
          margins: { top: 1, bottom: 1, left: 1, right: 1 },
          displayHeaderFooter: true,
          headerTemplate: "<span></span>",
          footerTemplate: PAGE_NUMBER_FOOTER,
          generateDocumentOutline: true,
          generateTaggedPDF: true,
        }),
      catch: (cause) => new DesktopReaderPdfExportError({ step: "print", cause }),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .writeFile(choice.filePath, new Uint8Array(pdf))
      .pipe(Effect.mapError((cause) => new DesktopReaderPdfExportError({ step: "write", cause })));
    return "saved" as const;
  }),
});
