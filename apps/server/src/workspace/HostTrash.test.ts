// @effect-diagnostics nodeBuiltinImport:off - the home trash is plain Node file system code.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  HostTrash,
  layer,
  parseHelperOutcomes,
  trashInfoContents,
  trashIntoHomeTrash,
} from "./HostTrash.ts";

const isWindows = HostProcess.Platform.defaultValue() === "win32";

const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-host-trash-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string;
}

function fakeSpawner(stdout: string) {
  const spawned: Spawned[] = [];
  const spawn = (raw: unknown) =>
    Effect.gen(function* () {
      const command = raw as ChildProcess.StandardCommand;
      const stdin = command.options.stdin;
      const input =
        typeof stdin === "object" && stdin !== null && "stream" in stdin
          ? yield* (stdin.stream as Stream.Stream<Uint8Array>).pipe(
              Stream.decodeText,
              Stream.mkString,
            )
          : "";
      spawned.push({ command: command.command, args: command.args.map(String), stdin: input });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    });
  return {
    spawned,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
  };
}

const trashWith = (
  platform: NodeJS.Platform,
  spawner: ReturnType<typeof fakeSpawner>,
  paths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const service = yield* HostTrash;
    return yield* service.trash(paths);
  }).pipe(
    // The fake spawner comes last, so it shadows the real one NodeServices also provides.
    Effect.provide(layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, spawner.layer)))),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Environment, { SYSTEMROOT: "C:\\Windows" }),
  );

describe("parseHelperOutcomes", () => {
  it.each([
    ['["trashed","not_found"]', 2, ["trashed", "not_found"]],
    // Windows PowerShell 5.1 unwraps a one-element array.
    ['"unavailable"', 1, ["unavailable"]],
    ['["trashed","bogus"]', 2, ["trashed", "failed"]],
    ['["trashed"]', 2, ["failed", "failed"]],
    ["osascript: execution error", 1, ["failed"]],
  ])("reads %s for %i paths", (stdout, count, expected) => {
    expect(parseHelperOutcomes(stdout, count)).toEqual(expected);
  });
});

describe("HostTrash", () => {
  const awkwardPath = isWindows
    ? 'C:\\Users\\me\\it\'s "quoted"; $(rm).txt'
    : '/Users/me/it\'s "quoted"; $(rm) `x`.txt';

  it.effect.each([
    { platform: "darwin" as const, command: "/usr/bin/osascript" },
    {
      platform: "win32" as const,
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    },
  ])("passes paths to the $platform helper on stdin only", ({ platform, command }) =>
    Effect.gen(function* () {
      const spawner = fakeSpawner('["trashed","permission_denied"]');
      const outcomes = yield* trashWith(platform, spawner, [awkwardPath, "/second"]);
      expect(outcomes).toEqual(["trashed", "permission_denied"]);
      expect(spawner.spawned).toHaveLength(1);
      const [spawned] = spawner.spawned;
      expect(spawned?.command).toBe(command);
      expect(spawned?.args.join("\n")).not.toContain("quoted");
      expect(JSON.parse(spawned?.stdin ?? "")).toEqual([awkwardPath, "/second"]);
    }),
  );

  it.effect("reports an item the helper claims to trash but leaves in place as failed", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const kept = NodePath.join(root, "kept.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(kept, ""));
      const spawner = fakeSpawner('["trashed","trashed"]');
      const outcomes = yield* trashWith("darwin", spawner, [kept, NodePath.join(root, "gone")]);
      expect(outcomes).toEqual(["failed", "trashed"]);
    }),
  );
});

describe("freedesktop home trash", () => {
  it("encodes the original path and the local deletion time", () => {
    const deletedAt = DateTime.toEpochMillis(
      DateTime.makeZonedUnsafe(
        { year: 2026, month: 1, day: 2, hour: 3, minute: 4, second: 5 },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      ),
    );
    expect(trashInfoContents("/home/me/a b/ü%.txt", deletedAt)).toBe(
      "[Trash Info]\nPath=/home/me/a%20b/%C3%BC%25.txt\nDeletionDate=2026-01-02T03:04:05\n",
    );
  });

  it.effect.skipIf(isWindows)("moves items in and keeps both on a taken trash name", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const dataHome = NodePath.join(root, "share");
      for (const contents of ["first", "second"]) {
        const item = NodePath.join(root, "notes.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(item, contents));
        expect(yield* Effect.promise(() => trashIntoHomeTrash(item, dataHome, 0))).toBe("trashed");
      }
      const files = NodePath.join(dataHome, "Trash", "files");
      const info = NodePath.join(dataHome, "Trash", "info");
      expect((yield* Effect.promise(() => NodeFSP.readdir(files))).toSorted()).toEqual([
        "notes.txt",
        "notes.txt.2",
      ]);
      expect((yield* Effect.promise(() => NodeFSP.readdir(info))).toSorted()).toEqual([
        "notes.txt.2.trashinfo",
        "notes.txt.trashinfo",
      ]);
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(files, "notes.txt.2"), "utf8")),
      ).toBe("second");
      expect(
        yield* Effect.promise(() => trashIntoHomeTrash(NodePath.join(root, "gone"), dataHome, 0)),
      ).toBe("not_found");
    }),
  );

  it.effect.skipIf(isWindows || process.getuid?.() === 0)(
    "removes the info file again when the move fails",
    () =>
      Effect.gen(function* () {
        const root = yield* tempDirectory;
        const dataHome = NodePath.join(root, "share");
        const locked = NodePath.join(root, "locked");
        yield* Effect.promise(() => NodeFSP.mkdir(locked));
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(locked, "kept.txt"), ""));
        yield* Effect.promise(() => NodeFSP.chmod(locked, 0o500));
        yield* Effect.addFinalizer(() => Effect.promise(() => NodeFSP.chmod(locked, 0o700)));

        expect(
          yield* Effect.promise(() =>
            trashIntoHomeTrash(NodePath.join(locked, "kept.txt"), dataHome, 0),
          ),
        ).toBe("permission_denied");
        expect(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(dataHome, "Trash", "info"))),
        ).toEqual([]);
      }),
  );
});
