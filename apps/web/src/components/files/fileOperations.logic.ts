import type {
  ContextMenuItem,
  EnvironmentId,
  FilesystemFileOperation,
  FilesystemFileOperationFailure,
  FilesystemFileOperationItem,
  FilesystemFileOperationResult,
} from "@t3tools/contracts";
import {
  fileBasename,
  resolveWorkspaceFilePath,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

export const FILE_OPERATION_BATCH_LIMIT = 128;

export type FileClipboardMode = "copy" | "cut";

export interface FileClipboard {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** Absolute, so a paste into another folder of the same environment still finds them. */
  readonly paths: readonly string[];
  readonly mode: FileClipboardMode;
}

export interface FilePathMove {
  readonly from: string;
  readonly to: string;
}

/** Root-relative (`""` is the root) or absolute, to absolute. */
export function absoluteFilePath(path: string, root: string): string {
  return path === "" || path === "." ? root : resolveWorkspaceFilePath(path, root);
}

/** Root-relative inside the root, so a project root keeps its containment check; absolute elsewhere. */
export function requestFilePath(absolutePath: string, root: string): string {
  const relative = workspaceRelativeFilePath(absolutePath, root);
  return relative === null ? absolutePath : relative;
}

export function isSameOrInside(path: string, ancestor: string): boolean {
  return workspaceRelativeFilePath(path, ancestor) !== null;
}

export function parentFilePath(absolutePath: string): string {
  const trimmed = absolutePath.replace(/(?<=.)[/\\]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (separator < 0) return trimmed;
  const parent = trimmed.slice(0, separator);
  if (parent === "") return trimmed.slice(0, 1);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** Drops duplicates and anything inside another selected folder, keeping the selection order. */
export function collapseDescendantPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter(
    (path) => !unique.some((other) => other !== path && isSameOrInside(path, other)),
  );
}

export function canPasteInto(
  clipboard: FileClipboard | null,
  environmentId: EnvironmentId,
  destinationDirectory: string,
): boolean {
  if (clipboard === null || clipboard.environmentId !== environmentId) return false;
  return !clipboard.paths.some((path) => isSameOrInside(destinationDirectory, path));
}

const failed = (item: FilesystemFileOperationItem) => item.failure !== undefined;

export function fileOperationMoves(
  result: FilesystemFileOperationResult,
  root: string,
): FilePathMove[] {
  return result.items.flatMap((item) =>
    item.failure === undefined && item.destination !== undefined && item.destination !== item.path
      ? [{ from: absoluteFilePath(item.path, root), to: absoluteFilePath(item.destination, root) }]
      : [],
  );
}

export function fileOperationRemovedPaths(
  operation: FilesystemFileOperation,
  result: FilesystemFileOperationResult,
  root: string,
): string[] {
  if (operation._tag === "trash") {
    return result.items
      .filter((item) => !failed(item))
      .map((item) => absoluteFilePath(item.path, root));
  }
  return fileOperationMoves(result, root).map((move) => move.from);
}

/** The operations that put a rename or move back, one per original folder. */
export function inverseFileOperations(
  operation: FilesystemFileOperation,
  result: FilesystemFileOperationResult,
  root: string,
): FilesystemFileOperation[] {
  const moves = fileOperationMoves(result, root);
  if (moves.length === 0) return [];
  if (operation._tag === "rename") {
    const [move] = moves;
    return move
      ? [{ _tag: "rename", path: requestFilePath(move.to, root), name: fileBasename(move.from) }]
      : [];
  }
  if (operation._tag !== "move") return [];
  const byParent = new Map<string, string[]>();
  for (const move of moves) {
    const parent = parentFilePath(move.from);
    byParent.set(parent, [...(byParent.get(parent) ?? []), requestFilePath(move.to, root)]);
  }
  return [...byParent].map(([parent, paths]) => ({
    _tag: "move",
    paths,
    destinationDirectory: requestFilePath(parent, root),
  }));
}

/** "untitled", then "untitled 2", "untitled 3"… among the names a folder already holds. */
export function freeEntryName(base: string, taken: ReadonlySet<string>): string {
  const lowerTaken = new Set([...taken].map((name) => name.toLowerCase()));
  if (!lowerTaken.has(base.toLowerCase())) return base;
  for (let index = 2; ; index++) {
    const candidate = `${base} ${index}`;
    if (!lowerTaken.has(candidate.toLowerCase())) return candidate;
  }
}

function fileOperationFailureMessage(failure: FilesystemFileOperationFailure): string {
  switch (failure) {
    case "name_taken":
      return "An item with that name already exists.";
    case "invalid_name":
      return "That name isn't allowed on this computer.";
    case "not_found":
      return "It no longer exists.";
    case "not_directory":
      return "The destination isn't a folder.";
    case "permission_denied":
      return "Permission denied.";
    case "protected":
      return "Git metadata, repositories, system folders and the home folder can't be changed here.";
    case "outside_root":
      return "It resolves outside the project.";
    case "into_itself":
      return "A folder can't go inside itself.";
    case "cross_device":
      return "It's on another disk. Copy it instead.";
    case "too_large":
      return "It's too large to copy: over 10,000 items or 1 GB.";
    case "trash_unavailable":
      return "The trash isn't available on this computer.";
    case "failed":
      return "The operation failed.";
  }
}

/** A toast for the items that failed, or null when all succeeded. */
export function fileOperationFailureSummary(
  verb: string,
  result: FilesystemFileOperationResult,
): { title: string; description: string } | null {
  const failures = result.items.filter(failed);
  const first = failures[0];
  if (first?.failure === undefined) return null;
  const name = fileBasename(first.path) || first.path;
  return {
    title:
      result.items.length === 1
        ? `Couldn't ${verb} ${name}`
        : `Couldn't ${verb} ${failures.length} of ${result.items.length} items`,
    description:
      result.items.length === 1
        ? fileOperationFailureMessage(first.failure)
        : `${name}: ${fileOperationFailureMessage(first.failure)}`,
  };
}

const LISTED_PATHS = 10;

export function listedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, LISTED_PATHS).join("\n");
  const more = paths.length - LISTED_PATHS;
  return more > 0 ? `${shown}\nand ${more} more` : shown;
}

