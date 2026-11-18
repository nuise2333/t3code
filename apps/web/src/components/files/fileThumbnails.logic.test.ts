import { describe, expect, it, vi } from "vite-plus/test";

import {
  THUMBNAIL_LIMITS,
  ThumbnailBudget,
  ThumbnailCache,
  ThumbnailQueue,
  fitThumbnail,
  readCappedBlob,
  thumbnailByteCap,
  thumbnailKind,
} from "./fileThumbnails.logic";

const MB = 1024 * 1024;

function deferredTask() {
  let resolve: (value: string) => void = () => {};
  const promise = new Promise<string>((settle) => {
    resolve = settle;
  });
  const task = vi.fn((_signal: AbortSignal) => promise);
  return { task, resolve };
}

describe("ThumbnailQueue", () => {
  it("never runs more than its limit, and starts the next job as one finishes", async () => {
    const queue = new ThumbnailQueue(4);
    const jobs = Array.from({ length: 6 }, deferredTask);
    const results = jobs.map((job) => queue.run(job.task, new AbortController().signal));
    expect(queue.running).toBe(4);
    expect(jobs[4]!.task).not.toHaveBeenCalled();
    jobs[0]!.resolve("first");
    await expect(results[0]).resolves.toBe("first");
    expect(queue.running).toBe(4);
    expect(jobs[4]!.task).toHaveBeenCalledOnce();
    expect(jobs[5]!.task).not.toHaveBeenCalled();
  });

  it("drops an aborted queued job without running it", async () => {
    const queue = new ThumbnailQueue(1);
    const running = deferredTask();
    const queued = deferredTask();
    void queue.run(running.task, new AbortController().signal);
    const controller = new AbortController();
    const result = queue.run(queued.task, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(queue.queued).toBe(0);
    running.resolve("done");
    await Promise.resolve();
    expect(queued.task).not.toHaveBeenCalled();
  });

  it("rejects an aborted running job at once but holds its slot until the task settles", async () => {
    const queue = new ThumbnailQueue(1);
    const controller = new AbortController();
    const running = deferredTask();
    const next = deferredTask();
    const result = queue.run(running.task, controller.signal);
    void queue.run(next.task, new AbortController().signal);
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(running.task.mock.calls[0]![0].aborted).toBe(true);
    expect(next.task).not.toHaveBeenCalled();
    running.resolve("late");
    await vi.waitFor(() => expect(next.task).toHaveBeenCalledOnce());
    expect(queue.running).toBe(1);
  });
});

describe("ThumbnailCache", () => {
  const pathKey = "env\0/repo/a.png";

  it("hits for the same revision and misses for a new one, revoking the old URL", () => {
    const revoke = vi.fn();
    const cache = new ThumbnailCache({ maxEntries: 10, maxBytes: MB, revoke });
    const first = ThumbnailCache.key(pathKey, "rev-1");
    cache.set(pathKey, first, { url: "blob:1", bytes: 10 });
    expect(cache.get(first)).toBe("blob:1");
    const second = ThumbnailCache.key(pathKey, "rev-2");
    expect(cache.get(second)).toBeUndefined();
    expect(cache.latest(pathKey)).toBe("blob:1");
    cache.set(pathKey, second, { url: "blob:2", bytes: 10 });
    expect(revoke).toHaveBeenCalledWith("blob:1");
    expect(cache.get(first)).toBeUndefined();
    expect(cache.latest(pathKey)).toBe("blob:2");
  });

  it("remembers an icon as null until the revision changes", () => {
    const cache = new ThumbnailCache({ maxEntries: 10, maxBytes: MB, revoke: () => {} });
    const key = ThumbnailCache.key(pathKey, "rev-1");
    cache.set(pathKey, key, null);
    expect(cache.get(key)).toBeNull();
    expect(cache.latest(pathKey)).toBeNull();
  });

  it("evicts the least recently used entry by count and by bytes, revoking it", () => {
    const revoke = vi.fn();
    const cache = new ThumbnailCache({ maxEntries: 2, maxBytes: 100, revoke });
    const keyOf = (name: string) => ThumbnailCache.key(`env\0${name}`, "r");
    cache.set("env\0a", keyOf("a"), { url: "blob:a", bytes: 10 });
    cache.set("env\0b", keyOf("b"), { url: "blob:b", bytes: 10 });
    cache.get(keyOf("a"));
    cache.set("env\0c", keyOf("c"), { url: "blob:c", bytes: 10 });
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:b");
    cache.set("env\0d", keyOf("d"), { url: "blob:d", bytes: 95 });
    expect(revoke).toHaveBeenCalledWith("blob:a");
    expect(revoke).toHaveBeenCalledWith("blob:c");
    expect(cache.get(keyOf("d"))).toBe("blob:d");
    expect(cache.size).toBe(1);
  });
});

describe("thumbnail limits", () => {
  it.each([
    { remote: false, dimensions: { width: 4000, height: 3000 }, cap: THUMBNAIL_LIMITS.localBytes },
    { remote: true, dimensions: { width: 4000, height: 3000 }, cap: THUMBNAIL_LIMITS.remoteBytes },
    { remote: false, dimensions: undefined, cap: THUMBNAIL_LIMITS.undimensionedBytes },
    { remote: true, dimensions: undefined, cap: THUMBNAIL_LIMITS.undimensionedBytes },
    { remote: false, dimensions: { width: 8000, height: 8000 }, cap: null },
    { remote: false, dimensions: { width: 20_000, height: 10 }, cap: null },
  ])("caps $remote remote $dimensions at $cap", ({ remote, dimensions, cap }) => {
    expect(thumbnailByteCap({ remote, dimensions })).toBe(cap);
  });

  it.each([
    ["photo.JPG", "bitmap"],
    ["anim.gif", "bitmap"],
    ["icon.svg", "svg"],
    ["scan.heic", null],
    ["scan.tiff", null],
    ["clip.mp4", null],
    ["png", null],
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(thumbnailKind(path)).toBe(kind);
  });

  it("fits inside the box without enlarging", () => {
    expect(fitThumbnail(4000, 1000)).toEqual({ width: 128, height: 32 });
    expect(fitThumbnail(30, 20)).toEqual({ width: 30, height: 20 });
  });
});

describe("readCappedBlob", () => {
  it("gives up on a declared-oversize body without reading it", async () => {
    const body = new ReadableStream<Uint8Array>({ pull: vi.fn() });
    const getReader = vi.spyOn(body, "getReader");
    const response = new Response(body, { headers: { "content-length": String(5 * MB) } });
    await expect(readCappedBlob(response, MB)).resolves.toEqual({ blob: null, bytes: 0 });
    expect(getReader).not.toHaveBeenCalled();
  });

  it("stops once an undeclared body passes the cap and reports what it downloaded", async () => {
    const response = new Response(new Uint8Array(2048));
    expect(response.headers.get("content-length")).toBeNull();
    await expect(readCappedBlob(response, 1024)).resolves.toEqual({ blob: null, bytes: 2048 });
  });

  it("returns the bytes it read", async () => {
    const read = await readCappedBlob(new Response(new Uint8Array(16)), 1024);
    expect(read?.bytes).toBe(16);
  });
});

describe("ThumbnailBudget", () => {
  it("runs out after its step and resumes from what was spent when extended", () => {
    const budget = new ThumbnailBudget(100);
    const listener = vi.fn();
    budget.subscribe(listener);
    budget.consume(60);
    expect(budget.exhausted).toBe(false);
    budget.consume(60);
    expect(budget.exhausted).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    const generation = budget.getSnapshot();
    budget.extend();
    expect(budget.exhausted).toBe(false);
    expect(budget.getSnapshot()).not.toBe(generation);
    budget.consume(100);
    expect(budget.exhausted).toBe(true);
  });
});
