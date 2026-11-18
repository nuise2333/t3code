import type { ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { getClientSettings, updateClientSettings } from "../hooks/useSettings";
import { exportReaderAsPdf } from "../reader/export/readerExport";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { activeReader } from "./readerFocus";
import { nextReaderZoom, type ReaderZoomChange } from "./readerZoom";

export function zoomReader(change: ReaderZoomChange): void {
  const current = getClientSettings().readerZoom;
  const readerZoom = nextReaderZoom(current, change);
  if (readerZoom !== current) void updateClientSettings({ readerZoom });
  toastManager.add({ id: "reader-zoom", title: `Reading zoom: ${readerZoom}%`, timeout: 1500 });
}

/** The name of the file the thread's right panel shows, for the exported document's title. */
function shownDocumentName(threadRef: ScopedThreadRef | null): string {
  const surface = selectActiveRightPanelSurface(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  if (surface?.kind !== "file") return "";
  return surface.attachment?.name ?? surface.relativePath;
}

/** Exports the reading view the user means; false when none is on screen. */
export function exportShownReader(threadRef: ScopedThreadRef | null): boolean {
  const reader = activeReader();
  if (reader === null) return false;
  exportReaderAsPdf(reader, shownDocumentName(threadRef)).then(
    (result) => {
      if (result !== "saved") return;
      toastManager.add({ id: "reader-export", type: "success", title: "PDF exported" });
    },
    () => {
      toastManager.add({ id: "reader-export", type: "error", title: "Could not export the PDF" });
    },
  );
  return true;
}
