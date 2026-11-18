import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FilesystemFileOperation,
  FilesystemFileOperationResult,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { fileBasename } from "@t3tools/shared/path";

import { toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

import {
  FILE_OPERATION_BATCH_LIMIT,
  type FileClipboardMode,
  type FilePathMove,
  absoluteFilePath,
  canPasteInto,
  collapseDescendantPaths,
  fileOperationFailureSummary,
  fileOperationMoves,
  fileOperationRemovedPaths,
  freeEntryName,
  inverseFileOperations,
  itemCountLabel,
  listedPaths,
  parentFilePath,
  requestFilePath,
} from "./fileOperations.logic";
import { publishFileTreeChange, readFileClipboard, setFileClipboard } from "./fileOperationsState";
import { joinHostPath } from "./filePath";
import {
  discardFileSaveSessionsUnder,
  flushFileSaveSessionsUnder,
  unsavedFileSaveSessionsUnder,
} from "./fileSaveSessions";

/** Where file operations run: a project or worktree root, or a host folder. */
export interface FileOperationsTarget {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** Host folders list absolute paths in confirmations; projects list root-relative ones. */
  readonly hostFolder: boolean;
  /** Absolute moves, for the acting panel to retarget its tabs. */
  readonly onMoved?: ((moves: readonly FilePathMove[]) => void) | undefined;
}

const FLUSH_WAIT_MS = 5_000;

export function useCanWriteFiles(environmentId: EnvironmentId): boolean {
  return useAtomValue(projectEnvironment.fileOperation.permissionAtom(environmentId));
}

function operationSources(operation: FilesystemFileOperation): readonly string[] {
  switch (operation._tag) {
    case "rename":
      return [operation.path];
    case "move":
    case "trash":
      return operation.paths;
    default:
      return [];
  }
}

async function flushDrafts(environmentId: EnvironmentId, paths: readonly string[]) {
  if (paths.length === 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    flushFileSaveSessionsUnder(environmentId, paths),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, FLUSH_WAIT_MS);
    }),
  ]);
  clearTimeout(timeout);
}

