import { useSyncExternalStore } from "react";

import type { FileIconTheme } from "./fileIconThemeImport";

export type FileIconThemeSummary = Pick<FileIconTheme, "id" | "label" | "collectionId" | "version">;

const INSTALLED_STORAGE_KEY = "t3code:file-icon-themes:v1";
const ACTIVE_STORAGE_KEY = "t3code:file-icon-theme:v1";
const DATABASE_NAME = "t3code:file-icon-themes";
const STORE_NAME = "themes";
const SPRITE_CONTAINER_ID = "t3code-file-icon-theme-sprite";
const EMPTY: ReadonlyArray<FileIconThemeSummary> = [];

let database: Promise<IDBDatabase> | undefined;
let installed: ReadonlyArray<FileIconThemeSummary> | null = null;
let active: FileIconTheme | null = null;
let loadedActiveId: string | null = null;
let loadGeneration = 0;
let listening = false;
const listeners = new Set<() => void>();

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("Icon theme storage is blocked.")));
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
): Promise<A | undefined> {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request?.result;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}

function readInstalled(): ReadonlyArray<FileIconThemeSummary> {
  try {
    const value: unknown = JSON.parse(readStorage(INSTALLED_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return EMPTY;
    return value.filter(
      (entry): entry is FileIconThemeSummary =>
        typeof entry?.id === "string" &&
        typeof entry.label === "string" &&
        typeof entry.collectionId === "string" &&
        typeof entry.version === "string",
    );
  } catch {
    return EMPTY;
  }
}

function emit() {
  for (const listener of listeners) listener();
}

function renderSprite(theme: FileIconTheme | null) {
  if (typeof document === "undefined" || !document.body) return;
  let container = document.getElementById(SPRITE_CONTAINER_ID);
  if (!theme) {
    container?.remove();
    return;
  }
  if (container?.dataset.themeId === theme.id) return;
  if (!container) {
    container = document.createElement("div");
    container.id = SPRITE_CONTAINER_ID;
    container.setAttribute("aria-hidden", "true");
    container.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    document.body.prepend(container);
  }
  container.dataset.themeId = theme.id;
  container.innerHTML = theme.sprite;
}

function activeThemeId(): string | null {
  const id = readStorage(ACTIVE_STORAGE_KEY);
  return id && getInstalledFileIconThemes().some((theme) => theme.id === id) ? id : null;
}

function syncActiveTheme() {
  const id = activeThemeId();
  if (id === loadedActiveId) return;
  loadedActiveId = id;
  const generation = ++loadGeneration;
  if (id === null) {
    active = null;
    renderSprite(null);
    emit();
    return;
  }
  void withStore<FileIconTheme>("readonly", (store) => store.get(id)).then(
    (theme) => {
      if (generation !== loadGeneration) return;
      active = theme ?? null;
      renderSprite(active);
      emit();
    },
    () => {
      if (generation !== loadGeneration) return;
      active = null;
      emit();
    },
  );
}

function handleStorage(event: StorageEvent) {
  if (event.key === INSTALLED_STORAGE_KEY || event.key === null) installed = null;
  if (
    event.key === INSTALLED_STORAGE_KEY ||
    event.key === ACTIVE_STORAGE_KEY ||
    event.key === null
  ) {
    syncActiveTheme();
    emit();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("storage", handleStorage);
    syncActiveTheme();
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getInstalledFileIconThemes(): ReadonlyArray<FileIconThemeSummary> {
  return (installed ??= typeof window === "undefined" ? EMPTY : readInstalled());
}

function getActiveFileIconTheme(): FileIconTheme | null {
  return active;
}

export function useFileIconTheme(): FileIconTheme | null {
  return useSyncExternalStore(subscribe, getActiveFileIconTheme, () => null);
}

export function useInstalledFileIconThemes(): ReadonlyArray<FileIconThemeSummary> {
  return useSyncExternalStore(subscribe, getInstalledFileIconThemes, () => EMPTY);
}

export function useActiveFileIconThemeId(): string | null {
  return useSyncExternalStore(subscribe, activeThemeId, () => null);
}

export function setActiveFileIconTheme(id: string | null) {
  writeStorage(ACTIVE_STORAGE_KEY, id);
  syncActiveTheme();
  emit();
}

/** Replaces every installed variant of one extension, keeping the selection when its variant survives. */
export async function replaceFileIconThemeCollection(
  collectionId: string,
  themes: ReadonlyArray<FileIconTheme>,
): Promise<ReadonlyArray<FileIconThemeSummary>> {
  const previous = getInstalledFileIconThemes().filter(
    (theme) => theme.collectionId === collectionId,
  );
  await withStore("readwrite", (store) => {
    for (const theme of previous) store.delete(theme.id);
    for (const theme of themes) store.put(theme);
  });
  const summaries = themes.map(({ id, label, version }) => ({ id, label, collectionId, version }));
  writeStorage(
    INSTALLED_STORAGE_KEY,
    JSON.stringify([
      ...getInstalledFileIconThemes().filter((theme) => theme.collectionId !== collectionId),
      ...summaries,
    ]),
  );
  installed = null;
  // A reinstall keeps the same id, so force the selected variant to reload.
  loadedActiveId = null;
  syncActiveTheme();
  emit();
  return summaries;
}

export async function removeFileIconThemeCollection(collectionId: string) {
  await replaceFileIconThemeCollection(collectionId, []);
}
