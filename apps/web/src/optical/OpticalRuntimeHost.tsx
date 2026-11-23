import { useEffect } from "react";

import {
  OPTICAL_SETTINGS_EVENT,
  bindMicroInteractions,
  syncOpticalSpringTokens,
} from "./motionEngine";
import { createPrismRimController, type PrismRimController } from "./prismRim";
import { createSmoothCaretController } from "./smoothCaret";

let activePrismRim: PrismRimController | null = null;

/** Notify the active prism rim controller when a `[data-optical-prism-box="1"]` mounts or unmounts. */
export function markOpticalPrismDirty(): void {
  activePrismRim?.markDirty();
}

/**
 * Owns the app-wide optical runtime controllers (spring CSS tokens, delegated button/icon
 * micro-interactions, near-field prism rim canvas, and elastic composer smooth caret).
 */
export function OpticalRuntimeHost() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns window/document listeners and canvas controllers for the app shell lifetime
  useEffect(() => {
    const onSettingsChanged = () => {
      syncOpticalSpringTokens();
    };
    syncOpticalSpringTokens();
    window.addEventListener(OPTICAL_SETTINGS_EVENT, onSettingsChanged);

    const unbindMicro = bindMicroInteractions(window);
    const prismRim = createPrismRimController();
    activePrismRim = prismRim;
    prismRim.start();

    const smoothCaret = createSmoothCaretController();
    smoothCaret.start();

    return () => {
      window.removeEventListener(OPTICAL_SETTINGS_EVENT, onSettingsChanged);
      unbindMicro();
      smoothCaret.teardown();
      prismRim.teardown();
      if (activePrismRim === prismRim) {
        activePrismRim = null;
      }
    };
  }, []);

  return null;
}
