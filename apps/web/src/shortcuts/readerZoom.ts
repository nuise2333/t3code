import {
  DEFAULT_CLIENT_SETTINGS,
  MAX_READER_ZOOM,
  MIN_READER_ZOOM,
  READER_ZOOM_STEP,
} from "@t3tools/contracts/settings";

export type ReaderZoomChange = "in" | "out" | "reset";

/** The next stop on the zoom ladder; an off-ladder level moves to the nearest stop that way. */
export function nextReaderZoom(current: number, change: ReaderZoomChange): number {
  if (change === "reset") return DEFAULT_CLIENT_SETTINGS.readerZoom;
  const next =
    change === "in"
      ? (Math.floor(current / READER_ZOOM_STEP) + 1) * READER_ZOOM_STEP
      : (Math.ceil(current / READER_ZOOM_STEP) - 1) * READER_ZOOM_STEP;
  return Math.min(MAX_READER_ZOOM, Math.max(MIN_READER_ZOOM, next));
}
