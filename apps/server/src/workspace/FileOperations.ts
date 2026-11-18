// @effect-diagnostics nodeBuiltinImport:off - mutations map errno codes and need exclusive creates.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  FilesystemFileOperationError,
  type FilesystemFileOperationFailure,
  type FilesystemFileOperationInput,
  type FilesystemFileOperationItem,
  type FilesystemFileOperationResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { isGitMetadataName, isInGitFolder } from "./gitFolders.ts";
import * as HostTrash from "./HostTrash.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";

const COPY_MAX_ENTRIES = 10_000;
export const COPY_MAX_BYTES = 1024 ** 3;
const KEEP_BOTH_MAX_ATTEMPTS = 9_999;
const CHILD_REPOSITORY_CHECK_CONCURRENCY = 16;

type Failure = FilesystemFileOperationFailure;
type Outcome<T> = T | { readonly failure: Failure };
const failure = (value: Failure) => ({ failure: value }) as const;
const isFailure = <T extends object>(value: Outcome<T>): value is { readonly failure: Failure } =>
  "failure" in value;

interface ProtectedLocation {
  readonly path: string;
  /** False guards only the folder itself, as a source. */
  readonly subtree: boolean;
  readonly except?: ReadonlyArray<string>;
}

/** Folders a file operation never takes as a source, or never writes into when `subtree`. */
function systemLocations(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<ProtectedLocation> {
  const subtree = (path: string, except?: ReadonlyArray<string>) =>
    ({ path, subtree: true, ...(except ? { except } : {}) }) as const;
  const itself = (path: string) => ({ path, subtree: false }) as const;
  switch (platform) {
    case "darwin":
      return [
        ...["/System", "/usr", "/bin", "/sbin", "/Library", "/etc"].map((path) => subtree(path)),
        // Temp folders live under /private and stay usable.
        subtree("/var", ["/var/folders"]),
        subtree("/private", ["/private/tmp", "/private/var/folders"]),
        ...["/Applications", "/Users", "/Volumes", "/tmp", "/opt", "/cores"].map(itself),
      ];
    case "win32": {
      const systemDrive = (environment.SystemDrive ?? "C:").replace(/[\\/]+$/u, "");
      const systemRoot = environment.SystemRoot ?? environment.windir ?? `${systemDrive}\\Windows`;
      return [
        subtree(systemRoot),
        ...[
          environment.ProgramFiles ?? `${systemDrive}\\Program Files`,
          environment["ProgramFiles(x86)"] ?? `${systemDrive}\\Program Files (x86)`,
          environment.ProgramW6432,
        ]
          .filter((path) => path !== undefined)
          .map((path) => subtree(path)),
        itself(`${systemDrive}\\Users`),
        itself(`${systemDrive}\\ProgramData`),
      ];
    }
    default:
      return [
        ...[
          "/usr",
          "/bin",
          "/sbin",
          "/etc",
          "/boot",
          "/proc",
          "/sys",
          "/dev",
          "/lib",
          "/lib32",
          "/lib64",
          "/libx32",
        ].map((path) => subtree(path)),
        ...["/home", "/tmp", "/var", "/opt", "/srv", "/root", "/mnt", "/media", "/run"].map(itself),
      ];
  }
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/u;

/** A single path segment this host's file system accepts. */
export function isValidFileName(name: string, platform: NodeJS.Platform): boolean {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    return false;
  }
  if (Buffer.byteLength(name, "utf8") > 255) return false;
  if (platform === "darwin") return !name.includes(":");
  if (platform === "win32") {
    return (
      !WINDOWS_FORBIDDEN_CHARACTERS.test(name) &&
      !/[. ]$/u.test(name) &&
      !WINDOWS_RESERVED_NAME.test(name)
    );
  }
  return true;
}

/** "name.ext" becomes "name 2.ext"; folders and dotfiles take the number at the end. */
export function keepBothName(name: string, attempt: number, isDirectory: boolean): string {
  if (attempt <= 1) return name;
  const dot = name.lastIndexOf(".");
  if (isDirectory || dot <= 0) return `${name} ${attempt}`;
  return `${name.slice(0, dot)} ${attempt}${name.slice(dot)}`;
}

/** Same file and the same name apart from case or Unicode form: a rename the volume folds. */
export const isCaseOnlyRename = (from: string, to: string) =>
  from !== to && from.normalize("NFC").toLowerCase() === to.normalize("NFC").toLowerCase();

const errnoFailure = (error: unknown): Failure => {
  switch ((error as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return "not_found";
    case "ENOTDIR":
      return "not_directory";
    case "EEXIST":
    case "ENOTEMPTY":
      return "name_taken";
    case "EACCES":
    case "EPERM":
    case "EROFS":
    case "EBUSY":
      return "permission_denied";
    case "EXDEV":
      return "cross_device";
    case "ENAMETOOLONG":
    case "EINVAL":
      return "invalid_name";
    default:
      return "failed";
  }
};

const attempt = async <T>(run: () => Promise<T>): Promise<Outcome<{ readonly value: T }>> => {
  try {
    return { value: await run() };
  } catch (error) {
    return failure(errnoFailure(error));
  }
};

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"]);

/**
 * A file takes its new name with a hard link, which fails on a taken name instead of
 * replacing it. A folder can only be renamed: rename still replaces an empty folder
 * created at the destination after the check.
 */
async function renameNoReplace(from: string, to: string, stats: NodeFS.Stats): Promise<void> {
  if (!stats.isFile()) return NodeFSP.rename(from, to);
  try {
    await NodeFSP.link(from, to);
  } catch (error) {
    if (!LINK_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return NodeFSP.rename(from, to);
  }
  try {
    await NodeFSP.unlink(from);
  } catch (error) {
    await NodeFSP.unlink(to).catch(() => undefined);
    throw error;
  }
}

interface Entry {
  /** The parent resolved, the leaf as named: a symlink is the entry itself. */
  readonly real: string;
  readonly named: string;
  readonly stats: NodeFS.Stats;
}

interface Directory {
  readonly real: string;
  readonly named: string;
}

export class FileOperations extends Context.Service<
  FileOperations,
  {
    readonly run: (
      input: FilesystemFileOperationInput,
    ) => Effect.Effect<FilesystemFileOperationResult, FilesystemFileOperationError>;
  }
>()("t3/workspace/FileOperations") {}

/** @public */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const hostTrash = yield* HostTrash.HostTrash;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const serviceScope = yield* Effect.scope;

  const comparable = (value: string) =>
    platform === "win32" || platform === "darwin" ? value.normalize("NFC").toLowerCase() : value;
  const within = (candidate: string, root: string) =>
    KnownWorkspaces.isWithinRoot(path, comparable(candidate), comparable(root));
  const strictlyWithin = (candidate: string, root: string) =>
    within(candidate, root) && comparable(candidate) !== comparable(root);
  const isFilesystemRoot = (value: string) => path.dirname(value) === value;

  const realOrResolved = (value: string) =>
    NodeFSP.realpath(value).catch(() => path.resolve(value));
  const realHome = yield* Effect.promise(() => realOrResolved(home));
  const t3Homes = yield* Effect.promise(() =>
    Promise.all(
      [config.baseDir, path.join(home, ".t3"), config.stateDir, config.secretsDir].map(
        realOrResolved,
      ),
    ),
  );
  const locations = systemLocations(platform, environment);

  const inSystemSubtree = (value: string) =>
    locations.some(
      (location) =>
        location.subtree &&
        within(value, location.path) &&
        !(location.except ?? []).some((allowed) => within(value, allowed)),
    );

  const writeProtected = async (candidates: ReadonlyArray<string>) => {
    for (const candidate of candidates) {
      if (inSystemSubtree(candidate) || t3Homes.some((t3Home) => within(candidate, t3Home))) {
        return true;
      }
      if (await isInGitFolder(path, candidate).catch(() => true)) return true;
    }
    return false;
  };

  const isRepository = async (directory: string) => {
    const [dotGit, head, objects, refs] = await Promise.all(
      [".git", "HEAD", "objects", "refs"].map((name) =>
        NodeFSP.lstat(path.join(directory, name)).catch(() => null),
      ),
    );
    return dotGit !== null || (head !== null && objects !== null && refs !== null);
  };

  const holdsRepository = async (directory: string) => {
    if (await isRepository(directory)) return true;
    const children = await NodeFSP.readdir(directory, { withFileTypes: true });
    const folders = children.filter((child) => child.isDirectory());
    for (let index = 0; index < folders.length; index += CHILD_REPOSITORY_CHECK_CONCURRENCY) {
      const batch = folders.slice(index, index + CHILD_REPOSITORY_CHECK_CONCURRENCY);
      const found = await Promise.all(
        batch.map((child) => isRepository(path.join(directory, child.name))),
      );
      if (found.includes(true)) return true;
    }
    return false;
  };

  /** Sources: nothing write-protected, no root the user or T3 depends on, no repository. */
  const sourceProtected = Effect.fn("FileOperations.sourceProtected")(function* (entry: Entry) {
    const candidates = [entry.real, entry.named];
    if (
      candidates.some(
        (candidate) =>
          isFilesystemRoot(candidate) ||
          comparable(candidate) === comparable(realHome) ||
          comparable(candidate) === comparable(home) ||
          locations.some(
            (location) => !location.subtree && comparable(candidate) === comparable(location.path),
          ) ||
          t3Homes.some((t3Home) => within(t3Home, candidate)),
      )
    ) {
      return true;
    }
    if (yield* Effect.promise(() => writeProtected(candidates))) return true;
    if (entry.stats.isDirectory()) {
      if (yield* Effect.promise(() => holdsRepository(entry.real).catch(() => true))) return true;
      if (yield* knownWorkspaces.holdsWorkspaceRoot(entry.real)) return true;
    }
    return false;
  });

  /** Copying reads only, but never Git metadata or T3's own state, which holds secrets. */
  const copySourceProtected = Effect.fn("FileOperations.copySourceProtected")(function* (
    entry: Entry,
  ) {
    const candidates = [entry.real, entry.named];
    if (
      candidates.some((candidate) =>
        t3Homes.some((t3Home) => within(t3Home, candidate) || within(candidate, t3Home)),
      )
    ) {
      return true;
    }
    for (const candidate of candidates) {
      if (yield* Effect.promise(() => isInGitFolder(path, candidate).catch(() => true))) {
        return true;
      }
    }
    return false;
  });

  const refreshes = new Map<string, { dirty: boolean }>();
  // Tree listings read the disk; only search needs the index, so the reply does not wait.
  const refreshSearchIndex = (cwd: string) =>
    Effect.suspend(() => {
      const pending = refreshes.get(cwd);
      if (pending) {
        pending.dirty = true;
        return Effect.void;
      }
      const state = { dirty: false };
      refreshes.set(cwd, state);
      const loop: Effect.Effect<void> = workspaceEntries.refresh(cwd).pipe(
        Effect.flatMap(() => {
          if (!state.dirty) return Effect.sync(() => refreshes.delete(cwd));
          state.dirty = false;
          return loop;
        }),
        Effect.onInterrupt(() => Effect.sync(() => refreshes.delete(cwd))),
      );
      return loop.pipe(Effect.forkIn(serviceScope), Effect.asVoid);
    });

  const semaphores = new Map<string, Semaphore.Semaphore>();
  const rootSemaphore = (realRoot: string) => {
    const key = comparable(realRoot);
    const semaphore = semaphores.get(key) ?? Semaphore.makeUnsafe(1);
    semaphores.set(key, semaphore);
    return semaphore;
  };

  const run: FileOperations["Service"]["run"] = Effect.fn("FileOperations.run")(function* (input) {
    const rootUnavailable = new FilesystemFileOperationError({
      root: input.root,
      reason: "root_unavailable",
    });
    if (!path.isAbsolute(input.root) || isNetworkPath(input.root)) return yield* rootUnavailable;
    const realRoot = yield* Effect.tryPromise({
      try: async () => {
        const real = await NodeFSP.realpath(path.resolve(input.root));
        if (!(await NodeFSP.stat(real)).isDirectory()) throw new Error("Not a directory.");
        return real;
      },
      catch: () => rootUnavailable,
    });
    // Inside a project or worktree, root-relative paths may not leave it through a link.
    const scoped = yield* knownWorkspaces.contains(realRoot);

    const named = (requested: string): Outcome<{ readonly path: string }> => {
      if (path.isAbsolute(requested)) {
        const resolved = path.resolve(requested);
        if (isNetworkPath(resolved) && !within(resolved, realRoot)) return failure("protected");
        return { path: resolved };
      }
      const resolved = path.resolve(realRoot, requested);
      if (scoped && !within(resolved, realRoot)) return failure("outside_root");
      return { path: resolved };
    };
    const display = (value: string) =>
      within(value, realRoot) ? path.relative(realRoot, value).split(path.sep).join("/") : value;
    const leavesRoot = (requested: string, real: string) =>
      scoped && !path.isAbsolute(requested) && !within(real, realRoot);

    const resolveEntry = Effect.fn("FileOperations.resolveEntry")(function* (
      requested: string,
      purpose: "copy" | "change" = "change",
    ) {
      const target = named(requested);
      if (isFailure(target)) return target;
      if (isFilesystemRoot(target.path)) return failure("protected");
      const resolved = yield* Effect.promise(() =>
        attempt(async () => {
          const linked = path.join(
            await NodeFSP.realpath(path.dirname(target.path)),
            path.basename(target.path),
          );
          const stats = await NodeFSP.lstat(linked);
          // The leaf as stored on disk, so case, Unicode form, and short names match the checks.
          const real = stats.isSymbolicLink() ? linked : await NodeFSP.realpath(linked);
          return { real, stats };
        }),
      );
      if (isFailure(resolved)) return resolved;
      const { real, stats } = resolved.value;
      if (leavesRoot(requested, real)) return failure("outside_root");
      if (comparable(real) === comparable(realRoot)) return failure("protected");
      const entry: Entry = { real, named: target.path, stats };
      const isProtected =
        purpose === "copy" ? yield* copySourceProtected(entry) : yield* sourceProtected(entry);
      if (isProtected) return failure("protected");
      return entry;
    });

    /** `requested` is the path as the client sent it, which decides the root check. */
    const resolveDirectory = Effect.fn("FileOperations.resolveDirectory")(function* (
      requested: string,
      resolvedPath?: string,
    ) {
      const target =
        resolvedPath === undefined
          ? named(requested === "" ? "." : requested)
          : { path: resolvedPath };
      if (isFailure(target)) return target;
      const resolved = yield* Effect.promise(() =>
        attempt(async () => {
          const real = await NodeFSP.realpath(target.path);
          return { real, isDirectory: (await NodeFSP.stat(real)).isDirectory() };
        }),
      );
      if (isFailure(resolved)) return resolved;
      if (!resolved.value.isDirectory) return failure("not_directory");
      if (leavesRoot(requested, resolved.value.real)) return failure("outside_root");
      return { real: resolved.value.real, named: target.path } satisfies Directory;
    });

    /** A new name in `directory`, checked as written and as resolved. */
    const destination = Effect.fn("FileOperations.destination")(function* (
      directory: Directory,
      name: string,
    ) {
      if (isGitMetadataName(name)) return failure("protected");
      if (!isValidFileName(name, platform)) return failure("invalid_name");
      const target = {
        real: path.join(directory.real, name),
        named: path.join(directory.named, name),
      };
      if (yield* Effect.promise(() => writeProtected([target.real, target.named]))) {
        return failure("protected");
      }
      return target;
    });

    const changed = new Set<string>();
    const touched = (...paths: ReadonlyArray<string>) => {
      for (const value of paths) changed.add(display(path.dirname(value)));
    };

    /** Drops duplicates and paths inside another requested folder; their outcome follows it. */
    const resolveSources = Effect.fn("FileOperations.resolveSources")(function* (
      requested: ReadonlyArray<string>,
      purpose: "copy" | "change",
    ) {
      const resolved = yield* Effect.forEach(
        requested,
        (requestedPath) => resolveEntry(requestedPath, purpose),
        { concurrency: 8 },
      );
      const parents = resolved.map((entry, index) => {
        if (isFailure(entry)) return index;
        const ancestor = resolved.findIndex(
          (other, otherIndex) =>
            !isFailure(other) &&
            (strictlyWithin(entry.real, other.real) ||
              (otherIndex < index && comparable(other.real) === comparable(entry.real))),
        );
        return ancestor === -1 ? index : ancestor;
      });
      // Each step goes to a strict ancestor or an earlier duplicate, so the walk ends.
      const heads = parents.map((parent, index) => {
        let head = index;
        for (let next = parent; next !== head; next = parents[head]!) head = next;
        return head;
      });
      return { resolved, heads };
    });

    /** Results for every requested path: a dropped path reports where its folder went. */
    const batchItems = (
      requested: ReadonlyArray<string>,
      sources: {
        readonly resolved: ReadonlyArray<Outcome<Entry>>;
        readonly heads: ReadonlyArray<number>;
      },
      outcomes: ReadonlyMap<number, Outcome<{ readonly destination?: string }>>,
    ): ReadonlyArray<FilesystemFileOperationItem> =>
      requested.map((requestedPath, index) => {
        const entry = sources.resolved[index]!;
        if (isFailure(entry)) return { path: requestedPath, failure: entry.failure };
        const head = sources.heads[index]!;
        const outcome = outcomes.get(head) ?? failure("failed");
        if (isFailure(outcome)) return { path: requestedPath, failure: outcome.failure };
        if (outcome.destination === undefined) return { path: requestedPath };
        const headEntry = sources.resolved[head] as Entry;
        const inner = path.relative(headEntry.real, entry.real);
        return {
          path: requestedPath,
          destination: display(
            inner === "" ? outcome.destination : path.join(outcome.destination, inner),
          ),
        };
      });

    const createFile = Effect.fn("FileOperations.createFile")(function* (requested: string) {
      const target = named(requested);
      if (isFailure(target)) return target;
      const directory = yield* resolveDirectory(requested, path.dirname(target.path));
      if (isFailure(directory)) return directory;
      const created = yield* destination(directory, path.basename(target.path));
      if (isFailure(created)) return created;
      const written = yield* Effect.promise(() =>
        attempt(() => NodeFSP.writeFile(created.real, "", { flag: "wx" })),
      );
      if (isFailure(written)) return written;
      touched(created.real);
      return { destination: created.real };
    });

    const createDirectory = Effect.fn("FileOperations.createDirectory")(function* (
      requested: string,
    ) {
      const target = named(requested);
      if (isFailure(target)) return target;
      const directory = yield* resolveDirectory(requested, path.dirname(target.path));
      if (isFailure(directory)) return directory;
      const created = yield* destination(directory, path.basename(target.path));
      if (isFailure(created)) return created;
      const made = yield* Effect.promise(() => attempt(() => NodeFSP.mkdir(created.real)));
      if (isFailure(made)) return made;
      touched(created.real);
      return { destination: created.real };
    });

    const rename = Effect.fn("FileOperations.rename")(function* (requested: string, name: string) {
      const entry = yield* resolveEntry(requested);
      if (isFailure(entry)) return entry;
      const currentName = path.basename(entry.real);
      if (name === currentName) return { destination: entry.real };
      const directory = { real: path.dirname(entry.real), named: path.dirname(entry.named) };
      const target = yield* destination(directory, name);
      if (isFailure(target)) return target;
      const occupant = yield* Effect.promise(() => NodeFSP.lstat(target.real).catch(() => null));
      if (occupant !== null) {
        const sameEntry =
          occupant.dev === entry.stats.dev &&
          occupant.ino === entry.stats.ino &&
          isCaseOnlyRename(currentName, name) &&
          // A hard link under the other name is its own entry: renaming onto it is a no-op.
          !(yield* Effect.promise(() =>
            NodeFSP.readdir(directory.real).then(
              (names) => names.includes(name),
              () => true,
            ),
          ));
        if (!sameEntry) return failure("name_taken");
      }
      // The volume folds a case-only rename onto the same entry, so a link would collide.
      const renamed = yield* Effect.promise(() =>
        attempt(() =>
          occupant === null
            ? renameNoReplace(entry.real, target.real, entry.stats)
            : NodeFSP.rename(entry.real, target.real),
        ),
      );
      if (isFailure(renamed)) return renamed;
      touched(entry.real);
      return { destination: target.real };
    });

    const move = Effect.fn("FileOperations.move")(function* (
      requested: ReadonlyArray<string>,
      destinationDirectory: string,
    ) {
      const directory = yield* resolveDirectory(destinationDirectory);
      const sources = yield* resolveSources(requested, "change");
      const outcomes = new Map<number, Outcome<{ readonly destination?: string }>>();
      for (const [index, entry] of sources.resolved.entries()) {
        if (isFailure(entry) || sources.heads[index] !== index) continue;
        if (isFailure(directory)) {
          outcomes.set(index, directory);
          continue;
        }
        if (within(directory.real, entry.real)) {
          outcomes.set(index, failure("into_itself"));
          continue;
        }
        if (comparable(path.dirname(entry.real)) === comparable(directory.real)) {
          outcomes.set(index, { destination: entry.real });
          continue;
        }
        const target = yield* destination(directory, path.basename(entry.real));
        if (isFailure(target)) {
          outcomes.set(index, target);
          continue;
        }
        const taken = yield* Effect.promise(() =>
          NodeFSP.lstat(target.real).then(
            () => true,
            () => false,
          ),
        );
        if (taken) {
          outcomes.set(index, failure("name_taken"));
          continue;
        }
        // No copy-and-delete across devices: it is neither atomic nor bounded in time.
        const moved = yield* Effect.promise(() =>
          attempt(() => renameNoReplace(entry.real, target.real, entry.stats)),
        );
        if (isFailure(moved)) {
          outcomes.set(index, moved);
          continue;
        }
        touched(entry.real, target.real);
        outcomes.set(index, { destination: target.real });
      }
      return batchItems(requested, sources, outcomes);
    });

    /** Entry count and bytes, links not followed; stops once over budget. */
    const measure = async (
      root: string,
      budget: { entries: number; bytes: number },
    ): Promise<boolean> => {
      const pending = [root];
      while (pending.length > 0) {
        const current = pending.pop()!;
        const stats = await NodeFSP.lstat(current);
        budget.entries -= 1;
        if (stats.isFile()) budget.bytes -= stats.size;
        if (budget.entries < 0 || budget.bytes < 0) return false;
        if (stats.isDirectory()) {
          for (const child of await NodeFSP.readdir(current))
            pending.push(path.join(current, child));
        }
      }
      return true;
    };

    /** Claims the first free "keep both" name with an exclusive create, then fills it. */
    const copyEntry = async (
      entry: Entry,
      directory: string,
    ): Promise<Outcome<{ destination: string }>> => {
      const name = path.basename(entry.real);
      for (let index = 1; index <= KEEP_BOTH_MAX_ATTEMPTS; index++) {
        const candidateName = keepBothName(name, index, entry.stats.isDirectory());
        if (!isValidFileName(candidateName, platform)) return failure("invalid_name");
        const target = path.join(directory, candidateName);
        try {
          if (entry.stats.isSymbolicLink()) {
            await NodeFSP.symlink(await NodeFSP.readlink(entry.real), target);
          } else if (entry.stats.isDirectory()) {
            await NodeFSP.mkdir(target);
            try {
              // cp refuses an existing destination folder, and claiming the name made one.
              for (const child of await NodeFSP.readdir(entry.real)) {
                await NodeFSP.cp(path.join(entry.real, child), path.join(target, child), {
                  recursive: true,
                  errorOnExist: true,
                  force: false,
                  verbatimSymlinks: true,
                  preserveTimestamps: true,
                });
              }
              await NodeFSP.chmod(target, entry.stats.mode & 0o7777);
              await NodeFSP.utimes(target, entry.stats.atime, entry.stats.mtime);
            } catch (error) {
              await NodeFSP.rm(target, { recursive: true, force: true }).catch(() => undefined);
              throw error;
            }
          } else {
            await NodeFSP.copyFile(entry.real, target, NodeFS.constants.COPYFILE_EXCL);
            await NodeFSP.utimes(target, entry.stats.atime, entry.stats.mtime).catch(
              () => undefined,
            );
          }
          return { destination: target };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          return failure(errnoFailure(error));
        }
      }
      return failure("name_taken");
    };

    const copy = Effect.fn("FileOperations.copy")(function* (
      requested: ReadonlyArray<string>,
      destinationDirectory: string,
    ) {
      const directory = yield* resolveDirectory(destinationDirectory);
      const sources = yield* resolveSources(requested, "copy");
      const budget = { entries: COPY_MAX_ENTRIES, bytes: COPY_MAX_BYTES };
      const outcomes = new Map<number, Outcome<{ readonly destination?: string }>>();
      for (const [index, entry] of sources.resolved.entries()) {
        if (isFailure(entry) || sources.heads[index] !== index) continue;
        if (isFailure(directory)) {
          outcomes.set(index, directory);
          continue;
        }
        if (entry.stats.isDirectory() && within(directory.real, entry.real)) {
          outcomes.set(index, failure("into_itself"));
          continue;
        }
        const target = yield* destination(directory, path.basename(entry.real));
        if (isFailure(target)) {
          outcomes.set(index, target);
          continue;
        }
        const remaining = { ...budget };
        const measured = yield* Effect.promise(() => attempt(() => measure(entry.real, remaining)));
        if (isFailure(measured) || !measured.value) {
          outcomes.set(index, isFailure(measured) ? measured : failure("too_large"));
          continue;
        }
        budget.entries = remaining.entries;
        budget.bytes = remaining.bytes;
        const copied = yield* Effect.promise(() => copyEntry(entry, directory.real));
        if (!isFailure(copied)) touched(copied.destination);
        outcomes.set(index, copied);
      }
      return batchItems(requested, sources, outcomes);
    });

    const trash = Effect.fn("FileOperations.trash")(function* (
      requested: ReadonlyArray<string>,
      onUnavailable: "fail" | "delete",
    ) {
      const sources = yield* resolveSources(requested, "change");
      const heads = sources.resolved.flatMap((entry, index) =>
        isFailure(entry) || sources.heads[index] !== index ? [] : [{ index, entry }],
      );
      const trashed = yield* hostTrash.trash(heads.map(({ entry }) => entry.real));
      const outcomes = new Map<number, Outcome<{ readonly destination?: string }>>();
      for (const [position, { index, entry }] of heads.entries()) {
        const result = trashed[position] ?? "failed";
        const removed =
          result === "unavailable" && onUnavailable === "delete"
            ? yield* Effect.promise(() =>
                attempt(() => NodeFSP.rm(entry.real, { recursive: true, force: false })),
              )
            : result === "trashed"
              ? {}
              : failure(result === "unavailable" ? "trash_unavailable" : result);
        if (!isFailure(removed)) touched(entry.real);
        outcomes.set(index, isFailure(removed) ? removed : {});
      }
      return batchItems(requested, sources, outcomes);
    });

    const single = (
      requested: string,
      outcome: Outcome<{ readonly destination?: string }>,
    ): ReadonlyArray<FilesystemFileOperationItem> => [
      isFailure(outcome)
        ? { path: requested, failure: outcome.failure }
        : {
            path: requested,
            ...(outcome.destination === undefined
              ? {}
              : { destination: display(outcome.destination) }),
          },
    ];

    const operation = input.operation;
    const items = yield* rootSemaphore(realRoot).withPermits(1)(
      Effect.gen(function* () {
        switch (operation._tag) {
          case "createFile":
            return single(operation.path, yield* createFile(operation.path));
          case "createDirectory":
            return single(operation.path, yield* createDirectory(operation.path));
          case "rename":
            return single(operation.path, yield* rename(operation.path, operation.name));
          case "move":
            return yield* move(operation.paths, operation.destinationDirectory);
          case "copy":
            return yield* copy(operation.paths, operation.destinationDirectory);
          case "trash":
            return yield* trash(operation.paths, operation.onUnavailable);
        }
      }),
    );
    if (scoped && changed.size > 0) yield* refreshSearchIndex(input.root);
    return { items, changedDirectories: [...changed] };
  });

  return FileOperations.of({ run });
});

export const layer = Layer.effect(FileOperations, make);