/** Runs one operation and tells every panel what changed; null when the request itself failed. */
async function runFileOperation(
  target: FileOperationsTarget,
  operation: FilesystemFileOperation,
  verb: string,
): Promise<FilesystemFileOperationResult | null> {
  const { environmentId, root } = target;
  const sources = operationSources(operation).map((path) => absoluteFilePath(path, root));
  // Autosave must land before the file moves; the server refuses to recreate it afterwards.
  await flushDrafts(environmentId, sources);
  if (operation._tag === "rename" || operation._tag === "move") {
    const unsaved = unsavedFileSaveSessionsUnder(environmentId, sources);
    if (unsaved.length > 0) {
      toastManager.add({
        type: "error",
        title: `Couldn't ${verb}`,
        description: `${unsaved[0]}${unsaved.length > 1 ? ` and ${unsaved.length - 1} more` : ""} has unsaved edits that couldn't be saved.`,
      });
      return null;
    }
  }
  const response = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.fileOperation,
    { environmentId, input: { root, operation } },
    { reportFailure: false },
  );
  if (response._tag === "Failure") {
    if (!isAtomCommandInterrupted(response)) {
      const cause = squashAtomCommandFailure(response);
      toastManager.add({
        type: "error",
        title: `Couldn't ${verb}`,
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    return null;
  }
  const result = response.value;
  const removed = fileOperationRemovedPaths(operation, result, root);
  if (operation._tag === "trash") discardFileSaveSessionsUnder(environmentId, removed);
  const moves = fileOperationMoves(result, root);
  if (operation._tag === "rename" || operation._tag === "move") target.onMoved?.(moves);
  publishFileTreeChange({
    environmentId,
    directories: result.changedDirectories.map((path) => absoluteFilePath(path, root)),
    removed,
  });
  return result;
}

function reportFailures(verb: string, result: FilesystemFileOperationResult) {
  const summary = fileOperationFailureSummary(verb, result);
  if (summary) toastManager.add({ type: "error", ...summary });
}

function withinBatchLimit(paths: readonly string[]): boolean {
  if (paths.length <= FILE_OPERATION_BATCH_LIMIT) return true;
  toastManager.add({
    type: "error",
    title: `Select at most ${FILE_OPERATION_BATCH_LIMIT} items`,
    description: `${paths.length} items are selected.`,
  });
  return false;
}

function offerUndo(
  target: FileOperationsTarget,
  title: string,
  operation: FilesystemFileOperation,
  result: FilesystemFileOperationResult,
) {
  const inverse = inverseFileOperations(operation, result, target.root);
  if (inverse.length === 0) return;
  const id = toastManager.add({
    type: "success",
    title,
    actionProps: {
      children: "Undo",
      onClick: () => {
        toastManager.close(id);
        void (async () => {
          for (const undo of inverse) {
            const undone = await runFileOperation(target, undo, "undo");
            if (undone) reportFailures("undo", undone);
          }
        })();
      },
    },
  });
}

/** Absolute paths; the caller passes the selection as the tree holds it. */
function absolutePaths(target: FileOperationsTarget, paths: readonly string[]) {
  return collapseDescendantPaths(paths.map((path) => absoluteFilePath(path, target.root)));
}

export async function renameFileEntry(
  target: FileOperationsTarget,
  path: string,
  name: string,
): Promise<boolean> {
  const operation = {
    _tag: "rename",
    path: requestFilePath(absoluteFilePath(path, target.root), target.root),
    name,
  } as const;
  const result = await runFileOperation(target, operation, `rename ${fileBasename(path)}`);
  if (!result) return false;
  reportFailures("rename", result);
  if (result.items.some((item) => item.failure !== undefined)) return false;
  offerUndo(target, `Renamed to ${name}`, operation, result);
  return true;
}

/** Creates "untitled" (or "untitled folder") in `directory`, returning its root-relative path. */
export async function createFileEntry(
  target: FileOperationsTarget,
  kind: "file" | "directory",
  directory: string,
  existingNames: ReadonlySet<string>,
): Promise<string | null> {
  const taken = new Set(existingNames);
  const directoryPath = absoluteFilePath(directory, target.root);
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = freeEntryName(kind === "file" ? "untitled" : "untitled folder", taken);
    const path = requestFilePath(joinHostPath(directoryPath, name), target.root);
    const operation = { _tag: kind === "file" ? "createFile" : "createDirectory", path } as const;
    const result = await runFileOperation(
      target,
      operation,
      kind === "file" ? "create a file" : "create a folder",
    );
    const item = result?.items[0];
    if (!result || !item) return null;
    if (item.failure === "name_taken") {
      taken.add(name);
      continue;
    }
    if (item.failure !== undefined) {
      reportFailures("create", result);
      return null;
    }
    return item.destination ?? path;
  }
  return null;
}

export function copyFilesToClipboard(
  target: FileOperationsTarget,
  paths: readonly string[],
  mode: FileClipboardMode,
): void {
  if (paths.length === 0) return;
  setFileClipboard({
    environmentId: target.environmentId,
    root: target.root,
    paths: absolutePaths(target, paths),
    mode,
  });
}

export function canPasteFiles(target: FileOperationsTarget, directory: string): boolean {
  return canPasteInto(
    readFileClipboard(),
    target.environmentId,
    absoluteFilePath(directory, target.root),
  );
}

export async function pasteFiles(target: FileOperationsTarget, directory: string): Promise<void> {
  const clipboard = readFileClipboard();
  const destination = absoluteFilePath(directory, target.root);
  if (!clipboard || !canPasteInto(clipboard, target.environmentId, destination)) return;
  if (!withinBatchLimit(clipboard.paths)) return;
  const move = clipboard.mode === "cut";
  const operation = {
    _tag: move ? "move" : "copy",
    paths: clipboard.paths.map((path) => requestFilePath(path, target.root)),
    destinationDirectory: requestFilePath(destination, target.root),
  } as const;
  const verb = move ? "move" : "copy";
  const result = await runFileOperation(
    target,
    operation,
    `${verb} ${itemCountLabel(clipboard.paths)}`,
  );
  if (!result) return;
  reportFailures(verb, result);
  if (!move) return;
  if (readFileClipboard() === clipboard) setFileClipboard(null);
  const moved = fileOperationMoves(result, target.root).length;
  if (moved > 0) {
    offerUndo(target, `Moved ${moved === 1 ? "1 item" : `${moved} items`}`, operation, result);
  }
}

export async function duplicateFiles(
  target: FileOperationsTarget,
  paths: readonly string[],
): Promise<void> {
  const sources = absolutePaths(target, paths);
  if (sources.length === 0 || !withinBatchLimit(sources)) return;
  const byParent = new Map<string, string[]>();
  for (const source of sources) {
    const parent = parentFilePath(source);
    byParent.set(parent, [...(byParent.get(parent) ?? []), requestFilePath(source, target.root)]);
  }
  for (const [parent, group] of byParent) {
    const result = await runFileOperation(
      target,
      { _tag: "copy", paths: group, destinationDirectory: requestFilePath(parent, target.root) },
      `duplicate ${itemCountLabel(group)}`,
    );
    if (result) reportFailures("duplicate", result);
  }
}

export async function copyFilePaths(
  target: FileOperationsTarget,
  paths: readonly string[],
  relative: boolean,
): Promise<void> {
  const absolute = paths.length === 0 ? [target.root] : absolutePaths(target, paths);
  const text = absolute
    .map((path) => (relative ? requestFilePath(path, target.root) : path))
    .join("\n");
  try {
    await writeTextToClipboard(text);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to copy path",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

/** Always confirms; when the host has no usable trash, a second confirm offers deleting for good. */
export async function trashFiles(
  target: FileOperationsTarget,
  paths: readonly string[],
): Promise<void> {
  const api = readLocalApi();
  const sources = absolutePaths(target, paths);
  if (!api || sources.length === 0 || !withinBatchLimit(sources)) return;
  const shown = (list: readonly string[]) =>
    listedPaths(target.hostFolder ? list : list.map((path) => requestFilePath(path, target.root)));
  const confirmed = await api.dialogs.confirm(
    `Move ${itemCountLabel(sources)} to the Trash?\n${shown(sources)}`,
    { variant: "destructive", confirmLabel: "Move to Trash" },
  );
  if (!confirmed) return;
  const request = sources.map((path) => requestFilePath(path, target.root));
  const result = await runFileOperation(
    target,
    { _tag: "trash", paths: request, onUnavailable: "fail" },
    `move ${itemCountLabel(sources)} to the Trash`,
  );
  if (!result) return;
  const unavailable = result.items.filter((item) => item.failure === "trash_unavailable");
  const otherFailures = {
    ...result,
    items: result.items.filter((item) => item.failure !== "trash_unavailable"),
  };
  reportFailures("move to the Trash", otherFailures);
  if (unavailable.length === 0) return;
  const remaining = unavailable.map((item) => absoluteFilePath(item.path, target.root));
  const deleteForGood = await api.dialogs.confirm(
    `Delete ${itemCountLabel(remaining)} permanently?\nThis computer has no trash to move ${remaining.length === 1 ? "it" : "them"} to. This can't be undone.\n${shown(remaining)}`,
    { variant: "destructive", confirmLabel: "Delete permanently" },
  );
  if (!deleteForGood) return;
  const deleted = await runFileOperation(
    target,
    { _tag: "trash", paths: unavailable.map((item) => item.path), onUnavailable: "delete" },
    `delete ${itemCountLabel(remaining)}`,
  );
  if (deleted) reportFailures("delete", deleted);
}
