import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { readReaderFonts } from "./readerFonts.ts";

describe("readReaderFonts", () => {
  it.effect("reads only the fixed macOS font files and skips unreadable ones", () =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      const fileSystem = FileSystem.layerNoop({
        readFile: (path) => {
          reads.push(path);
          return path.endsWith("/SFNSMonoItalic.ttf")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFile",
                }),
              )
            : Effect.succeed(new Uint8Array([reads.length]));
        },
      });
      const read = (raw: unknown, platform: NodeJS.Platform) =>
        readReaderFonts.handler(raw).pipe(
          Effect.provide(
            Layer.merge(
              fileSystem,
              Layer.succeed(
                DesktopEnvironment.DesktopEnvironment,
                DesktopEnvironment.DesktopEnvironment.of({
                  platform,
                } as DesktopEnvironment.DesktopEnvironment["Service"]),
              ),
            ),
          ),
        );

      assert.deepEqual(yield* read(undefined, "linux"), []);
      assert.deepEqual(yield* read(undefined, "win32"), []);
      assert.deepEqual(reads, []);

      const faces = yield* read("/etc/passwd", "darwin");
      assert.deepEqual(reads, [
        "/System/Library/Fonts/NewYork.ttf",
        "/System/Library/Fonts/NewYorkItalic.ttf",
        "/System/Library/Fonts/SFNSMono.ttf",
        "/System/Library/Fonts/SFNSMonoItalic.ttf",
      ]);
      assert.deepEqual(faces, [
        { family: "serif", style: "normal", data: new Uint8Array([1]) },
        { family: "serif", style: "italic", data: new Uint8Array([2]) },
        { family: "mono", style: "normal", data: new Uint8Array([3]) },
      ]);
    }),
  );
});
