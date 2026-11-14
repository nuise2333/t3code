// @effect-diagnostics nodeBuiltinImport:off - fixtures need hard links, sparse files, and a failing rename.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { FilesystemFileOperation } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import {
  COPY_MAX_BYTES,
  isCaseOnlyRename,
  isValidFileName,
  keepBothName,
  make,
} from "./FileOperations.ts";
import * as HostTrash from "./HostTrash.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
});

const isWindows = HostProcess.Platform.defaultValue() === "win32";

const within = (candidate: string, root: string) => {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

interface SetupOptions {
  /** The root counts as a project, so links may not lead out of it. */
  readonly scoped?: boolean;
  readonly workspaceRoots?: ReadonlyArray<string>;
  readonly trash?: (paths: ReadonlyArray<string>) => ReadonlyArray<HostTrash.HostTrashOutcome>;
  readonly refresh?: (cwd: string) => Effect.Effect<void>;
}

const setup = Effect.fn("setup")(function* (options: SetupOptions = {}) {
  const temp = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-file-ops-"))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  const parent = yield* Effect.promise(() => NodeFSP.realpath(temp));
  const root = NodePath.join(parent, "root");
  const outside = NodePath.join(parent, "outside");
  yield* Effect.promise(() => NodeFSP.mkdir(root));
  yield* Effect.promise(() => NodeFSP.mkdir(outside));
  const trashed: Array<ReadonlyArray<string>> = [];
  const context = yield* Layer.build(
    Layer.mergeAll(
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({
        contains: (realPath) => Effect.succeed(options.scoped === true && within(realPath, root)),
        holdsWorkspaceRoot: (realPath) =>
          Effect.succeed((options.workspaceRoots ?? []).some((known) => within(known, realPath))),
      }),
      Layer.mock(WorkspaceEntries.WorkspaceEntries)({
        refresh: options.refresh ?? (() => Effect.void),
      }),
      Layer.succeed(
        HostTrash.HostTrash,
        HostTrash.HostTrash.of({
          trash: (paths) =>
            Effect.promise(async () => {
              trashed.push(paths);
              if (options.trash) return options.trash(paths);
              for (const path of paths) await NodeFSP.rm(path, { recursive: true });
              return paths.map((): HostTrash.HostTrashOutcome => "trashed");
            }),
        }),
      ),
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-file-ops-config-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  );
  const service = yield* make.pipe(Effect.provide(context));
  const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(context));
  yield* Effect.promise(() => NodeFSP.mkdir(config.baseDir, { recursive: true }));
  const at = (relative: string) => NodePath.join(root, ...relative.split("/"));
  const write = (relative: string, contents = "") =>
    Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.dirname(at(relative)), { recursive: true });
      await NodeFSP.writeFile(at(relative), contents);
    });
  const exists = (relative: string) =>
    Effect.promise(() =>
      NodeFSP.lstat(at(relative)).then(
        () => true,
        () => false,
      ),
    );
  const read = (relative: string) => Effect.promise(() => NodeFSP.readFile(at(relative), "utf8"));
  const run = (operation: FilesystemFileOperation, runRoot = root) =>
    service.run({ root: runRoot, operation });
  return { root, outside, at, write, exists, read, run, trashed, config };
});

describe("isValidFileName", () => {
  it.each([
    ["notes.md", "linux", true],
    ["a\\b", "linux", true],
    ["a:b", "linux", true],
    ["a:b", "darwin", false],
    ["a/b", "linux", false],
    ["..", "linux", false],
    ["nul\0", "linux", false],
    ["é".repeat(128), "linux", false],
    ["CON", "win32", false],
    ["com1.txt", "win32", false],
    ["LPT¹", "win32", false],
    ["console.txt", "win32", true],
    ["trailing.", "win32", false],
    ["trailing ", "win32", false],
    ["a\\b", "win32", false],
    ['a"b', "win32", false],
    ["tab\there", "win32", false],
  ] as const)("%j on %s is %s", (name, platform, valid) => {
    expect(isValidFileName(name, platform)).toBe(valid);
  });
});

