import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectEntryKind, ProjectFileCategory } from "./project.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FILESYSTEM_METADATA_BATCH_LIMIT = 64;

export const FilesystemGetMetadataInput = Schema.Struct({
  // Absolute host paths, including ~/; clients must anchor relative paths.
  paths: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(FILESYSTEM_METADATA_BATCH_LIMIT)),
});
export type FilesystemGetMetadataInput = typeof FilesystemGetMetadataInput.Type;

export const FilesystemEntryMetadata = Schema.Struct({
  kind: Schema.Literals(["file", "directory", "other"]),
  byteLength: Schema.optionalKey(NonNegativeInt),
  mimeType: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FilesystemEntryMetadata = typeof FilesystemEntryMetadata.Type;

// Entries follow request order; null means missing, unreadable, or unsupported.
export const FilesystemGetMetadataResult = Schema.Struct({
  entries: Schema.Array(Schema.NullOr(FilesystemEntryMetadata)),
});
export type FilesystemGetMetadataResult = typeof FilesystemGetMetadataResult.Type;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  "current_project_required",
  "read_directory_failed",
]);
export type FilesystemBrowseFailure = typeof FilesystemBrowseFailure.Type;

function decodedFilesystemBrowseErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class FilesystemBrowseError extends Schema.TaggedError<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    partialPath: Schema.optional(TrimmedNonEmptyString),
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(TrimmedNonEmptyString),
    platform: Schema.optional(TrimmedNonEmptyString),
    /** Set when the directory does not exist; older clients ignore it. */
    pathMissing: Schema.optional(Schema.Boolean),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly partialPath: string;
    readonly cwd?: string | undefined;
    readonly failure: FilesystemBrowseFailure;
    readonly parentPath?: string;
    readonly platform?: string;
    readonly pathMissing?: boolean;
    readonly cause?: unknown;
  }) {
    const cwd = props.cwd === undefined ? "" : ` from '${props.cwd}'`;
    super({
      ...props,
      message:
        decodedFilesystemBrowseErrorMessage(props) ??
        `Failed to browse filesystem path '${props.partialPath}'${cwd}.`,
    } as any);
  }
}

const FILESYSTEM_SEARCH_HOST_MAX_LIMIT = 200;

export const HostFileSearchBackend = Schema.Literals([
  "spotlight",
  "plocate",
  "locate",
  "everything",
]);
export type HostFileSearchBackend = typeof HostFileSearchBackend.Type;

export const FilesystemSearchHostInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMinLength(2), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(FILESYSTEM_SEARCH_HOST_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  category: Schema.optional(ProjectFileCategory),
});
export type FilesystemSearchHostInput = typeof FilesystemSearchHostInput.Type;

export const FilesystemSearchHostEntry = Schema.Struct({
  /** Absolute host path, untrimmed: names may end in whitespace. */
  path: Schema.String.check(Schema.isNonEmpty()),
  kind: ProjectEntryKind,
});
export type FilesystemSearchHostEntry = typeof FilesystemSearchHostEntry.Type;

export const FilesystemSearchHostResult = Schema.Struct({
  entries: Schema.Array(FilesystemSearchHostEntry),
  /** More matches existed, or the index answered too slowly to list them all. */
  truncated: Schema.Boolean,
});
export type FilesystemSearchHostResult = typeof FilesystemSearchHostResult.Type;

export class FilesystemSearchHostError extends Schema.TaggedError<FilesystemSearchHostError>()(
  "FilesystemSearchHostError",
  {
    /** `unavailable`: the host has no usable file index right now. */
    reason: Schema.Literals(["unavailable", "failed"]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === "unavailable"
      ? "File search is not available on this host."
      : "File search failed on this host.";
  }
}

const FILESYSTEM_FILE_OPERATION_BATCH_LIMIT = 128;

/** Relative to the operation's `root`, or an absolute host path. */
const FileOperationPath = Schema.NonEmptyString.check(
  Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH),
);
const FileOperationPaths = Schema.Array(FileOperationPath).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(FILESYSTEM_FILE_OPERATION_BATCH_LIMIT),
);

export const FilesystemFileOperation = Schema.Union([
  Schema.TaggedStruct("createFile", { path: FileOperationPath }),
  Schema.TaggedStruct("createDirectory", { path: FileOperationPath }),
  Schema.TaggedStruct("rename", {
    path: FileOperationPath,
    name: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
  }),
  Schema.TaggedStruct("move", {
    paths: FileOperationPaths,
    destinationDirectory: FileOperationPath,
  }),
  /** Keeps both on a taken name ("name 2.ext"); a copy into the source's own folder duplicates. */
  Schema.TaggedStruct("copy", {
    paths: FileOperationPaths,
    destinationDirectory: FileOperationPath,
  }),
  Schema.TaggedStruct("trash", {
    paths: FileOperationPaths,
    /** `delete` removes permanently only the items the host trash could not take. */
    onUnavailable: Schema.Literals(["fail", "delete"]),
  }),
]);
export type FilesystemFileOperation = typeof FilesystemFileOperation.Type;

export const FilesystemFileOperationInput = Schema.Struct({
  /** A project or worktree root, or a host folder; relative paths resolve against it. */
  root: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  operation: FilesystemFileOperation,
});
export type FilesystemFileOperationInput = typeof FilesystemFileOperationInput.Type;

export const FilesystemFileOperationFailure = Schema.Literals([
  "name_taken",
  "invalid_name",
  "not_found",
  "not_directory",
  "permission_denied",
  /** Git metadata, a repository or workspace root, a system folder, home, or T3 home. */
  "protected",
  /** Resolves outside a project root, through a symlink for example. */
  "outside_root",
  "into_itself",
  "cross_device",
  "too_large",
  "trash_unavailable",
  "failed",
]);
export type FilesystemFileOperationFailure = typeof FilesystemFileOperationFailure.Type;

export const FilesystemFileOperationItem = Schema.Struct({
  /** As requested. */
  path: Schema.String,
  /** Where the item now is, after a create, rename, move, or copy. */
  destination: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(FilesystemFileOperationFailure),
});
export type FilesystemFileOperationItem = typeof FilesystemFileOperationItem.Type;

/**
 * Items follow request order. Paths inside `root` come back root-relative with `/`
 * separators (`""` is the root itself); other paths come back absolute.
 */
export const FilesystemFileOperationResult = Schema.Struct({
  items: Schema.Array(FilesystemFileOperationItem),
  changedDirectories: Schema.Array(Schema.String),
});
export type FilesystemFileOperationResult = typeof FilesystemFileOperationResult.Type;

export class FilesystemFileOperationError extends Schema.TaggedError<FilesystemFileOperationError>()(
  "FilesystemFileOperationError",
  {
    root: Schema.String,
    /** `root_unavailable`: the root is missing, not a folder, or a network path. */
    reason: Schema.Literals(["root_unavailable"]),
  },
) {
  override get message(): string {
    return `'${this.root}' is not an existing local folder.`;
  }
}
