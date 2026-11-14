import type { ProjectEntry } from "@t3tools/contracts";
import { isWindowsAbsolutePath, isHostPath } from "@t3tools/shared/path";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
}

export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const hostPath = isHostPath(relativePath);
  const windowsPath = isWindowsAbsolutePath(relativePath);
  const separator = windowsPath ? "\\" : "/";
  // `\` is a legal filename character outside Windows paths.
  const parts = relativePath.split(windowsPath ? /[\\/]/ : "/").filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : relativePath.startsWith("/") ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => {
      const path = root + parts.slice(0, index + 1).join(separator);
      return {
        label: part,
        // A bare drive (`C:`) means the drive's current directory; its root is `C:\`.
        // A bare `~` is not a host path; the home folder is `~/`.
        path: /^[A-Za-z]:$/.test(path) ? `${path}\\` : hostPath && path === "~" ? "~/" : path,
        kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

/** Use the crumb's path spelling so trailing or repeated separators still match. */
export function breadcrumbPathOf(relativePath: string): string {
  return fileBreadcrumbs("", relativePath).at(-1)?.path ?? relativePath;
}

/** UNC servers are not listable directories; their shares are. */
export function isListableHostFolder(path: string): boolean {
  return isHostPath(path) && !/^\\\\[^\\/]+$/.test(path);
}

function trailCrumbIndex(trail: string, path: string): number {
  const crumbPath = breadcrumbPathOf(path);
  return fileBreadcrumbs("", trail).findIndex((crumb) => crumb.path === crumbPath);
}

/** Retain descendant crumbs when navigating up; other navigation resets the trail to path. */
export function retainedBreadcrumbTrail(trail: string | undefined, path: string): string {
  return trail !== undefined && trailCrumbIndex(trail, path) >= 0 ? trail : path;
}

export function trailChildOf(folder: string, trail: string): string | null {
  const index = trailCrumbIndex(trail, folder);
  return index < 0 ? null : (fileBreadcrumbs("", trail)[index + 1]?.label ?? null);
}

/** The listable folder that contains a host path, or null at a filesystem root. */
export function hostParentOf(path: string): string | null {
  const crumbs = fileBreadcrumbs("", path);
  return crumbs.at(-2)?.path ?? (crumbs.length === 1 && path.startsWith("/") ? "/" : null);
}

/** The folder above a Files tab folder: "" is the workspace root, null means none is listable. */
export function folderParentOf(path: string): string | null {
  if (isHostPath(path)) return hostParentOf(path);
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export type FolderReadOutcome = "pending" | "folder" | "missing" | "file" | "unreadable";

export function folderReadOutcome(read: {
  readonly data: unknown;
  readonly error: string | null;
  readonly isNotFile: boolean;
  readonly isMissing: boolean;
}): FolderReadOutcome {
  if (read.isNotFile) return "folder";
  if (read.isMissing) return "missing";
  if (read.data !== null) return "file";
  return read.error === null ? "pending" : "unreadable";
}

export type MissingFolderProbeStep =
  | { readonly kind: "target"; readonly path: string }
  | { readonly kind: "walk"; readonly next: string | null }
  | { readonly kind: "wait" }
  | { readonly kind: "stop" };

/** Walks up only past ancestors that are gone; an unreadable one is not evidence of deletion. */
export function missingFolderProbeStep(
  candidate: string | null,
  outcome: FolderReadOutcome,
): MissingFolderProbeStep {
  if (candidate === "") return { kind: "target", path: "" };
  if (candidate === null) return { kind: "stop" };
  switch (outcome) {
    case "folder":
      return { kind: "target", path: candidate };
    case "missing":
    case "file":
      return { kind: "walk", next: folderParentOf(candidate) };
    case "pending":
      return { kind: "wait" };
    case "unreadable":
      return { kind: "stop" };
  }
}

export function joinHostPath(folder: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(folder) ? "\\" : "/";
  const base = folder.endsWith(separator) ? folder : `${folder}${separator}`;
  return base + relativePath.split("/").join(separator);
}

export function fileBreadcrumbChildren(
  entries: readonly ProjectEntry[],
  directoryPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const label = entry.path.slice(prefix.length);
      if (!label || label.includes("/")) return [];
      return [{ ...entry, label }];
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      collator ??= new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return collator.compare(left.label, right.label);
    });
}

export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath) return null;
  const separatorIndex = directoryPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}
