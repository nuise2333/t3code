import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";

export interface FileTreeExpansionModel {
  getItem(path: string): unknown;
}

type DirectoryHandle = {
  isDirectory(): boolean;
  isExpanded(): boolean;
  expand(): void;
  collapse(): void;
};

function asDirectoryHandle(item: unknown): DirectoryHandle | null {
  if (
    typeof item !== "object" ||
    item === null ||
    !("isDirectory" in item) ||
    typeof item.isDirectory !== "function" ||
    !item.isDirectory() ||
    !("isExpanded" in item) ||
    typeof item.isExpanded !== "function" ||
    !("expand" in item) ||
    typeof item.expand !== "function" ||
    !("collapse" in item) ||
    typeof item.collapse !== "function"
  ) {
    return null;
  }
  return item as DirectoryHandle;
}

/**
 * Calls `listener` once per task, however many events the model emitted in it. Expanding every
 * folder emits one event per folder, and a listener that rescans the folders is quadratic otherwise.
 */
export function subscribeOncePerTask(
  model: { subscribe(listener: () => void): () => void },
  listener: () => void,
): () => void {
  let queued = false;
  let subscribed = true;
  const unsubscribe = model.subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (subscribed) listener();
    });
  });
  return () => {
    subscribed = false;
    unsubscribe();
  };
}

export function areAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
): boolean {
  return (
    directoryPaths.length > 0 &&
    directoryPaths.every((path) => {
      const item = asDirectoryHandle(model.getItem(path));
      return item !== null && item.isExpanded();
    })
  );
}

export function setAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
  expanded: boolean,
): void {
  for (const path of directoryPaths) {
    const item = asDirectoryHandle(model.getItem(path));
    if (item === null || item.isExpanded() === expanded) continue;
    if (expanded) item.expand();
    else item.collapse();
  }
}

/** Calls made while `run` is running rerun it once it returns, instead of nesting. */
export function coalesceReentrantCalls(run: () => void): () => void {
  let running = false;
  let calledAgain = false;
  return () => {
    if (running) {
      calledAgain = true;
      return;
    }
    running = true;
    try {
      do {
        calledAgain = false;
        run();
      } while (calledAgain);
    } finally {
      running = false;
    }
  };
}

const EXPANDED_DIRECTORIES_STORAGE_KEY = "t3code.fileTreeExpandedDirectories";
// Roots are kept most recent first and capped so worktrees and Files tabs that come and go do not
// grow storage.
const MAX_STORED_ROOTS = 50;
const StoredExpandedDirectories = Schema.Array(
  Schema.Struct({ root: Schema.String, paths: Schema.Array(Schema.String) }),
);

function readStoredExpandedDirectories() {
  try {
    return getLocalStorageItem(EXPANDED_DIRECTORIES_STORAGE_KEY, StoredExpandedDirectories) ?? [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

/** A root with nothing saved starts from `fallbackRoot`'s folders. */
export function readExpandedDirectories(root: string, fallbackRoot?: string): readonly string[] {
  const stored = readStoredExpandedDirectories();
  return (
    (
      stored.find((entry) => entry.root === root) ??
      (fallbackRoot === undefined ? undefined : stored.find((entry) => entry.root === fallbackRoot))
    )?.paths ?? []
  );
}

/** keepEmpty saves an empty list so a fallback does not reexpand what was collapsed. */
export function writeExpandedDirectories(
  root: string,
  paths: readonly string[],
  keepEmpty = false,
): void {
  writeStoredExpandedDirectories(root, paths.length > 0 || keepEmpty ? [{ root, paths }] : []);
}

/** Gives `toSuffix`'s tab a copy of each root `fromSuffix`'s tab saved. */
export function duplicateExpandedDirectories(fromSuffix: string, toSuffix: string): void {
  const copies = readStoredExpandedDirectories().flatMap((entry) =>
    entry.root.endsWith(`#${fromSuffix}`)
      ? [{ root: `${entry.root.slice(0, -fromSuffix.length)}${toSuffix}`, paths: entry.paths }]
      : [],
  );
  if (copies.length > 0) writeStoredExpandedDirectories(null, copies);
}

function writeStoredExpandedDirectories(
  replacedRoot: string | null,
  added: readonly { root: string; paths: readonly string[] }[],
): void {
  const addedRoots = new Set(added.map((entry) => entry.root));
  const others = readStoredExpandedDirectories().filter(
    (entry) => entry.root !== replacedRoot && !addedRoots.has(entry.root),
  );
  const next = [...added, ...others];
  try {
    setLocalStorageItem(
      EXPANDED_DIRECTORIES_STORAGE_KEY,
      next.slice(0, MAX_STORED_ROOTS),
      StoredExpandedDirectories,
    );
  } catch (error) {
    console.error(error);
  }
}
