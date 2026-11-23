import { useEffect, useEffectEvent, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import {
  isDarkTheme,
  readOpticalConfig,
  resolveEffectiveMotionLevel,
  resolveMinFrameGapMs,
  resolveSpectrumMode,
  subscribeOpticalConfig,
  type OpticalSpectrumCode,
} from "./config";
import { mountOpticalVial, type VialAccent, type VialCamp } from "./vialCore";

const AMBIENT_FRAME_GAP_MS = 33;
const INTERACTION_HOT_MS = 600;
const DIRECT_FRAME_MS = 20;
const TIMER_LEAD_MS = 8;
const CRITICAL_FILL = 0.85;
const ACCENT_BY_SPECTRUM: Record<OpticalSpectrumCode, VialAccent> = {
  0: "cobalt",
  1: "amber",
  2: "cobalt",
  3: "iris",
  4: "amber",
  5: "mono",
};

interface VialLevel {
  readonly fill: number;
  readonly streaming: boolean;
  readonly critical: boolean;
  readonly ratios?: readonly [number, number, number] | undefined;
  readonly hoveredSlice?: number | undefined;
  readonly camp?: VialCamp | undefined;
  readonly tickLabels?: readonly [string, string, string] | undefined;
}

interface VialController {
  setLevel(level: VialLevel): void;
  dispose(): void;
}

function mountContextVial(canvas: HTMLCanvasElement, initial: VialLevel): VialController {
  let cfg = readOpticalConfig();
  let dark = isDarkTheme();
  let accent = ACCENT_BY_SPECTRUM[resolveSpectrumMode(cfg, dark)];
  let reduceMotion = isStaticLevel();
  let level = initial;
  let frame = 0;
  let timer = 0;
  let dueAt = 0;
  let lastStepAt = 0;
  let lastWakeAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  function isStaticLevel() {
    const motion = resolveEffectiveMotionLevel(cfg);
    return motion === "off" || motion === "subtle";
  }

  function cancelPending() {
    if (timer) window.clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    timer = 0;
    frame = 0;
  }

  function wake() {
    lastWakeAt = performance.now();
    if (disposed || document.hidden || frame || timer) return;
    dueAt = 0;
    frame = requestAnimationFrame(tick);
  }

  const vial = mountOpticalVial(canvas, {
    getState: () => ({
      isDark: dark,
      fill: level.fill,
      critical: level.critical,
      streaming: level.streaming,
      accent,
      reduceMotion,
      ratios: level.ratios,
      hoveredSlice: level.hoveredSlice,
      camp: level.camp,
      tickLabels: level.tickLabels,
    }),
    onWake: wake,
  });

  function sleep() {
    cancelPending();
    lastStepAt = 0;
    canvas.dataset.opticalVialSleep = "1";
  }

  function tick(now: number) {
    frame = 0;
    if (disposed) return;
    if (document.hidden) {
      sleep();
      vial.reclaim();
      return;
    }
    if (now < dueAt - 1) {
      frame = requestAnimationFrame(tick);
      return;
    }
    delete canvas.dataset.opticalVialSleep;
    vial.step(lastStepAt > 0 ? (now - lastStepAt) / 1000 : 1 / 60);
    lastStepAt = now;
    if (vial.isSettled()) {
      sleep();
      return;
    }
    // A poke renders at the target rate; a streaming vial only drifts, so 30fps is plenty.
    const targetGap = resolveMinFrameGapMs(cfg.targetFps);
    const hot = now - lastWakeAt < INTERACTION_HOT_MS;
    const gap = hot ? targetGap : Math.max(AMBIENT_FRAME_GAP_MS, targetGap);
    dueAt = now + gap;
    if (gap <= DIRECT_FRAME_MS) {
      frame = requestAnimationFrame(tick);
      return;
    }
    timer = window.setTimeout(() => {
      timer = 0;
      frame = requestAnimationFrame(tick);
    }, gap - TIMER_LEAD_MS);
  }

  function onVisibilityChange() {
    if (!document.hidden) {
      vial.wake();
      return;
    }
    sleep();
    vial.reclaim();
  }

  const unobserveResize = observeResize(canvas, () => {
    vial.resize(canvas.clientWidth, canvas.clientHeight);
  });
  const unsubscribeConfig = subscribeOpticalConfig(() => {
    cfg = readOpticalConfig();
    dark = isDarkTheme();
    accent = ACCENT_BY_SPECTRUM[resolveSpectrumMode(cfg, dark)];
    reduceMotion = isStaticLevel();
    vial.wake();
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  wake();

  return {
    setLevel(next) {
      level = next;
      vial.wake();
    },
    dispose() {
      disposed = true;
      cancelPending();
      unobserveResize();
      unsubscribeConfig();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      vial.dispose();
    },
  };
}

export interface OpticalContextVialProps {
  /** Share of the context window in use, from 0 to 1. */
  readonly fill: number;
  readonly usedPercent: number | null;
  readonly isStreaming?: boolean | undefined;
  /** Defaults to true once the window is 85% full. */
  readonly isCritical?: boolean | undefined;
  readonly ratios?: readonly [number, number, number] | undefined;
  readonly hoveredSlice?: number | undefined;
  readonly camp?: VialCamp | undefined;
  readonly tickLabels?: readonly [string, string, string] | undefined;
  readonly className?: string | undefined;
}

/** Glass vial whose liquid level tracks context usage; hover and press disturb the surface. */
export function OpticalContextVial({
  fill,
  usedPercent,
  isStreaming = false,
  isCritical,
  ratios,
  hoveredSlice = -1,
  camp = "gemini",
  tickLabels,
  className,
}: OpticalContextVialProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<VialController | null>(null);
  const level = Number.isFinite(fill) ? fill : 0;
  const critical = isCritical ?? level >= CRITICAL_FILL;
  const r0 = ratios?.[0];
  const r1 = ratios?.[1];
  const r2 = ratios?.[2];
  const t0 = tickLabels?.[0];
  const t1 = tickLabels?.[1];
  const t2 = tickLabels?.[2];
  const readLevel = useEffectEvent((): VialLevel => ({
    fill: level,
    streaming: isStreaming,
    critical,
    ratios,
    hoveredSlice,
    camp,
    tickLabels,
  }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the vial's render loop, WebGL context and listeners for the canvas lifetime.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = mountContextVial(canvas, readLevel());
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The level drives a physics simulation on the canvas; nothing here renders.
  useEffect(() => {
    controllerRef.current?.setLevel({
      fill: level,
      streaming: isStreaming,
      critical,
      ratios: r0 !== undefined && r1 !== undefined && r2 !== undefined ? [r0, r1, r2] : undefined,
      hoveredSlice,
      camp,
      tickLabels:
        t0 !== undefined && t1 !== undefined && t2 !== undefined ? [t0, t1, t2] : undefined,
    });
  }, [level, isStreaming, critical, r0, r1, r2, hoveredSlice, camp, t0, t1, t2]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={
        usedPercent === null ? "Context window" : `Context window ${Math.round(usedPercent)}% used`
      }
      className={cn("block h-20 w-10", className)}
    />
  );
}
