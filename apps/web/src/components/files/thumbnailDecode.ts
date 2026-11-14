import type { AssetImageDimensions } from "@t3tools/contracts";

import { fitThumbnail } from "./fileThumbnails.logic";

interface ThumbnailCanvas {
  readonly context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  encode(): Promise<Blob | null>;
}

export type CreateThumbnailCanvas = (width: number, height: number) => ThumbnailCanvas | null;

export const offscreenThumbnailCanvas: CreateThumbnailCanvas = (width, height) => {
  if (typeof OffscreenCanvas !== "function") return null;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  return context
    ? { context, encode: () => canvas.convertToBlob({ type: "image/webp", quality: 0.8 }) }
    : null;
};

/**
 * Decodes the first frame and draws it scaled. Safari ignores or rejects the resize options, so
 * the scaled draw is what bounds the output either way.
 */
export async function renderThumbnail(
  blob: Blob,
  dimensions: AssetImageDimensions | undefined,
  createCanvas: CreateThumbnailCanvas,
): Promise<Blob> {
  if (typeof createImageBitmap !== "function") throw new Error("Image decoding is unavailable.");
  const target = dimensions ? fitThumbnail(dimensions.width, dimensions.height) : null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      blob,
      target
        ? { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "medium" }
        : {},
    );
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  try {
    const size = target ?? fitThumbnail(bitmap.width, bitmap.height);
    const canvas = createCanvas(size.width, size.height);
    if (!canvas) throw new Error("Image decoding is unavailable.");
    canvas.context.drawImage(bitmap, 0, 0, size.width, size.height);
    const encoded = await canvas.encode();
    if (!encoded) throw new Error("Could not encode the thumbnail.");
    return encoded;
  } finally {
    bitmap.close();
  }
}
