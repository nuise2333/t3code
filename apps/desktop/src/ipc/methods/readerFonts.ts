import { DesktopReaderFontFaceSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// The only files this method may read; nothing from the renderer selects a path.
const READER_FONT_FILES = [
  { family: "serif", style: "normal", path: "/System/Library/Fonts/NewYork.ttf" },
  { family: "serif", style: "italic", path: "/System/Library/Fonts/NewYorkItalic.ttf" },
  { family: "mono", style: "normal", path: "/System/Library/Fonts/SFNSMono.ttf" },
  { family: "mono", style: "italic", path: "/System/Library/Fonts/SFNSMonoItalic.ttf" },
] as const;

export const readReaderFonts = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_READER_FONTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopReaderFontFaceSchema),
  handler: Effect.fn("desktop.ipc.readerFonts.read")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin") return [];
    const fileSystem = yield* FileSystem.FileSystem;
    const faces = yield* Effect.forEach(
      READER_FONT_FILES,
      ({ family, style, path }) =>
        fileSystem.readFile(path).pipe(
          Effect.map((data) => [{ family, style, data }]),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: "unbounded" },
    );
    return faces.flat();
  }),
});
