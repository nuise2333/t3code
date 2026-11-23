import { useEffect } from "react";

import {
  OPTICAL_SETTINGS_EVENT,
  bindMicroInteractions,
  syncOpticalSpringTokens,
} from "./motionEngine";
import { createPrismRimController, type PrismRimController } from "./prismRim";
import { bindSidebarGlide } from "./sidebarGlide";
import { createSmoothCaretController } from "./smoothCaret";

let activePrismRim: PrismRimController | null = null;

/** Notify the active prism rim controller when a `[data-optical-prism-box="1"]` mounts or unmounts. */
export function markOpticalPrismDirty(): void {
  activePrismRim?.markDirty();
}

/** A ref for a `[data-optical-prism-box]` that mounts on its own, such as a card in the stack. */
export function opticalPrismBoxRef(node: HTMLElement | null): (() => void) | undefined {
  if (!node) return undefined;
  markOpticalPrismDirty();
  return markOpticalPrismDirty;
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

    const unbindWindowBlur = bindWindowBlurPause();
    const unbindSidebarGlide = bindSidebarGlide();

    return () => {
      window.removeEventListener(OPTICAL_SETTINGS_EVENT, onSettingsChanged);
      unbindMicro();
      unbindWindowBlur();
      unbindSidebarGlide();
      smoothCaret.teardown();
      prismRim.teardown();
      if (activePrismRim === prismRim) {
        activePrismRim = null;
      }
    };
  }, []);

  return null;
}

const WIN_BLUR_ATTR = "data-optical-win-blur";
const WIN_BLUR_DELAY_MS = 1200;

/**
 * Pauses every looping optical animation once the window has been out of focus for a moment,
 * so a background window paints nothing. Pointer movement or focus resumes it at once.
 */
function bindWindowBlurPause(): () => void {
  const root = document.documentElement;
  let timer = 0;
  const resume = () => {
    window.clearTimeout(timer);
    timer = 0;
    if (root.hasAttribute(WIN_BLUR_ATTR)) root.removeAttribute(WIN_BLUR_ATTR);
  };
  const onBlur = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => root.setAttribute(WIN_BLUR_ATTR, "1"), WIN_BLUR_DELAY_MS);
  };
  const onVisibility = () => (document.hidden ? root.setAttribute(WIN_BLUR_ATTR, "1") : resume());
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", resume);
  window.addEventListener("pointermove", resume, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    resume();
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", resume);
    window.removeEventListener("pointermove", resume);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
