import type {
  HostFileSearchBackend,
  KeybindingShortcut,
  ProjectEntry,
  ProjectEntryKind,
  ProjectFileCategory,
} from "@t3tools/contracts";
import { fileCategoryOf } from "@t3tools/shared/fileCategory";
import { isHostPath, isWindowsAbsolutePath, unwrapPastedPath } from "@t3tools/shared/path";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

import type { CommandPaletteGroup } from "../CommandPalette.logic";

export const PROJECT_FILE_PICKER_RESULT_LIMIT = 200;
const ALL_TAB_FILE_LIMIT = 50;
const ALL_TAB_FOLDER_LIMIT = 20;
const ALL_TAB_THREAD_LIMIT = 20;

export const PROJECT_FILE_PICKER_TABS = [
  { value: "all", label: "All" },
  { value: "files", label: "Files" },
  { value: "folders", label: "Folders" },
  { value: "document", label: "Docs" },
  { value: "image", label: "Images" },
  { value: "code", label: "Code" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "archive", label: "Archives" },
  { value: "threads", label: "Threads" },
] as const satisfies ReadonlyArray<{
  readonly value: "all" | "files" | "folders" | "threads" | ProjectFileCategory;
  readonly label: string;
}>;

export type ProjectFilePickerTab = (typeof PROJECT_FILE_PICKER_TABS)[number]["value"];

/** Whether paths come from the project or from the host's file index. Threads ignore it. */
export type ProjectFilePickerScope = "project" | "host";

/** Hardcoded like Tab for categories; `mod+.` is unbound by default and in the desktop menu. */
export const PROJECT_FILE_PICKER_SCOPE_SHORTCUT: KeybindingShortcut = {
  key: ".",
  modKey: true,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

/** Why the host scope can't be chosen, or null when it can. */
export function projectFilePickerHostScopeDisabledReason(input: {
  readonly hostFileSearch: HostFileSearchBackend | undefined;
  readonly canReadFiles: boolean;
}): string | null {
  if (!input.canReadFiles) return "This connection cannot read host files.";
  if (input.hostFileSearch === undefined) {
    return "This host has no file index to search (Spotlight, plocate, locate, or Everything).";
  }
  return null;
}

export interface ProjectFilePickerPastedPath {
  readonly path: string;
  /**
   * Whether the row goes above the path results. `/` or `/src` is more often a project search,
   * whose matcher ignores a leading slash, so only an unmistakable path takes Enter.
   */
  readonly leads: boolean;
}

/** The host path a query holds when it is one pasted from a file manager, terminal, or file URL. */
export function projectFilePickerPastedPath(query: string): ProjectFilePickerPastedPath | null {
  const path = unwrapPastedPath(query);
  if (path === null || !isHostPath(path)) return null;
  const trimmed = query.trim();
  const leads =
    /^['"]|^file:\/\//.test(trimmed) ||
    path.startsWith("~/") ||
    isWindowsAbsolutePath(path) ||
    /^\/[^/]+\/./.test(path);
  return { path, leads };
}

export interface ProjectFilePickerPathFilter {
  readonly kind?: ProjectEntryKind;
  readonly category?: ProjectFileCategory;
}

/** The path search a tab shows, or null when it shows no paths. "All" searches files and folders together. */
export function projectFilePickerPathFilter(
  tab: ProjectFilePickerTab,
): ProjectFilePickerPathFilter | null {
  switch (tab) {
    case "all":
      return {};
    case "files":
      return { kind: "file" };
    case "folders":
      return { kind: "directory" };
    case "threads":
      return null;
    default:
      return { kind: "file", category: tab };
  }
}

export function stepProjectFilePickerTab(
  tab: ProjectFilePickerTab,
  step: 1 | -1,
): ProjectFilePickerTab {
  const index = PROJECT_FILE_PICKER_TABS.findIndex((candidate) => candidate.value === tab);
  const count = PROJECT_FILE_PICKER_TABS.length;
  return PROJECT_FILE_PICKER_TABS[(index + step + count) % count]!.value;
}

export interface ProjectFilePickerMatchRange {
  readonly start: number;
  readonly end: number;
}

export interface ProjectFilePickerMatch {
  readonly name: string;
  readonly nameMatchRanges: ReadonlyArray<ProjectFilePickerMatchRange>;
  readonly path: string;
  readonly pathMatchRanges: ReadonlyArray<ProjectFilePickerMatchRange>;
}

function fileName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function subsequenceRanges(value: string, token: string): ProjectFilePickerMatchRange[] {
  const ranges: ProjectFilePickerMatchRange[] = [];
  let tokenIndex = 0;
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== token[tokenIndex]) continue;
    ranges.push({ start: valueIndex, end: valueIndex + 1 });
    tokenIndex += 1;
    if (tokenIndex === token.length) return ranges;
  }
  return [];
}

