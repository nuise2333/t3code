import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { FilesystemSearchHostInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import {
  hostSearchArgs,
  isHostSearchNoise,
  makeHostSearchCollector,
  makeWithAdapter,
  type HostFileSearchAdapter,
} from "./HostFileSearch.ts";

const HOME = "/Users/me";
const T3_HOME = "/Users/me/.t3";
const darwin = { platform: "darwin" as const, homeDirectory: HOME, t3Home: T3_HOME };

interface FakeRun {
  readonly stdout?: string | Stream.Stream<Uint8Array>;
  readonly stderr?: string;
  readonly code?: number;
}

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

function fakeSpawner(
  respond: (command: SpawnedCommand) => FakeRun | PlatformError.PlatformError,
  onKill: () => void = () => {},
) {
  const spawned: SpawnedCommand[] = [];
  const spawn = (raw: unknown) => {
    const command = raw as SpawnedCommand;
    spawned.push({ command: command.command, args: command.args });
    const run = respond(command);
    if (run instanceof PlatformError.PlatformError) return Effect.fail(run);
    return Effect.addFinalizer(() => Effect.sync(onKill)).pipe(
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(run.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout:
            typeof run.stdout === "string"
              ? Stream.encodeText(Stream.make(run.stdout))
              : (run.stdout ?? Stream.empty),
          stderr: run.stderr ? Stream.encodeText(Stream.make(run.stderr)) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
  };
  return {
    spawned,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
  };
}

const spotlight: HostFileSearchAdapter = { backend: "spotlight", command: "/usr/bin/mdfind" };
const plocate: HostFileSearchAdapter = { backend: "plocate", command: "/usr/bin/plocate" };
const everything: HostFileSearchAdapter = { backend: "everything", command: "es" };

const spotlightRow = (path: string, typeTree: ReadonlyArray<string> = ["public.plain-text"]) =>
  `${path}   kMDItemContentTypeTree = (\n${typeTree.map((type) => `    "${type}"`).join(",\n")}\n)\0`;
const FOLDER_TREE = ["public.folder", "public.directory", "public.item"];

function serviceWith(
  adapter: HostFileSearchAdapter | undefined,
  spawner: ReturnType<typeof fakeSpawner>,
  platform: NodeJS.Platform = "darwin",
) {
  return makeWithAdapter(adapter).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-host-search-config-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
        // Last, so it shadows the real spawner NodeServices also provides.
        spawner.layer,
      ),
    ),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.HomeDirectory, HOME),
  );
}

function searchWith(
  adapter: HostFileSearchAdapter | undefined,
  spawner: ReturnType<typeof fakeSpawner>,
  input: FilesystemSearchHostInput,
  platform: NodeJS.Platform = "darwin",
) {
  return serviceWith(adapter, spawner, platform).pipe(
    Effect.flatMap((service) => service.search(input)),
  );
}

describe("hostSearchArgs", () => {
  it.each([
    [
      "spotlight escapes quotes and wildcards",
      "spotlight",
      { query: `a"b*c?\\d'e` },
      ["-0", "-attr", "kMDItemContentTypeTree", `kMDItemFSName == "*a\\"b\\*c\\?\\\\d\\'e*"cd`],
    ],
    [
      "spotlight asks the index for folders only",
      "spotlight",
      { query: "src", kind: "directory" },
      [
        "-0",
        "-attr",
        "kMDItemContentTypeTree",
        `kMDItemFSName == "*src*"cd && kMDItemContentTypeTree == "public.directory"`,
      ],
    ],
    [
      "spotlight keeps packages such as .app out of files",
      "spotlight",
      { query: "calc", kind: "file" },
      [
        "-0",
        "-attr",
        "kMDItemContentTypeTree",
        `kMDItemFSName == "*calc*"cd && kMDItemContentTypeTree != "public.directory"`,
      ],
    ],
    [
      "plocate ends options before the query",
      "plocate",
      { query: "-rf notes" },
      ["-i", "-b", "-0", "-l", "50000", "--", "-rf notes"],
    ],
    [
      "locate globs a query that holds wildcards literally",
      "locate",
      { query: "a*b[1]" },
      ["-i", "-b", "-0", "-l", "50000", "--", "*a\\*b\\[1\\]*"],
    ],
    [
      "everything escapes a query that starts with a dash and drops characters names cannot hold",
      "everything",
      { query: `-n 1 "x|y"`, kind: "file" },
      ["-n", "50000", "/a-d", "-r", "\\-n 1 xy"],
    ],
    [
      "everything escapes regex and search syntax",
      "everything",
      { query: "!a.b (1)=c", kind: "directory" },
      ["-n", "50000", "/ad", "-r", "\\!a\\.b \\(1\\)\\=c"],
    ],
    ["everything has nothing to search in a query of quotes", "everything", { query: `""` }, null],
  ] as const)("%s", (_name, backend, input, expected) => {
    expect(hostSearchArgs(backend, input)).toEqual(expected);
  });
});

