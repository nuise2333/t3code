import type { AssetImageDimensions, AssetResource, EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { assetEnvironment } from "~/state/assets";

import {
  THUMBNAIL_LIMITS,
  ThumbnailBudget,
  ThumbnailCache,
  ThumbnailQueue,
  readCappedBlob,
  thumbnailByteCap,
  thumbnailKind,
  thumbnailPathKey,
} from "./fileThumbnails.logic";
import { renderThumbnail } from "./thumbnailDecode";

const queue = new ThumbnailQueue(THUMBNAIL_LIMITS.concurrency);
const cache = new ThumbnailCache({
  maxEntries: THUMBNAIL_LIMITS.cacheEntries,
  maxBytes: THUMBNAIL_LIMITS.cacheBytes,
  revoke: (url) => URL.revokeObjectURL(url),
});
/** The workspace-change pass each path was last minted in; an older one re-mints on mount. */
const mintedEpochs = new Map<string, number>();
let latestEpoch = 0;

/** A new pass after workspace changes: visible tiles re-check their file revision. */
export function nextThumbnailEpoch(): number {
  return ++latestEpoch;
}

const budgets = new Map<string, ThumbnailBudget>();

/** Per Files tab, so reopening the panel in the same tab does not start a fresh allowance. */
export function thumbnailBudget(key: string): ThumbnailBudget {
  let budget = budgets.get(key);
  if (!budget) {
    budget = new ThumbnailBudget(THUMBNAIL_LIMITS.remoteTabBudget);
    budgets.set(key, budget);
  }
  return budget;
}

export function useThumbnailBudgetGeneration(budget: ThumbnailBudget | null): number {
  return useSyncExternalStore(
    budget?.subscribe ?? noSubscribe,
    budget?.getSnapshot ?? zeroSnapshot,
  );
}
const noSubscribe = () => () => {};
const zeroSnapshot = () => 0;

type WorkerReply = { id: number; blob?: Blob; error?: string; unsupported?: true };
let worker: Worker | null | undefined;
let nextRequestId = 0;
const workerRequests = new Map<number, (reply: WorkerReply) => void>();

function thumbnailWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const created = new Worker(new URL("./thumbnail.worker.ts", import.meta.url), {
      type: "module",
    });
    created.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      workerRequests.get(event.data.id)?.(event.data);
      workerRequests.delete(event.data.id);
    });
    created.addEventListener("error", () => {
      for (const reply of workerRequests.values()) reply({ id: -1, unsupported: true });
      workerRequests.clear();
      created.terminate();
      worker = null;
    });
    worker = created;
  } catch {
    worker = null;
  }
  return worker;
}

const documentThumbnailCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  return context
    ? {
        context,
        encode: () =>
          new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.8)),
      }
    : null;
};

async function decodeThumbnail(
  blob: Blob,
  dimensions: AssetImageDimensions | undefined,
): Promise<Blob> {
  const shared = thumbnailWorker();
  if (shared) {
    const id = nextRequestId++;
    const reply = await new Promise<WorkerReply>((resolve) => {
      workerRequests.set(id, resolve);
      shared.postMessage({ id, blob, dimensions }, { transfer: [] });
    });
    if (reply.blob) return reply.blob;
    if (!reply.unsupported) throw new Error(reply.error ?? "Could not decode this image.");
  }
  // Workers without OffscreenCanvas, such as older Safari, decode on the main thread instead.
  return renderThumbnail(blob, dimensions, documentThumbnailCanvas);
}

export type ThumbnailResult =
  | { readonly _tag: "ready"; readonly url: string }
  | { readonly _tag: "icon" }
  /** The remote budget ran out; the tile waits for "Load previews". */
  | { readonly _tag: "deferred" };

interface ThumbnailRequest {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly resource: AssetResource;
  readonly remote: boolean;
  readonly budget: ThumbnailBudget | null;
  readonly epoch: number;
}

const ICON: ThumbnailResult = { _tag: "icon" };