/** Server-matched entries may match no token here; they still render, without highlights. */
function findMatchRanges(
  value: string,
  tokens: ReadonlyArray<string>,
): ProjectFilePickerMatchRange[] {
  const normalizedValue = value.toLowerCase();
  const ranges = tokens
    .flatMap((token) => {
      const start = normalizedValue.indexOf(token);
      return start === -1
        ? subsequenceRanges(normalizedValue, token)
        : [{ start, end: start + token.length }];
    })
    .sort((left, right) => left.start - right.start);

  const merged: ProjectFilePickerMatchRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function queryTokens(rawQuery: string): string[] {
  return normalizeSearchQuery(rawQuery, {
    trimLeadingPattern: /^[@./]+/,
  })
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function matchOf(path: string, tokens: ReadonlyArray<string>): ProjectFilePickerMatch {
  const name = fileName(path);
  return {
    name,
    nameMatchRanges: findMatchRanges(name, tokens),
    path,
    pathMatchRanges: findMatchRanges(path, tokens),
  };
}

/** Preserve server ranking and query normalization while filtering files and computing highlights. */
export function getProjectFilePickerMatches(
  entries: ReadonlyArray<ProjectEntry>,
  rawQuery: string,
  limit = PROJECT_FILE_PICKER_RESULT_LIMIT,
): ReadonlyArray<ProjectFilePickerMatch> {
  return getProjectFilePickerSections(entries, rawQuery, "files", limit).files;
}

export interface ProjectFilePickerSections {
  readonly files: ReadonlyArray<ProjectFilePickerMatch>;
  readonly folders: ReadonlyArray<ProjectFilePickerMatch>;
}

/**
 * Splits one ranked path search into the tab's file and folder sections, each in server order.
 * A category tab also checks extensions here, since an older server ignores the category.
 */
export function getProjectFilePickerSections(
  entries: ReadonlyArray<ProjectEntry>,
  rawQuery: string,
  tab: ProjectFilePickerTab,
  limit = PROJECT_FILE_PICKER_RESULT_LIMIT,
): ProjectFilePickerSections {
  const filter = projectFilePickerPathFilter(tab);
  if (filter === null) return { files: [], folders: [] };
  const sectionLimit = (kind: ProjectEntryKind, allTabLimit: number) =>
    filter.kind === undefined ? Math.min(limit, allTabLimit) : filter.kind === kind ? limit : 0;
  const fileLimit = sectionLimit("file", ALL_TAB_FILE_LIMIT);
  const folderLimit = sectionLimit("directory", ALL_TAB_FOLDER_LIMIT);
  const tokens = queryTokens(rawQuery);
  const files: ProjectFilePickerMatch[] = [];
  const folders: ProjectFilePickerMatch[] = [];

  for (const entry of entries) {
    if (files.length >= fileLimit && folders.length >= folderLimit) break;
    if (entry.kind === "file") {
      if (files.length >= fileLimit) continue;
      if (filter.category !== undefined && fileCategoryOf(entry.path) !== filter.category) continue;
      files.push(matchOf(entry.path, tokens));
    } else if (folders.length < folderLimit) {
      folders.push(matchOf(entry.path, tokens));
    }
  }

  return { files, folders };
}

/** "All" keeps the thread search's order and cuts its sections to a shared row budget. */
export function capProjectFilePickerThreadGroups(
  groups: ReadonlyArray<CommandPaletteGroup>,
  tab: ProjectFilePickerTab,
): CommandPaletteGroup[] {
  if (tab !== "all") return [...groups];
  let remaining = ALL_TAB_THREAD_LIMIT;
  return groups.flatMap((group) => {
    const items = group.items.slice(0, remaining);
    remaining -= items.length;
    return items.length > 0 ? [{ ...group, items }] : [];
  });
}

function projectEmptyState(tab: ProjectFilePickerTab, isSearching: boolean, isPending: boolean) {
  switch (tab) {
    case "threads":
      if (isPending) return "Searching threads…";
      return isSearching ? "No matching threads." : "No recent threads.";
    case "folders":
      if (isPending) return isSearching ? "Searching workspace folders…" : "Indexing workspace…";
      return isSearching ? "No matching folders." : "No folders found.";
    case "all":
      if (isPending) return isSearching ? "Searching…" : "Indexing workspace files…";
      return isSearching ? "No matching files, folders, or threads." : "No files found.";
    default:
      if (isPending)
        return isSearching ? "Searching workspace files…" : "Indexing workspace files…";
      return isSearching ? "No matching files." : "No files found.";
  }
}

/** What the picker says when it has no rows. `hostName` is "this computer" or the environment's name. */
export function projectFilePickerEmptyState(input: {
  readonly scope: ProjectFilePickerScope;
  readonly tab: ProjectFilePickerTab;
  readonly query: string;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly truncated: boolean;
  readonly queryTooShort: boolean;
  readonly hostName: string;
}): string {
  if (input.error) return input.error;
  const query = input.query.trim();
  if (input.scope === "project" || input.tab === "threads") {
    return projectEmptyState(input.tab, query.length > 0, input.isPending);
  }
  if (input.queryTooShort) return `Type at least 2 characters to search ${input.hostName}.`;
  if (input.isPending) return `Searching ${input.hostName}…`;
  // The host's index answered nothing before its deadline.
  if (input.truncated) return "Still indexing or slow. Try a longer name.";
  return `No matches on ${input.hostName}. Only indexed locations are searched.`;
}