describe("isHostSearchNoise", () => {
  it.each([
    ["/Users/me/Projects/app/node_modules/react/index.js", darwin, true],
    ["/Users/me/Projects/app/.git/config", darwin, true],
    ["/Users/me/.config/notes.md", darwin, true],
    ["/Users/me/Library/Caches/report.pdf", darwin, true],
    ["/Users/me/Library/Mobile Documents/com~apple~CloudDocs/report.pdf", darwin, false],
    ["/Users/me/Library/CloudStorage/Dropbox/report.pdf", darwin, false],
    ["/Users/me/Library/CloudStorage/Dropbox/.dropbox.cache/report.pdf", darwin, true],
    ["/System/Library/report.pdf", darwin, true],
    ["/private/var/report.pdf", darwin, true],
    ["/Users/me/.t3/userdata/report.pdf", darwin, true],
    [
      "/srv/t3/userdata/report.pdf",
      { platform: "linux" as const, homeDirectory: "/home/me", t3Home: "/srv/t3" },
      true,
    ],
    ["/Users/me/Documents/report.pdf", darwin, false],
    ["/Users/me/LibraryNotes/report.pdf", darwin, false],
    ["//server/share/report.pdf", darwin, true],
    ["/home/me/Library/report.pdf", { ...darwin, platform: "linux" as const }, false],
    [
      "C:\\Users\\me\\AppData\\Local\\report.pdf",
      { platform: "win32" as const, homeDirectory: "C:\\Users\\me", t3Home: "C:\\t3" },
      true,
    ],
    [
      "C:\\$Recycle.Bin\\report.pdf",
      { platform: "win32" as const, homeDirectory: "C:\\Users\\me", t3Home: "C:\\t3" },
      true,
    ],
    [
      "c:\\T3\\userdata\\report.pdf",
      { platform: "win32" as const, homeDirectory: "C:\\Users\\me", t3Home: "C:\\t3" },
      true,
    ],
    [
      "C:\\Users\\me\\Documents\\report.pdf",
      { platform: "win32" as const, homeDirectory: "C:\\Users\\me", t3Home: "C:\\t3" },
      false,
    ],
  ])("%s", (path, context, expected) => {
    expect(isHostSearchNoise(path, context)).toBe(expected);
  });
});

describe("makeHostSearchCollector", () => {
  it("reads NUL-separated rows split across chunks and ranks NFD names against an NFC query", () => {
    const collector = makeHostSearchCollector({
      backend: "plocate",
      input: { query: "café" },
      context: { ...darwin, platform: "linux" },
      capacity: 10,
    });
    const nfd = "/home/me/docs/Cafe\u0301 menu.txt";
    const output = `/home/me/a/long/path/xcafe-noise-café.txt\0${nfd}\0/home/me/café.txt\0/home/me/node_modules/café.txt\0/home/me/tea.txt`;
    expect(collector.push(output.slice(0, 20))).toBe(true);
    expect(collector.push(output.slice(20))).toBe(true);
    collector.end();
    expect(collector.rawRows).toBe(5);
    expect(collector.rows().map((row) => row.path)).toEqual([
      "/home/me/café.txt",
      nfd,
      "/home/me/a/long/path/xcafe-noise-café.txt",
    ]);
  });

  it("breaks equal scores toward the shorter path", () => {
    const collector = makeHostSearchCollector({
      backend: "plocate",
      input: { query: "notes" },
      context: { ...darwin, platform: "linux" },
      capacity: 10,
    });
    collector.push("/home/me/deeper/folder/notes\0/home/me/notes\0");
    expect(collector.rows().map((row) => row.path)).toEqual([
      "/home/me/notes",
      "/home/me/deeper/folder/notes",
    ]);
  });

  it("stops at the raw cap, counting rows the filters drop", () => {
    const collector = makeHostSearchCollector({
      backend: "plocate",
      input: { query: "ab" },
      context: { ...darwin, platform: "linux" },
      capacity: 10,
      rawCap: 3,
    });
    expect(collector.push("/x/node_modules/ab\0/x/.git/ab\0/x/ab\0/x/abc\0")).toBe(false);
    expect(collector.capped).toBe(true);
    expect(collector.rows().map((row) => row.path)).toEqual(["/x/ab"]);
  });

  it("keeps only the category's files and reads Spotlight's kind", () => {
    const collector = makeHostSearchCollector({
      backend: "spotlight",
      input: { query: "plan", category: "document" },
      context: darwin,
      capacity: 10,
    });
    collector.push(
      spotlightRow("/Users/me/plan.pdf", ["com.adobe.pdf", "public.data"]) +
        spotlightRow("/Users/me/plan.png", ["public.png", "public.image"]) +
        spotlightRow("/Users/me/plan.md", FOLDER_TREE),
    );
    expect(collector.rows()).toEqual([{ path: "/Users/me/plan.pdf", kind: "file" }]);
  });

  it("reads a Spotlight package such as .app as a directory", () => {
    const collector = makeHostSearchCollector({
      backend: "spotlight",
      input: { query: "calculator" },
      context: darwin,
      capacity: 10,
    });
    collector.push(
      spotlightRow("/Applications/Calculator.app", [
        "com.apple.application-bundle",
        "com.apple.bundle",
        "public.directory",
        "com.apple.package",
      ]),
    );
    expect(collector.rows()).toEqual([{ path: "/Applications/Calculator.app", kind: "directory" }]);
  });
});

