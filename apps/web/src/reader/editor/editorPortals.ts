import type { ReactNode } from "react";

export interface EditorPortal {
  readonly key: number;
  readonly container: HTMLElement;
  readonly element: ReactNode;
}

/**
 * React content node views render outside ProseMirror's DOM ownership: each view registers a
 * container it owns and what to render into it; the editor component portals them in, so they
 * share its React context.
 */
export class EditorPortals {
  private readonly items = new Map<number, EditorPortal>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyArray<EditorPortal> = [];
  private nextKey = 0;

  key() {
    this.nextKey += 1;
    return this.nextKey;
  }

  set(key: number, container: HTMLElement, element: ReactNode) {
    this.items.set(key, { key, container, element });
    this.changed();
  }

  remove(key: number) {
    if (this.items.delete(key)) this.changed();
  }

  private changed() {
    this.snapshot = [...this.items.values()];
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;
}
