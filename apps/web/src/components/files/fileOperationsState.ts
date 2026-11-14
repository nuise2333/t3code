import type { EnvironmentId } from "@t3tools/contracts";

import type { FileClipboard } from "./fileOperations.logic";

let clipboard: FileClipboard | null = null;

/** One in-app clipboard per window; the OS pasteboard is on the wrong machine for a remote server. */
export function setFileClipboard(next: FileClipboard | null): void {
  clipboard = next;
}

export function readFileClipboard(): FileClipboard | null {
  return clipboard;
}

export interface FileTreeChange {
  readonly environmentId: EnvironmentId;
  /** Absolute folders whose listing changed. */
  readonly directories: readonly string[];
  /** Absolute paths that no longer exist where they were. */
  readonly removed: readonly string[];
}

const changeListeners = new Set<(change: FileTreeChange) => void>();

/** Nothing pushes listings to clients, so every Files panel in this window hears this window's changes. */
export function publishFileTreeChange(change: FileTreeChange): void {
  for (const listener of changeListeners) listener(change);
}

export function subscribeFileTreeChanges(listener: (change: FileTreeChange) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
