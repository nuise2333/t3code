import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { useLocalStorage, writeLocalStorageValue } from "~/hooks/useLocalStorage";

/** Whether the outline column shows beside a reader wide enough for it. */
const READER_OUTLINE_STORAGE_KEY = "t3code.readerOutlineOpen";
const OUTLINE_OPEN_DEFAULT = true;

interface OutlineSurface {
  readonly hasHeadings: boolean;
  /** Too narrow for a column: the outline floats over the page while open. */
  readonly isNarrow: boolean;
  readonly isOverlayOpen: boolean;
}

const surfaces = new Map<string, OutlineSurface>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateReaderOutlineSurface(key: string, patch: Partial<OutlineSurface> | null) {
  const current = surfaces.get(key);
  if (patch === null) {
    if (!surfaces.delete(key)) return;
  } else {
    const next = {
      hasHeadings: false,
      isNarrow: false,
      isOverlayOpen: false,
      ...current,
      ...patch,
    };
    if (
      current?.hasHeadings === next.hasHeadings &&
      current.isNarrow === next.isNarrow &&
      current.isOverlayOpen === next.isOverlayOpen
    ) {
      return;
    }
    surfaces.set(key, next);
  }
  for (const listener of listeners) listener();
}

/** The key a workspace file's reader registers under, for its toolbar to reach it. */
export function readerFileSurfaceKey(cwd: string, relativePath: string) {
  return `file:${cwd}\u0000${relativePath}`;
}

/** The key an attachment's reader registers under; none for a file that only lives in memory. */
export function readerAttachmentSurfaceKey(
  asset:
    | { readonly environmentId: string; readonly attachmentId: string }
    | { readonly environmentId: string; readonly resource: object }
    | undefined,
) {
  if (asset === undefined) return undefined;
  const id = "attachmentId" in asset ? asset.attachmentId : JSON.stringify(asset.resource);
  return `attachment:${asset.environmentId}\u0000${id}`;
}

function toggleReaderOutline(key: string): boolean {
  const surface = surfaces.get(key);
  if (!surface?.hasHeadings) return false;
  if (surface.isNarrow) {
    updateReaderOutlineSurface(key, { isOverlayOpen: !surface.isOverlayOpen });
  } else {
    writeLocalStorageValue(
      READER_OUTLINE_STORAGE_KEY,
      (open) => !open,
      OUTLINE_OPEN_DEFAULT,
      Schema.Boolean,
    );
  }
  return true;
}

/**
 * Toggles the outline of the reader holding focus, else of the reader shown most recently;
 * false when no reader with headings is shown, so a shortcut can let its key through.
 */
export function toggleActiveReaderOutline(): boolean {
  const focused = document.activeElement?.closest<HTMLElement>("[data-reader-surface]");
  const key =
    focused?.dataset.readerSurface ??
    [...surfaces].findLast(([, surface]) => surface.hasHeadings)?.[0];
  return key === undefined ? false : toggleReaderOutline(key);
}

export function useReaderOutlineOpenPreference() {
  return useLocalStorage(READER_OUTLINE_STORAGE_KEY, OUTLINE_OPEN_DEFAULT, Schema.Boolean);
}

export function useReaderOutlineSurface(key: string): OutlineSurface | undefined {
  return useSyncExternalStore(
    subscribe,
    () => surfaces.get(key),
    () => undefined,
  );
}

/** What a toolbar button needs: whether the reader has an outline, and whether it shows. */
export function useReaderOutlineToggle(key: string) {
  const surface = useReaderOutlineSurface(key);
  const [preferOpen] = useReaderOutlineOpenPreference();
  return {
    isAvailable: surface?.hasHeadings === true,
    isOpen: surface?.isNarrow ? surface.isOverlayOpen : preferOpen,
    toggle: () => toggleReaderOutline(key),
  };
}
