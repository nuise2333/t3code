import type { AssetImageDimensions } from "@t3tools/contracts";

const MB = 1024 * 1024;

export const THUMBNAIL_LIMITS = {
  concurrency: 4,
  timeoutMs: 10_000,
  localBytes: 20 * MB,
  remoteBytes: 3 * MB,
  /** Formats the server reads no header size for could be decompression bombs. */
  undimensionedBytes: 2 * MB,
  remoteTabBudget: 64 * MB,
  maxPixels: 32_000_000,
  maxSide: 16_384,
  cacheEntries: 400,
  cacheBytes: 24 * MB,
  /** The tile's 64x48 preview box at up to 2x density. */
  box: { width: 128, height: 96 },
} as const;

export type ThumbnailKind = "bitmap" | "svg";

const BITMAP_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "webp"]);

/** HEIC and TIFF need the full-size decoders, and video seeks per tile, so both stay icons. */
export function thumbnailKind(path: string): ThumbnailKind | null {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "svg") return "svg";
  return path.includes(".") && BITMAP_EXTENSIONS.has(extension) ? "bitmap" : null;
}

/** The most bytes worth fetching for a tile; null means the image is too large to decode. */
export function thumbnailByteCap(input: {
  readonly remote: boolean;
  readonly dimensions: AssetImageDimensions | undefined;
}): number | null {
  const { dimensions } = input;
  const base = input.remote ? THUMBNAIL_LIMITS.remoteBytes : THUMBNAIL_LIMITS.localBytes;
  if (dimensions === undefined) return Math.min(base, THUMBNAIL_LIMITS.undimensionedBytes);
  const oversized =
    dimensions.width > THUMBNAIL_LIMITS.maxSide ||
    dimensions.height > THUMBNAIL_LIMITS.maxSide ||
    dimensions.width * dimensions.height > THUMBNAIL_LIMITS.maxPixels;
  return oversized ? null : base;
}

/** Fits an image inside the box without enlarging it. */
export function fitThumbnail(
  width: number,
  height: number,
  box: { readonly width: number; readonly height: number } = THUMBNAIL_LIMITS.box,
): { width: number; height: number } {
  const scale = Math.min(1, box.width / width, box.height / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export const thumbnailPathKey = (environmentId: string, absolutePath: string) =>
  `${environmentId}\0${absolutePath}`;

const abortError = () => new DOMException("The thumbnail was cancelled.", "AbortError");

/** One FIFO for mint, fetch and decode together; an aborted job leaves the queue, or rejects at once but holds its slot until its task settles. */
export class ThumbnailQueue {
  readonly #limit: number;
  #running = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  get running(): number {
    return this.#running;
  }

  get queued(): number {
    return this.#waiting.length;
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.#running--;
        this.#waiting.shift()?.();
      };
      const start = () => {
        this.#running++;
        signal.removeEventListener("abort", dequeue);
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
        task(signal).then(resolve, reject).finally(release);
      };
      const dequeue = () => {
        const index = this.#waiting.indexOf(start);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(abortError());
      };
      if (this.#running < this.#limit) {
        start();
        return;
      }
      signal.addEventListener("abort", dequeue, { once: true });
      this.#waiting.push(start);
    });
  }
}

interface CachedThumbnail {
  readonly url: string;
  readonly bytes: number;
}

/**
 * Keyed by path and file revision, so an unchanged file is a hit after a re-mint and a changed one
 * a miss. `null` remembers an image shown as an icon until its revision changes.
 */
export class ThumbnailCache {
  readonly #entries = new Map<string, CachedThumbnail | null>();
  readonly #latest = new Map<string, string>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #revoke: (url: string) => void;
  #bytes = 0;

  constructor(input: {
    readonly maxEntries: number;
    readonly maxBytes: number;
    readonly revoke: (url: string) => void;
  }) {
    this.#maxEntries = input.maxEntries;
    this.#maxBytes = input.maxBytes;
    this.#revoke = input.revoke;
  }

  static key(pathKey: string, revision: string): string {
    return `${pathKey}\0${revision}`;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** undefined is a miss; null is a known icon. */
  get(key: string): string | null | undefined {
    if (!this.#entries.has(key)) return undefined;
    const entry = this.#entries.get(key) ?? null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry?.url ?? null;
  }

  /** The newest thumbnail for a path, shown while a remount re-checks its revision. */
  latest(pathKey: string): string | null {
    const key = this.#latest.get(pathKey);
    return key === undefined ? null : (this.#entries.get(key)?.url ?? null);
  }

  set(pathKey: string, key: string, entry: CachedThumbnail | null): void {
    const previousKey = this.#latest.get(pathKey);
    if (previousKey !== undefined && previousKey !== key) this.#delete(previousKey);
    this.#delete(key);
    this.#entries.set(key, entry);
    this.#latest.set(pathKey, key);
    this.#bytes += entry?.bytes ?? 0;
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries && this.#bytes <= this.#maxBytes) break;
      if (oldest === key) continue;
      this.#delete(oldest);
    }
  }

  #delete(key: string): void {
    if (!this.#entries.has(key)) return;
    const entry = this.#entries.get(key) ?? null;
    this.#entries.delete(key);
    if (entry !== null) {
      this.#bytes -= entry.bytes;
      this.#revoke(entry.url);
    }
    const pathKey = key.slice(0, key.lastIndexOf("\0"));
    if (this.#latest.get(pathKey) === key) this.#latest.delete(pathKey);
  }
}

/** Bytes a Files tab may fetch for remote thumbnails before it asks to load more. */
export class ThumbnailBudget {
  readonly #listeners = new Set<() => void>();
  readonly #step: number;
  #limit: number;
  #spent = 0;
  #generation = 0;

  constructor(step: number) {
    this.#step = step;
    this.#limit = step;
  }

  get exhausted(): boolean {
    return this.#spent >= this.#limit;
  }

  consume(bytes: number): void {
    const wasExhausted = this.exhausted;
    this.#spent += bytes;
    if (!wasExhausted && this.exhausted) this.#changed();
  }

  /** "Load previews": another step from what is already spent. */
  extend(): void {
    this.#limit = this.#spent + this.#step;
    this.#changed();
  }

  /** Changes when the budget runs out or is extended. */
  readonly getSnapshot = (): number => this.#generation;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #changed(): void {
    this.#generation++;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * Reads at most `cap` bytes; `blob` is null when the image is larger, without reading a
 * declared-large body. `bytes` counts what was downloaded either way.
 */
export async function readCappedBlob(
  response: Response,
  cap: number,
): Promise<{ blob: Blob | null; bytes: number }> {
  if (!response.ok) throw new Error(`The image could not be loaded (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (declared > cap) {
    await response.body?.cancel();
    return { blob: null, bytes: 0 };
  }
  const reader = response.body?.getReader();
  if (!reader) return { blob: null, bytes: 0 };
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > cap) return { blob: null, bytes };
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return { blob: new Blob(chunks, { type: response.headers.get("content-type") ?? "" }), bytes };
}