describe("HostFileSearch.search", () => {
  it.effect("runs mdfind by absolute path and returns Spotlight's kinds", () =>
    Effect.gen(function* () {
      const spawner = fakeSpawner(() => ({
        stdout:
          spotlightRow("/Users/me/Projects", FOLDER_TREE) +
          spotlightRow("/Users/me/Projects.txt") +
          spotlightRow("/Users/me/Library/Projects.txt"),
      }));
      const result = yield* searchWith(spotlight, spawner, { query: "projects", limit: 1 });
      expect(spawner.spawned[0]?.command).toBe("/usr/bin/mdfind");
      expect(result).toEqual({
        entries: [{ path: "/Users/me/Projects", kind: "directory" }],
        truncated: true,
      });
    }),
  );

  it.effect("stats locate rows for their kind, dropping rows gone from disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-host-search-" });
      yield* fs.makeDirectory(path.join(root, "notes"));
      yield* fs.writeFileString(path.join(root, "notes.txt"), "");
      const spawner = fakeSpawner(() => ({
        stdout: [
          path.join(root, "notes"),
          path.join(root, "notes.txt"),
          path.join(root, "notes-gone.txt"),
        ].join("\0"),
      }));
      const result = yield* searchWith(
        plocate,
        spawner,
        { query: "notes", limit: 10, kind: "file" },
        "linux",
      );
      expect(result).toEqual({
        entries: [{ path: path.join(root, "notes.txt"), kind: "file" }],
        truncated: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the rows read so far once the deadline passes", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const spawner = fakeSpawner(() => ({
        stdout: Stream.encodeText(Stream.make(spotlightRow("/Users/me/early.txt"))).pipe(
          Stream.concat(Stream.fromEffect(Deferred.succeed(reading, undefined)).pipe(Stream.drain)),
          Stream.concat(Stream.never),
        ),
      }));
      const fiber = yield* searchWith(spotlight, spawner, { query: "early", limit: 10 }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(reading);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({
        entries: [{ path: "/Users/me/early.txt", kind: "file" }],
        truncated: true,
      });
    }),
  );

  it.effect("kills the index process when the search is interrupted", () =>
    Effect.gen(function* () {
      let killed = 0;
      const reading = yield* Deferred.make<void>();
      const spawner = fakeSpawner(
        () => ({
          stdout: Stream.fromEffect(Deferred.succeed(reading, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
          ),
        }),
        () => (killed += 1),
      );
      const fiber = yield* searchWith(spotlight, spawner, { query: "stale", limit: 10 }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(reading);
      yield* Fiber.interrupt(fiber);
      expect(killed).toBe(1);
    }),
  );

  it.effect.each([
    ["no index was found", undefined, () => ({}), "linux"],
    ["mdfind exits non-zero", spotlight, () => ({ code: 1 }), "darwin"],
    [
      "Spotlight indexing is off",
      spotlight,
      (command: SpawnedCommand) =>
        command.command === "/usr/bin/mdutil" ? { stdout: "/:\n\tIndexing disabled.\n" } : {},
      "darwin",
    ],
    [
      "plocate cannot open its database",
      plocate,
      () => ({
        code: 1,
        stderr: "plocate: /var/lib/plocate/plocate.db: No such file or directory",
      }),
      "linux",
    ],
    ["Everything is not running", everything, () => ({ code: 8 }), "win32"],
    [
      "the index binary disappeared",
      plocate,
      () =>
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: "/usr/bin/plocate",
        }),
      "linux",
    ],
  ] as const)("reports unavailable when %s", ([_name, adapter, respond, platform]) =>
    Effect.gen(function* () {
      const error = yield* searchWith(
        adapter,
        fakeSpawner(respond),
        { query: "notes", limit: 10 },
        platform,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "FilesystemSearchHostError", reason: "unavailable" });
    }),
  );

  it.effect("probes Spotlight indexing once for a run of empty searches", () =>
    Effect.gen(function* () {
      const spawner = fakeSpawner(() => ({}));
      const service = yield* serviceWith(spotlight, spawner);
      yield* service.search({ query: "zq", limit: 10 });
      yield* service.search({ query: "zqx", limit: 10 });
      const probes = () =>
        spawner.spawned.filter((command) => command.command === "/usr/bin/mdutil").length;
      expect(probes()).toBe(1);
      yield* TestClock.adjust("31 seconds");
      yield* service.search({ query: "zqxw", limit: 10 });
      expect(probes()).toBe(2);
    }),
  );

  it.effect("treats a quiet locate exit 1 as no matches", () =>
    Effect.gen(function* () {
      const result = yield* searchWith(
        plocate,
        fakeSpawner(() => ({ code: 1 })),
        { query: "notes", limit: 10 },
        "linux",
      );
      expect(result).toEqual({ entries: [], truncated: false });
    }),
  );
});