function requestThumbnail(request: ThumbnailRequest, signal: AbortSignal) {
  const kind = thumbnailKind(request.absolutePath);
  if (kind === null) return Promise.resolve(ICON);
  const pathKey = thumbnailPathKey(request.environmentId, request.absolutePath);
  return queue.run(async (queueSignal) => {
    const job = new AbortController();
    const abortJob = () => job.abort();
    queueSignal.addEventListener("abort", abortJob, { once: true });
    const timer = setTimeout(abortJob, THUMBNAIL_LIMITS.timeoutMs);
    try {
      return await renderRequestedThumbnail(request, kind, pathKey, job.signal);
    } finally {
      clearTimeout(timer);
      queueSignal.removeEventListener("abort", abortJob);
    }
  }, signal);
}

async function renderRequestedThumbnail(
  request: ThumbnailRequest,
  kind: NonNullable<ReturnType<typeof thumbnailKind>>,
  pathKey: string,
  jobSignal: AbortSignal,
): Promise<ThumbnailResult> {
  const minted = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId: request.environmentId,
      input: { resource: request.resource },
    }),
    {
      refresh: (mintedEpochs.get(pathKey) ?? 0) < request.epoch,
      reportFailure: false,
      reportDefect: false,
    },
  );
  if (minted._tag !== "Success") return ICON;
  mintedEpochs.set(pathKey, request.epoch);
  const asset = minted.value;
  const key = ThumbnailCache.key(pathKey, asset.fileRevision ?? asset.relativeUrl);
  const cached = cache.get(key);
  if (cached !== undefined) return cached === null ? ICON : { _tag: "ready", url: cached };
  const cap = thumbnailByteCap({ remote: request.remote, dimensions: asset.imageDimensions });
  if (cap === null) {
    cache.set(pathKey, key, null);
    return ICON;
  }
  if (request.remote && request.budget?.exhausted) return { _tag: "deferred" };
  jobSignal.throwIfAborted();
  const response = await fetch(new URL(asset.relativeUrl, window.location.href), {
    signal: jobSignal,
  });
  const read = await readCappedBlob(response, cap);
  if (request.remote) request.budget?.consume(read.bytes);
  if (read.blob === null) {
    cache.set(pathKey, key, null);
    return ICON;
  }
  // Once downloaded, the thumbnail is cached even if its tile scrolled away meanwhile.
  const thumbnail =
    kind === "svg"
      ? new Blob([read.blob], { type: "image/svg+xml" })
      : await decodeThumbnail(read.blob, asset.imageDimensions);
  const url = URL.createObjectURL(thumbnail);
  cache.set(pathKey, key, { url, bytes: thumbnail.size });
  return { _tag: "ready", url };
}

/**
 * A tile's thumbnail object URL, or null for its icon. Work starts when the tile mounts while
 * visible and is cancelled when it unmounts or the panel hides.
 */
export function useFileThumbnail(input: {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
  readonly resource: AssetResource | null;
  readonly enabled: boolean;
  readonly remote: boolean;
  readonly budget: ThumbnailBudget | null;
  readonly epoch: number;
}): string | null {
  const { environmentId, absolutePath, resource, enabled, remote, budget, epoch } = input;
  const pathKey = thumbnailPathKey(environmentId, absolutePath);
  const budgetGeneration = useThumbnailBudgetGeneration(budget);
  const [result, setResult] = useState<{ key: string; url: string | null } | null>(null);
  const eligible = enabled && resource !== null && thumbnailKind(absolutePath) !== null;
  const start = useEffectEvent((signal: AbortSignal) =>
    resource === null
      ? Promise.resolve(ICON)
      : requestThumbnail({ environmentId, absolutePath, resource, remote, budget, epoch }, signal),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches and decodes the image off the network, cancelled when the tile unmounts or the panel hides
  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    start(controller.signal).then(
      (thumbnail) => {
        if (controller.signal.aborted) return;
        setResult({ key: pathKey, url: thumbnail._tag === "ready" ? thumbnail.url : null });
      },
      () => {
        if (!controller.signal.aborted) setResult({ key: pathKey, url: null });
      },
    );
    return () => controller.abort();
  }, [
    eligible,
    pathKey,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The request reads these through the effect event; a new pass, budget or connection starts it again.
    budget,
    budgetGeneration,
    epoch,
    remote,
  ]);
  if (!eligible) return null;
  return result?.key === pathKey ? result.url : cache.latest(pathKey);
}
