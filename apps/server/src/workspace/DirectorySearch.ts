// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type {
  FilesystemDirectorySearchEntry,
  FilesystemSearchDirectoriesInput,
  FilesystemSearchDirectoriesResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as HostFileSearch from "./HostFileSearch.ts";

export interface IndexedDirectory extends FilesystemDirectorySearchEntry {
  readonly depth: number;
}

export interface DirectoryScanResult {
  readonly directories: ReadonlyArray<IndexedDirectory>;
  readonly complete: boolean;
}

const SCAN_CONCURRENCY = 32;

const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__", "Pods", "DerivedData"]);
const SKIPPED_DIRECTORY_SUFFIXES = [".app", ".photoslibrary"];
// App data folders below home hold thousands of folders nobody opens as a project.
const SKIPPED_HOME_CHILDREN: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
  darwin: new Set(["Library"]),
  win32: new Set(["AppData"]),
};

function isSkippedDirectory(name: string, parentIsHome: boolean, platform: NodeJS.Platform) {
  return (
    name.startsWith(".") ||
    name.startsWith("$") ||
    SKIPPED_DIRECTORY_NAMES.has(name) ||
    SKIPPED_DIRECTORY_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    (parentIsHome && SKIPPED_HOME_CHILDREN[platform]?.has(name) === true)
  );
}

/** True when a folder on the path is one the scan would skip, such as `node_modules` or `.app`. */
function isSkippedPath(fullPath: string, homeDirectory: string, platform: NodeJS.Platform) {
  const home = NodePath.resolve(homeDirectory);
  const insideHome = isSameOrInside(home, fullPath);
  const segments = (insideHome ? NodePath.relative(home, fullPath) : fullPath)
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0);
  return segments.some((segment, index) =>
    isSkippedDirectory(segment, insideHome && index === 0, platform),
  );
}

interface DirectoryListing {
  readonly children: ReadonlyArray<string>;
  readonly isGitRepository: boolean;
}

const EMPTY_LISTING: DirectoryListing = { children: [], isGitRepository: false };

async function readDirectory(directory: string): Promise<DirectoryListing> {
  try {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    return {
      // Symlinked folders are skipped: they loop and duplicate real paths.
      children: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      // A linked worktree has a `.git` file rather than a folder.
      isGitRepository: entries.some((entry) => entry.name === ".git"),
    };
  } catch {
    return EMPTY_LISTING;
  }
}

