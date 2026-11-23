import { type RefObject, useEffect, useRef } from "react";

import { readOpticalConfig } from "./config";

const FIBER_ATTR = "data-optical-fiber";
const FIBER_HOLD_MS = 450;

/**
 * Traces one ring of light around the composer when the model changes, so the switch reads as
 * taking effect. Ultra tier only; the first model a composer mounts with does not trace.
 */
export function useOpticalModelFiber(
  surfaceRef: RefObject<HTMLElement | null>,
  modelKey: string,
): void {
  const previous = useRef(modelKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- plays a one-shot DOM animation on the composer when the model key changes
  useEffect(() => {
    if (previous.current === modelKey) return;
    previous.current = modelKey;
    const element = surfaceRef.current;
    if (!element || readOpticalConfig().motionLevel !== "ultra") return;
    element.removeAttribute(FIBER_ATTR);
    void element.offsetWidth;
    element.setAttribute(FIBER_ATTR, "1");
    const timer = window.setTimeout(() => element.removeAttribute(FIBER_ATTR), FIBER_HOLD_MS);
    return () => {
      window.clearTimeout(timer);
      element.removeAttribute(FIBER_ATTR);
    };
  }, [surfaceRef, modelKey]);
}
