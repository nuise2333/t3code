// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DirectorySearch from "./DirectorySearch.ts";

async function createTree(paths: ReadonlyArray<string>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-directory-search-"));
  for (const path of paths) {
    const absolute = NodePath.join(root, path);
    if (path.endsWith("/.git-file")) {
      await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(NodePath.dirname(absolute), ".git"), "gitdir: x");
    } else {
      await NodeFSP.mkdir(absolute, { recursive: true });
    }
  }
  return root;
}

const makeTree = (paths: ReadonlyArray<string>) =>
  Effect.acquireRelease(
    Effect.promise(() => createTree(paths)),
    (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  ).pipe(Effect.flatMap((root) => Effect.promise(() => NodeFSP.realpath(root))));

const scan = (home: string, roots: ReadonlyArray<string>, maxDepth = 6) =>
  DirectorySearch.scanDirectories({
    roots,
    homeDirectory: home,
    platform: "darwin",
    maxDepth,
    maxDirectories: 10_000,
    timeout: "1 minute",
  });

describe("scanDirectories", () => {
  it.effect("indexes nested folders, stops at repositories, and skips noise", () =>
    Effect.gen(function* () {
      const root = yield* makeTree([
        "home/Projects/t3-code/.git",
        "home/Projects/t3-code/packages/inner",
        "home/Projects/worktree/.git-file",
        "home/Projects/web/node_modules/pkg",
        "home/.cache/hidden",
        "home/Library/Caches",
        "volume/Backups/t3-code-old",
      ]);
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(root, "home/Projects"), NodePath.join(root, "home/link")),
      );
      const home = NodePath.join(root, "home");

      const result = yield* scan(home, [home, NodePath.join(root, "volume")]);

      expect(result.complete).toBe(true);
      const byPath = new Map(
        result.directories.map((entry) => [NodePath.relative(root, entry.fullPath), entry]),
      );
      expect([...byPath.keys()].toSorted()).toEqual([
        "home/Projects",
        "home/Projects/t3-code",
        "home/Projects/web",
        "home/Projects/worktree",
        "volume",
        "volume/Backups",
        "volume/Backups/t3-code-old",
      ]);
      expect(byPath.get("home/Projects/t3-code")?.isGitRepository).toBe(true);
      expect(byPath.get("home/Projects/worktree")?.isGitRepository).toBe(true);
      expect(byPath.get("home/Projects/web")?.isGitRepository).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("reports an incomplete scan when the depth limit cuts it short", () =>
    Effect.gen(function* () {
      const root = yield* makeTree(["a/b/c"]);
      const result = yield* scan(root, [root], 1);
      expect(result.complete).toBe(false);
      expect(result.directories.map((entry) => entry.name)).toEqual(["a"]);
    }).pipe(Effect.scoped),
  );
});

describe("searchIndexedDirectories", () => {
  const entry = (fullPath: string, depth: number, isGitRepository = false) => ({
    name: NodePath.basename(fullPath),
    fullPath,
    depth,
    isGitRepository,
  });
  const index = [
    entry("/h/Archive/my-t3-code-notes", 2),
    entry("/h/old/t3-code", 2),
    entry("/h/Projects/t3-code", 2, true),
    entry("/h/t3-code-fork", 1),
    entry("/h/Projects/at3c", 2),
    entry("/Volumes/T7/t3-code", 2, true),
  ];

  it("ranks exact, prefix, word, then substring matches, preferring repositories", () => {
    const result = DirectorySearch.searchIndexedDirectories(index, "T3-Code", 10);
    expect(result.entries.map((match) => match.fullPath)).toEqual([
      "/h/Projects/t3-code",
      "/Volumes/T7/t3-code",
      "/h/old/t3-code",
      "/h/t3-code-fork",
      "/h/Archive/my-t3-code-notes",
    ]);
    expect(result.truncated).toBe(false);
  });

  it("matches path fragments and reports truncation", () => {
    expect(
      DirectorySearch.searchIndexedDirectories(index, "projects/t3", 10).entries.map(
        (match) => match.fullPath,
      ),
    ).toEqual(["/h/Projects/t3-code"]);
    expect(DirectorySearch.searchIndexedDirectories(index, "t3", 2)).toMatchObject({
      truncated: true,
    });
  });
});