/** Home plus mounted volumes: `/Volumes/*` on macOS, `/media`/`/mnt` on Linux, other drives on Windows. */
async function listDirectorySearchRoots(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<ReadonlyArray<string>> {
  const { platform, homeDirectory } = input;
  const mountRoots: Array<string> = [];
  if (platform === "darwin") {
    mountRoots.push(...(await listChildPaths("/Volumes")));
  } else if (platform === "linux") {
    const mountParents = ["/media", "/run/media"];
    // WSL mounts Windows drives under /mnt over a slow bridge.
    if (input.environment.WSL_DISTRO_NAME === undefined) mountParents.push("/mnt");
    for (const parent of mountParents) mountRoots.push(...(await listChildPaths(parent)));
  } else if (platform === "win32") {
    const homeDrive = NodePath.win32.parse(homeDirectory).root.toUpperCase();
    const drives = await Promise.all(
      Array.from("CDEFGHIJKLMNOPQRSTUVWXYZ", async (letter) => {
        const drive = `${letter}:\\`;
        if (drive === homeDrive) return null;
        return (await NodeFSP.stat(drive).then(
          (stat) => stat.isDirectory(),
          () => false,
        ))
          ? drive
          : null;
      }),
    );
    for (const drive of drives) if (drive !== null) mountRoots.push(drive);
  }
  const home = NodePath.resolve(homeDirectory);
  return [home, ...mountRoots.filter((root) => !isSameOrInside(home, root))];
}

async function listChildPaths(directory: string): Promise<ReadonlyArray<string>> {
  return (await readDirectory(directory)).children
    .filter((name) => !name.startsWith("."))
    .map((name) => NodePath.join(directory, name));
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/**
 * Breadth-first walk that records every folder and stops at Git repositories: their insides are
 * rarely added as projects and dominate the cost. A scan cut short by `maxDirectories` or
 * `timeout` keeps what it found; a hung network mount must not hold the whole search.
 */
export const scanDirectories = Effect.fn("DirectorySearch.scanDirectories")(function* (input: {
  readonly roots: ReadonlyArray<string>;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly maxDepth: number;
  readonly maxDirectories: number;
  readonly timeout: Duration.Input;
}) {
  const directories: Array<IndexedDirectory> = [];
  const home = NodePath.resolve(input.homeDirectory);
  let cutShort = false;

  const walk = Effect.gen(function* () {
    let level = input.roots.map((root) => NodePath.resolve(root));
    let remaining = input.maxDirectories;
    for (let depth = 0; level.length > 0; depth += 1) {
      if (level.length > remaining) {
        cutShort = true;
        level = level.slice(0, remaining);
      }
      remaining -= level.length;
      const listings = yield* Effect.forEach(
        level,
        (directory) => Effect.promise(() => readDirectory(directory)),
        { concurrency: SCAN_CONCURRENCY },
      );
      const nextLevel: Array<string> = [];
      level.forEach((directory, index) => {
        const { children, isGitRepository } = listings[index] ?? EMPTY_LISTING;
        if (directory !== home) {
          directories.push({
            name: NodePath.basename(directory) || directory,
            fullPath: directory,
            isGitRepository,
            depth,
          });
        }
        if (isGitRepository) return;
        const parentIsHome = directory === home;
        for (const child of children) {
          if (isSkippedDirectory(child, parentIsHome, input.platform)) continue;
          if (depth === input.maxDepth) {
            cutShort = true;
            return;
          }
          nextLevel.push(NodePath.join(directory, child));
        }
      });
      level = nextLevel;
    }
  });

  const finished = yield* walk.pipe(Effect.timeoutOption(input.timeout));
  return {
    directories,
    complete: Option.isSome(finished) && !cutShort,
  } satisfies DirectoryScanResult;
});

const WORD_BOUNDARY = /[\s._-]/;

function matchRank(entry: IndexedDirectory, query: string): number | null {
  // macOS names come back decomposed (NFD) while typed queries are composed (NFC).
  const name = entry.name.normalize("NFC").toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  const index = name.indexOf(query);
  if (index > 0) return WORD_BOUNDARY.test(name[index - 1] ?? "") ? 2 : 3;
  if (/[\\/]/.test(query) && entry.fullPath.toLowerCase().replaceAll("\\", "/").includes(query)) {
    return 4;
  }
  return null;
}

/** Name matches first (exact, prefix, word, substring), then repositories, then shallow paths. */
export function searchIndexedDirectories(
  directories: ReadonlyArray<IndexedDirectory>,
  query: string,
  limit: number,
): FilesystemSearchDirectoriesResult {
  const normalizedQuery = query.trim().normalize("NFC").toLowerCase().replaceAll("\\", "/");
  if (normalizedQuery.length === 0) return { entries: [], truncated: false };
  const matches: Array<{ readonly entry: IndexedDirectory; readonly rank: number }> = [];
  for (const entry of directories) {
    const rank = matchRank(entry, normalizedQuery);
    if (rank !== null) matches.push({ entry, rank });
  }
  matches.sort(
    (left, right) =>
      left.rank - right.rank ||
      Number(right.entry.isGitRepository) - Number(left.entry.isGitRepository) ||
      left.entry.depth - right.entry.depth ||
      left.entry.fullPath.length - right.entry.fullPath.length ||
      left.entry.fullPath.localeCompare(right.entry.fullPath),
  );
  return {
    entries: matches.slice(0, limit).map(({ entry }) => ({
      name: entry.name,
      fullPath: entry.fullPath,
      isGitRepository: entry.isGitRepository,
    })),
    truncated: matches.length > limit,
  };
}

export class DirectorySearch extends Context.Service<
  DirectorySearch,
  {
    readonly search: (
      input: FilesystemSearchDirectoriesInput,
    ) => Effect.Effect<FilesystemSearchDirectoriesResult>;
  }
>()("t3/workspace/DirectorySearch") {}

/** Folders asked of the OS index before ranking; repositories are pulled to the top from these. */
const INDEX_CANDIDATE_LIMIT = 200;
const GIT_PROBE_CONCURRENCY = 16;
const HOST_INDEX_MIN_QUERY_LENGTH = 2;
/** Bounds the fallback scan used when the host has no file index. */
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_DIRECTORIES = 60_000;
const SCAN_BUDGET = "4 seconds";
const SCAN_INDEX_TTL = "5 minutes";

export const make = Effect.fn("DirectorySearch.make")(function* () {
  const hostFileSearch = yield* HostFileSearch.HostFileSearch;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;

  const scannedIndex = yield* Effect.cachedWithTTL(
    Effect.promise(() => listDirectorySearchRoots({ platform, homeDirectory, environment })).pipe(
      Effect.flatMap((roots) =>
        scanDirectories({
          roots,
          homeDirectory,
          platform,
          maxDepth: SCAN_MAX_DEPTH,
          maxDirectories: SCAN_MAX_DIRECTORIES,
          timeout: SCAN_BUDGET,
        }),
      ),
    ),
    SCAN_INDEX_TTL,
  );

  const searchScanned = (input: FilesystemSearchDirectoriesInput) =>
    scannedIndex.pipe(
      Effect.map((index) => searchIndexedDirectories(index.directories, input.query, input.limit)),
    );

  const toIndexed = (fullPath: string) =>
    fileSystem.exists(NodePath.join(fullPath, ".git")).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map((isGitRepository): IndexedDirectory => ({
        name: NodePath.basename(fullPath) || fullPath,
        fullPath,
        isGitRepository,
        depth: fullPath.split(/[\\/]/u).length,
      })),
    );

  const search = Effect.fn("DirectorySearch.search")(function* (
    input: FilesystemSearchDirectoriesInput,
  ) {
    // The OS index matches names only, so a path fragment needs the scanned index; one letter
    // would stream most of the index.
    if (
      hostFileSearch.backend === undefined ||
      input.query.length < HOST_INDEX_MIN_QUERY_LENGTH ||
      /[\\/]/u.test(input.query)
    ) {
      return yield* searchScanned(input);
    }
    const found = yield* hostFileSearch
      .search({ query: input.query, kind: "directory", limit: INDEX_CANDIDATE_LIMIT })
      .pipe(Effect.option);
    if (Option.isNone(found)) return yield* searchScanned(input);
    const candidates = yield* Effect.forEach(
      found.value.entries.filter((entry) => !isSkippedPath(entry.path, homeDirectory, platform)),
      (entry) => toIndexed(entry.path),
      { concurrency: GIT_PROBE_CONCURRENCY },
    );
    const ranked = searchIndexedDirectories(candidates, input.query, input.limit);
    return { entries: ranked.entries, truncated: ranked.truncated || found.value.truncated };
  });

  return DirectorySearch.of({ search });
});

export const layer = Layer.effect(DirectorySearch, make());