describe("keepBothName", () => {
  it.each([
    ["notes.txt", 2, false, "notes 2.txt"],
    ["archive.tar.gz", 3, false, "archive.tar 3.gz"],
    [".env", 2, false, ".env 2"],
    ["Makefile", 2, false, "Makefile 2"],
    ["v1.2", 2, true, "v1.2 2"],
    ["notes.txt", 1, false, "notes.txt"],
  ] as const)("%s attempt %i", (name, attempt, isDirectory, expected) => {
    expect(keepBothName(name, attempt, isDirectory)).toBe(expected);
  });
});

describe("isCaseOnlyRename", () => {
  it.each([
    ["notes.md", "Notes.md", true],
    ["café.md", "CAFÉ.md", true],
    ["notes.md", "notes.md", false],
    ["notes.md", "other.md", false],
  ])("%s to %s is %s", (from, to, expected) => {
    expect(isCaseOnlyRename(from, to)).toBe(expected);
  });
});

describe("FileOperations", () => {
  it.effect("creates files and folders and refuses a taken name", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("src/existing.ts");

      expect(yield* fixture.run({ _tag: "createFile", path: "src/new.ts" })).toEqual({
        items: [{ path: "src/new.ts", destination: "src/new.ts" }],
        changedDirectories: ["src"],
      });
      expect(yield* fixture.run({ _tag: "createDirectory", path: "docs" })).toEqual({
        items: [{ path: "docs", destination: "docs" }],
        changedDirectories: [""],
      });
      const failures = yield* Effect.forEach(
        [
          { _tag: "createFile", path: "src/existing.ts" },
          { _tag: "createDirectory", path: "src" },
          { _tag: "createFile", path: "missing/new.ts" },
          { _tag: "createFile", path: "src/bad\0name" },
          { _tag: "createDirectory", path: ".git" },
        ] as const,
        (operation) => fixture.run(operation),
      );
      expect(failures.map((result) => result.items[0]?.failure)).toEqual([
        "name_taken",
        "name_taken",
        "not_found",
        "invalid_name",
        "protected",
      ]);
      expect(yield* fixture.read("src/existing.ts")).toBe("");
    }),
  );

  it.effect("renames, refusing a taken name but allowing a change of case", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("notes.md", "notes");
      yield* fixture.write("other.md", "other");

      const taken = yield* fixture.run({ _tag: "rename", path: "notes.md", name: "other.md" });
      expect(taken.items).toEqual([{ path: "notes.md", failure: "name_taken" }]);
      expect(yield* fixture.read("other.md")).toBe("other");

      const invalid = yield* fixture.run({ _tag: "rename", path: "notes.md", name: "a/b" });
      expect(invalid.items).toEqual([{ path: "notes.md", failure: "invalid_name" }]);

      const renamed = yield* fixture.run({ _tag: "rename", path: "notes.md", name: "Notes.md" });
      expect(renamed.items).toEqual([{ path: "notes.md", destination: "Notes.md" }]);
      expect(yield* Effect.promise(() => NodeFSP.readdir(fixture.root))).toContain("Notes.md");
      expect(yield* fixture.read("Notes.md")).toBe("notes");
    }),
  );

  it.effect("does not treat a hard link as the same name", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("a.txt", "a");
      yield* Effect.promise(() => NodeFSP.link(fixture.at("a.txt"), fixture.at("b.txt")));
      const linked = yield* fixture.run({ _tag: "rename", path: "a.txt", name: "b.txt" });
      expect(linked.items).toEqual([{ path: "a.txt", failure: "name_taken" }]);

      // Only a case-sensitive volume can hold both names; rename(2) between them does nothing.
      const caseLink = yield* Effect.promise(() =>
        NodeFSP.link(fixture.at("a.txt"), fixture.at("A.txt")).then(
          () => true,
          () => false,
        ),
      );
      if (caseLink) {
        const result = yield* fixture.run({ _tag: "rename", path: "a.txt", name: "A.txt" });
        expect(result.items).toEqual([{ path: "a.txt", failure: "name_taken" }]);
      }
      expect(yield* fixture.exists("a.txt")).toBe(true);
    }),
  );

  it.effect.skipIf(!symlinksSupported)("renames a link itself, not what it points at", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("target.txt", "target");
      yield* Effect.promise(() => NodeFSP.symlink("target.txt", fixture.at("link.txt")));
      const result = yield* fixture.run({ _tag: "rename", path: "link.txt", name: "moved.txt" });
      expect(result.items).toEqual([{ path: "link.txt", destination: "moved.txt" }]);
      expect(yield* fixture.read("target.txt")).toBe("target");
      expect(yield* Effect.promise(() => NodeFSP.readlink(fixture.at("moved.txt")))).toBe(
        "target.txt",
      );
    }),
  );

  it.effect("moves a batch, reporting nested picks under their moved folder", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("src/a/inner.ts");
      yield* fixture.write("src/b.ts");
      yield* fixture.write("dest/b.ts", "kept");
      yield* fixture.write("dest/keep.ts");

      const result = yield* fixture.run({
        _tag: "move",
        paths: ["src/a", "src/a/inner.ts", "src/b.ts", "src/a", "missing.ts", "dest/keep.ts"],
        destinationDirectory: "dest",
      });
      expect(result.items).toEqual([
        { path: "src/a", destination: "dest/a" },
        { path: "src/a/inner.ts", destination: "dest/a/inner.ts" },
        { path: "src/b.ts", failure: "name_taken" },
        { path: "src/a", destination: "dest/a" },
        { path: "missing.ts", failure: "not_found" },
        { path: "dest/keep.ts", destination: "dest/keep.ts" },
      ]);
      expect(result.changedDirectories.toSorted()).toEqual(["dest", "src"]);
      expect(yield* fixture.exists("dest/a/inner.ts")).toBe(true);
      expect(yield* fixture.read("dest/b.ts")).toBe("kept");

      yield* fixture.write("src/c/b/a/deep.ts");
      const nested = yield* fixture.run({
        _tag: "move",
        paths: ["src/c/b", "src/c/b/a", "src/c"],
        destinationDirectory: "dest",
      });
      expect(nested.items).toEqual([
        { path: "src/c/b", destination: "dest/c/b" },
        { path: "src/c/b/a", destination: "dest/c/b/a" },
        { path: "src/c", destination: "dest/c" },
      ]);
      expect(yield* fixture.exists("dest/c/b/a/deep.ts")).toBe(true);
    }),
  );

  it.effect("refuses to move or copy a folder into itself", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("folder/child/file.ts");
      for (const tag of ["move", "copy"] as const) {
        for (const destinationDirectory of ["folder", "folder/child"]) {
          const result = yield* fixture.run({ _tag: tag, paths: ["folder"], destinationDirectory });
          expect(result.items).toEqual([{ path: "folder", failure: "into_itself" }]);
        }
      }
      expect(yield* fixture.exists("folder/child/file.ts")).toBe(true);
    }),
  );

  it.effect("reports a move across devices instead of copying", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("a.ts", "a");
      yield* fixture.write("folder/b.ts", "b");
      yield* fixture.write("mount/.keep");
      const crossDevice = Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      vi.mocked(NodeFSP.link).mockRejectedValueOnce(crossDevice);
      vi.mocked(NodeFSP.rename).mockRejectedValueOnce(crossDevice);
      const result = yield* fixture.run({
        _tag: "move",
        paths: ["a.ts", "folder"],
        destinationDirectory: "mount",
      });
      expect(result.items).toEqual([
        { path: "a.ts", failure: "cross_device" },
        { path: "folder", failure: "cross_device" },
      ]);
      expect(yield* fixture.read("a.ts")).toBe("a");
      expect(yield* fixture.exists("mount/a.ts")).toBe(false);
      expect(yield* fixture.exists("mount/folder")).toBe(false);
    }),
  );

  it.effect("never replaces a file that takes the name after the check", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("a.ts", "a");
      yield* fixture.write("b.ts", "b");
      yield* fixture.write("dest/.keep");
      const actualLink = vi.mocked(NodeFSP.link).getMockImplementation()!;
      const racing = (to: string) =>
        vi.mocked(NodeFSP.link).mockImplementationOnce(async (from, linked) => {
          await NodeFSP.writeFile(fixture.at(to), "raced");
          return actualLink(from, linked);
        });

      racing("renamed.ts");
      const renamed = yield* fixture.run({ _tag: "rename", path: "a.ts", name: "renamed.ts" });
      racing("dest/b.ts");
      const moved = yield* fixture.run({
        _tag: "move",
        paths: ["b.ts"],
        destinationDirectory: "dest",
      });
      expect([renamed.items, moved.items]).toEqual([
        [{ path: "a.ts", failure: "name_taken" }],
        [{ path: "b.ts", failure: "name_taken" }],
      ]);
      expect(yield* fixture.read("renamed.ts")).toBe("raced");
      expect(yield* fixture.read("dest/b.ts")).toBe("raced");
      expect(yield* fixture.read("a.ts")).toBe("a");
      expect(yield* fixture.read("b.ts")).toBe("b");
    }),
  );

  it.effect("copies keeping both names", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("notes.txt", "notes");
      yield* fixture.write("folder/inner.txt", "inner");

      const first = yield* fixture.run({
        _tag: "copy",
        paths: ["notes.txt", "folder"],
        destinationDirectory: "",
      });
      expect(first.items).toEqual([
        { path: "notes.txt", destination: "notes 2.txt" },
        { path: "folder", destination: "folder 2" },
      ]);
      const second = yield* fixture.run({
        _tag: "copy",
        paths: ["notes.txt"],
        destinationDirectory: ".",
      });
      expect(second.items).toEqual([{ path: "notes.txt", destination: "notes 3.txt" }]);
      const elsewhere = yield* fixture.run({
        _tag: "copy",
        paths: ["notes.txt"],
        destinationDirectory: "folder",
      });
      expect(elsewhere.items).toEqual([{ path: "notes.txt", destination: "folder/notes.txt" }]);
      expect(yield* fixture.read("notes 3.txt")).toBe("notes");
      expect(yield* fixture.read("folder 2/inner.txt")).toBe("inner");
    }),
  );

  it.effect("refuses a copy above the size cap before writing anything", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("big/huge.bin");
      yield* fixture.write("small.txt", "small");
      yield* Effect.promise(() => NodeFSP.truncate(fixture.at("big/huge.bin"), COPY_MAX_BYTES + 1));
      const result = yield* fixture.run({
        _tag: "copy",
        paths: ["big", "small.txt"],
        destinationDirectory: "",
      });
      expect(result.items).toEqual([
        { path: "big", failure: "too_large" },
        { path: "small.txt", destination: "small 2.txt" },
      ]);
      expect(yield* fixture.exists("big 2")).toBe(false);
    }),
  );

  it.effect("trashes through the host trash and deletes only when asked", () =>
    Effect.gen(function* () {
      let available = false;
      const fixture = yield* setup({
        trash: (paths) => paths.map(() => (available ? "trashed" : "unavailable")),
      });
      yield* fixture.write("folder/inner.txt");
      yield* fixture.write("loose.txt");

      const refused = yield* fixture.run({
        _tag: "trash",
        paths: ["folder/inner.txt", "folder", "loose.txt"],
        onUnavailable: "fail",
      });
      expect(refused.items).toEqual([
        { path: "folder/inner.txt", failure: "trash_unavailable" },
        { path: "folder", failure: "trash_unavailable" },
        { path: "loose.txt", failure: "trash_unavailable" },
      ]);
      expect(fixture.trashed).toEqual([[fixture.at("folder"), fixture.at("loose.txt")]]);
      expect(yield* fixture.exists("folder")).toBe(true);

      const deleted = yield* fixture.run({
        _tag: "trash",
        paths: ["folder"],
        onUnavailable: "delete",
      });
      expect(deleted).toEqual({ items: [{ path: "folder" }], changedDirectories: [""] });
      expect(yield* fixture.exists("folder")).toBe(false);

      available = true;
      const trashed = yield* fixture.run({
        _tag: "trash",
        paths: ["loose.txt"],
        onUnavailable: "delete",
      });
      expect(trashed.items).toEqual([{ path: "loose.txt" }]);
      expect(yield* fixture.exists("loose.txt")).toBe(true);
    }),
  );

  it.effect("never changes repositories, workspace roots, home, or T3 home", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({
        workspaceRoots: [NodePath.join(NodeOS.tmpdir(), "unrelated")],
      });
      const known = yield* setup();
      const withKnown = yield* setup({ workspaceRoots: [known.root] });
      yield* fixture.write("repo/.git/HEAD", "ref: refs/heads/main\n");
      yield* fixture.write("repo/src/index.ts");
      yield* fixture.write("parent/child/.git", "gitdir: elsewhere\n");
      yield* fixture.write("bare/HEAD", "ref: refs/heads/main\n");
      yield* fixture.write("bare/objects/.keep");
      yield* fixture.write("bare/refs/.keep");
      yield* fixture.write("plain/file.txt");

      const sources = [
        "repo",
        "repo/.git",
        "repo/.git/HEAD",
        "parent",
        "bare",
        "bare/HEAD",
        ".",
        NodeOS.homedir(),
        fixture.config.baseDir,
        NodePath.parse(fixture.root).root,
        ...(isWindows ? [] : ["/usr/bin"]),
      ];
      const result = yield* fixture.run({ _tag: "trash", paths: sources, onUnavailable: "delete" });
      expect(result.items.map((item) => [item.path, item.failure])).toEqual(
        sources.map((source) => [source, "protected"]),
      );
      expect(fixture.trashed).toEqual([[]]);

      const workspace = yield* withKnown.run({
        _tag: "move",
        paths: [NodePath.dirname(known.root)],
        destinationDirectory: withKnown.root,
      });
      expect(workspace.items[0]?.failure).toBe("protected");

      const knownParent = NodePath.dirname(known.root);
      const caseVariant = NodePath.join(
        NodePath.dirname(knownParent),
        NodePath.basename(knownParent).toUpperCase(),
      );
      const caseInsensitive = yield* Effect.promise(() =>
        NodeFSP.stat(caseVariant).then(
          () => true,
          () => false,
        ),
      );
      if (caseInsensitive) {
        const variant = yield* withKnown.run({
          _tag: "move",
          paths: [caseVariant],
          destinationDirectory: withKnown.root,
        });
        expect(variant.items[0]?.failure).toBe("protected");
      }

      const copied = yield* fixture.run({
        _tag: "copy",
        paths: ["repo", "bare", "repo/.git", "repo/.git/HEAD", ".", fixture.config.baseDir],
        destinationDirectory: "plain",
      });
      expect(copied.items).toEqual([
        { path: "repo", destination: "plain/repo" },
        { path: "bare", destination: "plain/bare" },
        { path: "repo/.git", failure: "protected" },
        { path: "repo/.git/HEAD", failure: "protected" },
        { path: ".", failure: "protected" },
        { path: fixture.config.baseDir, failure: "protected" },
      ]);

      const inRepo = yield* fixture.run({
        _tag: "rename",
        path: "repo/src/index.ts",
        name: "main.ts",
      });
      expect(inRepo.items).toEqual([
        { path: "repo/src/index.ts", destination: "repo/src/main.ts" },
      ]);
    }),
  );

  it.effect("never writes into git metadata, system folders, or T3 home", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      yield* fixture.write("repo/.git/hooks/.keep");
      yield* fixture.write("file.txt");
      const destinations = [
        "repo/.git",
        "repo/.git/hooks",
        fixture.config.baseDir,
        ...(isWindows ? [] : ["/usr/bin"]),
      ];
      for (const destinationDirectory of destinations) {
        for (const tag of ["move", "copy"] as const) {
          const result = yield* fixture.run({
            _tag: tag,
            paths: ["file.txt"],
            destinationDirectory,
          });
          expect([destinationDirectory, result.items[0]?.failure]).toEqual([
            destinationDirectory,
            "protected",
          ]);
        }
      }
      const renamed = yield* fixture.run({ _tag: "rename", path: "file.txt", name: ".git" });
      expect(renamed.items[0]?.failure).toBe("protected");
      expect(yield* fixture.exists("file.txt")).toBe(true);
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps project paths inside the project but lets host folders follow links",
    () =>
      Effect.gen(function* () {
        const project = yield* setup({ scoped: true });
        yield* project.write("file.txt");
        yield* Effect.promise(() => NodeFSP.symlink(project.outside, project.at("escape"), "dir"));
        const escaped = yield* project.run({
          _tag: "move",
          paths: ["file.txt"],
          destinationDirectory: "escape",
        });
        expect(escaped.items).toEqual([{ path: "file.txt", failure: "outside_root" }]);
        for (const path of ["../outside/new.txt", "escape/new.txt"]) {
          const created = yield* project.run({ _tag: "createDirectory", path });
          expect(created.items).toEqual([{ path, failure: "outside_root" }]);
        }
        expect(yield* Effect.promise(() => NodeFSP.readdir(project.outside))).toEqual([]);
        // Absolute paths are host paths, which the whole computer scope allows.
        const absolute = yield* project.run({
          _tag: "copy",
          paths: ["file.txt"],
          destinationDirectory: project.outside,
        });
        expect(absolute.items).toEqual([
          { path: "file.txt", destination: NodePath.join(project.outside, "file.txt") },
        ]);

        const host = yield* setup();
        yield* host.write("file.txt");
        yield* Effect.promise(() => NodeFSP.symlink(host.outside, host.at("linked"), "dir"));
        const followed = yield* host.run({
          _tag: "move",
          paths: ["file.txt"],
          destinationDirectory: "linked",
        });
        expect(followed.items).toEqual([
          { path: "file.txt", destination: NodePath.join(host.outside, "file.txt") },
        ]);
        expect(followed.changedDirectories.toSorted()).toEqual(["", host.outside].toSorted());
      }),
  );

  it.effect("rejects a missing root", () =>
    Effect.gen(function* () {
      const fixture = yield* setup();
      const error = yield* fixture
        .run({ _tag: "createFile", path: "a.txt" }, NodePath.join(fixture.root, "missing"))
        .pipe(Effect.flip);
      expect(error.reason).toBe("root_unavailable");
    }),
  );

  it.effect("refreshes a project's search index once more however many changes queue up", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<string>();
      const gate = yield* Deferred.make<void>();
      const fixture = yield* setup({
        scoped: true,
        refresh: (cwd) => Queue.offer(started, cwd).pipe(Effect.andThen(Deferred.await(gate))),
      });
      yield* fixture.run({ _tag: "createFile", path: "a.txt" });
      expect(yield* Queue.take(started)).toBe(fixture.root);
      yield* fixture.run({ _tag: "createFile", path: "b.txt" });
      yield* fixture.run({ _tag: "createFile", path: "c.txt" });
      yield* fixture.run({ _tag: "createFile", path: "a.txt" });
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Queue.take(started)).toBe(fixture.root);
      expect(yield* Queue.size(started)).toBe(0);
    }),
  );
});
