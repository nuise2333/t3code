import type { AssetImageDimensions } from "@t3tools/contracts";

import { offscreenThumbnailCanvas, renderThumbnail } from "./thumbnailDecode";

interface ThumbnailWorkerRequest {
  readonly id: number;
  readonly blob: Blob;
  readonly dimensions: AssetImageDimensions | undefined;
}

self.addEventListener("message", (event: MessageEvent<ThumbnailWorkerRequest>) => {
  const { id, blob, dimensions } = event.data;
  if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") {
    self.postMessage({ id, unsupported: true }, { transfer: [] });
    return;
  }
  void renderThumbnail(blob, dimensions, offscreenThumbnailCanvas).then(
    (thumbnail) => self.postMessage({ id, blob: thumbnail }, { transfer: [] }),
    (cause: unknown) =>
      self.postMessage(
        { id, error: cause instanceof Error ? cause.message : "Could not decode this image." },
        { transfer: [] },
      ),
  );
});