export function itemCountLabel(paths: readonly string[]): string {
  return paths.length === 1 ? `“${fileBasename(paths[0]!)}”` : `${paths.length} items`;
}

export type FileOperationMenuAction =
  | "new-file"
  | "new-folder"
  | "rename"
  | "duplicate"
  | "cut"
  | "copy"
  | "paste"
  | "copy-path"
  | "copy-relative-path"
  | "trash";

/** Write items are left out without write access, rather than shown disabled. */
export function fileOperationMenuItems(input: {
  /** Selected items the menu acts on; none for a folder's empty space. */
  readonly targetCount: number;
  readonly canWrite: boolean;
  readonly canPaste: boolean;
  readonly hasRelativePaths: boolean;
}): ContextMenuItem<FileOperationMenuAction>[] {
  const { targetCount, canWrite } = input;
  const some = targetCount > 0;
  type Item = ContextMenuItem<FileOperationMenuAction>;
  const groups: Item[][] = [
    canWrite && targetCount <= 1
      ? [
          { id: "new-file", label: "New File" },
          { id: "new-folder", label: "New Folder" },
        ]
      : [],
    [
      ...(canWrite && targetCount === 1 ? [{ id: "rename", label: "Rename" } as const] : []),
      ...(canWrite && some ? [{ id: "duplicate", label: "Duplicate" } as const] : []),
    ],
    canWrite
      ? [
          ...(some
            ? [{ id: "cut", label: "Cut" } as const, { id: "copy", label: "Copy" } as const]
            : []),
          { id: "paste", label: "Paste", disabled: !input.canPaste },
        ]
      : [],
    [
      { id: "copy-path", label: "Copy Path" },
      ...(some && input.hasRelativePaths
        ? [{ id: "copy-relative-path", label: "Copy Relative Path" } as const]
        : []),
    ],
    canWrite && some ? [{ id: "trash", label: "Move to Trash", destructive: true }] : [],
  ];
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) =>
      group.map((item, position) =>
        index > 0 && position === 0 ? { ...item, separatorBefore: true } : item,
      ),
    );
}
