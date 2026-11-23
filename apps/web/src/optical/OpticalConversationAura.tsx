import { useEffect, useEffectEvent, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import {
  advanceAura,
  computeAuraFrame,
  createAuraState,
  resumeAuraFocus,
  triggerAuraLiftoff,
  type AuraInputs,
} from "./auraPhase";
import {
  ambientLayerOpacity,
  isDarkTheme,
  readOpticalConfig,
  resolveEffectiveMotionLevel,
  resolveMinFrameGapMs,
  resolveSpectrumMode,
  subscribeOpticalConfig,
  useOpticalConfig,
} from "./config";
import { mountBrandHorizonGlow, resolveHorizonDpr } from "./rippleCore";

const RESIZE_DEBOUNCE_MS = 120;
const RESIZE_BURST_MS = 180;
const DIRECT_FRAME_MS = 20;
const TIMER_LEAD_MS = 8;
const HOST_CLASS = "optical-conv-aura-host";

interface AuraSignals {
  readonly running: boolean;
  readonly awaitingDecision: boolean;
  readonly hasError: boolean;
  readonly workStartedAt: number | null;
}

interface AuraController {
  setSignals(signals: AuraSignals): void;
  triggerLiftoff(): void;
  dispose(): void;
}

function mountConversationAura(
  host: HTMLElement,
  canvas: HTMLCanvasElement,
  initial: AuraSignals,
): AuraController {
  let cfg = readOpticalConfig();
  let motionLevel = resolveEffectiveMotionLevel(cfg);
  let dark = isDarkTheme();
  let spectrumCode = resolveSpectrumMode(cfg, dark);
  let signals = initial;
  let windowFocused = document.hasFocus();
  let width = -1;
  let height = -1;
  let dpr = 0;
  let backingReleased = false;
  let lit = false;
  let timer = 0;
  let frame = 0;
  let resizeTimer = 0;
  let lastResizeAt = Number.NEGATIVE_INFINITY;
  let dueAt = 0;
  let sleeping = false;
  let disposed = false;

  // The host reports wall-clock epoch time; the phase machine runs on the frame clock.
  const readInputs = (now: number): AuraInputs => ({
    running: signals.running,
    awaitingDecision: signals.awaitingDecision,
    hasError: signals.hasError,
    runStartedAt:
      signals.workStartedAt === null ? null : now - Math.max(0, Date.now() - signals.workStartedAt),
    windowFocused,
  });

  const glow = mountBrandHorizonGlow(canvas, { onContextRestored: () => wake() });
  let state = createAuraState(readInputs(performance.now()), performance.now());
  host.classList.add(HOST_CLASS);
  host.dataset.opticalAuraPhase = state.phase;

  function cancelPending() {
    if (timer) window.clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    timer = 0;
    frame = 0;
  }

  function markSleeping(next: boolean) {
    if (sleeping === next) return;
    sleeping = next;
    if (next) host.dataset.opticalAuraSleep = "1";
    else delete host.dataset.opticalAuraSleep;
  }

  function applySize(): boolean {
    const nextWidth = host.clientWidth;
    const nextHeight = host.clientHeight;
    const nextDpr = resolveHorizonDpr(window.devicePixelRatio || 1);
    const unchanged =
      !backingReleased &&
      nextWidth === width &&
      nextHeight === height &&
      nextDpr === dpr &&
      canvas.width > 0;
    if (unchanged) return false;
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    backingReleased = false;
    if (width > 0 && height > 0) glow.resize(width, height, dpr);
    return true;
  }

  // A hidden tab keeps no backing store; the next visible frame restores it.
  function releaseBacking() {
    cancelPending();
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = 0;
    markSleeping(true);
    if (backingReleased) return;
    glow.reclaim();
    backingReleased = true;
    lit = false;
  }

  function schedule(delayMs: number) {
    cancelPending();
    dueAt = performance.now() + delayMs;
    if (delayMs <= DIRECT_FRAME_MS) {
      frame = requestAnimationFrame(tick);
      return;
    }
    timer = window.setTimeout(() => {
      timer = 0;
      frame = requestAnimationFrame(tick);
    }, delayMs - TIMER_LEAD_MS);
  }

  function wake() {
    if (disposed) return;
    cancelPending();
    dueAt = 0;
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    frame = 0;
    if (disposed) return;
    if (document.hidden) {
      releaseBacking();
      return;
    }
    // A timer wakes slightly early; the frame that lands on or after the due time draws.
    if (now < dueAt - 1) {
      frame = requestAnimationFrame(tick);
      return;
    }
    if (backingReleased || width < 0) applySize();
    state = advanceAura(state, readInputs(now), now);
    const next = computeAuraFrame(state, now, {
      isDark: dark,
      ambientScale: cfg.ambientIntensity,
      motionLevel,
      hidden: false,
      windowFocused,
      gpu: glow.mode === "webgl2",
      minFrameGapMs: resolveMinFrameGapMs(cfg.targetFps),
    });
    state = next.state;
    if (host.dataset.opticalAuraPhase !== state.phase) host.dataset.opticalAuraPhase = state.phase;
    if (next.clearCanvas) {
      if (lit) glow.clear();
      lit = false;
    } else {
      lit = glow.drawUniforms({
        timeSec: next.timeSec,
        dark,
        intensity: next.intensity,
        presence: next.presence,
        reach: next.reach,
        stretch: next.stretch,
        prism: next.prism,
        surge: next.surge,
        speed: next.speed,
        spectrumCode,
        semantic: next.semantic,
      });
    }
    markSleeping(next.shouldSleep);
    if (!next.shouldSleep) schedule(next.nextFrameMs);
  }

  function flushResize() {
    resizeTimer = 0;
    if (!disposed && applySize()) wake();
  }

  // Dragging a window edge fires a burst; reallocating the backing store once it ends is enough.
  function onResize() {
    if (document.hidden) {
      releaseBacking();
      return;
    }
    const now = performance.now();
    const live = !backingReleased && canvas.width > 0 && canvas.height > 0;
    const bursting = live && (resizeTimer !== 0 || now - lastResizeAt <= RESIZE_BURST_MS);
    lastResizeAt = now;
    if (!bursting) {
      flushResize();
      return;
    }
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(flushResize, RESIZE_DEBOUNCE_MS);
  }

  function onVisibilityChange() {
    if (document.hidden) releaseBacking();
    else wake();
  }

  function onWindowBlur() {
    windowFocused = false;
    wake();
  }

  function onWindowFocus() {
    windowFocused = true;
    state = resumeAuraFocus(state, performance.now());
    wake();
  }

  // A pointer over an unfocused window means the user is back, even before it takes focus.
  function onPointerReturn() {
    if (!windowFocused) onWindowFocus();
  }

  function refresh() {
    cfg = readOpticalConfig();
    motionLevel = resolveEffectiveMotionLevel(cfg);
    dark = isDarkTheme();
    spectrumCode = resolveSpectrumMode(cfg, dark);
    wake();
  }

  const unobserveResize = observeResize(host, onResize);
  const unsubscribeConfig = subscribeOpticalConfig(refresh);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("pointermove", onPointerReturn, { passive: true });
  document.documentElement.addEventListener("pointerenter", onPointerReturn);
  document.addEventListener("visibilitychange", onVisibilityChange);
  wake();

  return {
    setSignals(next) {
      signals = next;
      wake();
    },
    triggerLiftoff() {
      state = triggerAuraLiftoff(state, performance.now());
      wake();
    },
    dispose() {
      disposed = true;
      cancelPending();
      if (resizeTimer) window.clearTimeout(resizeTimer);
      unobserveResize();
      unsubscribeConfig();
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("pointermove", onPointerReturn);
      document.documentElement.removeEventListener("pointerenter", onPointerReturn);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      glow.reclaim();
      glow.dispose();
      host.classList.remove(HOST_CLASS);
      delete host.dataset.opticalAuraPhase;
      delete host.dataset.opticalAuraSleep;
    },
  };
}

export interface OpticalConversationAuraProps {
  readonly isWorking: boolean;
  readonly runIsLive: boolean;
  readonly isConnecting: boolean;
  readonly awaitingDecision: boolean;
  readonly hasError: boolean;
  /** Epoch milliseconds at which the active work started, when the thread knows it. */
  readonly workStartedAt: number | null;
  /** Bump when a message is sent to play the liftoff ebb. */
  readonly liftoffSignal?: number | undefined;
  readonly className?: string | undefined;
}

/** Bottom horizon glow that mirrors the conversation's run state. */
export function OpticalConversationAura(props: OpticalConversationAuraProps) {
  const cfg = useOpticalConfig();
  if (cfg.ambientIntensity === 0) return null;
  return <ConversationAuraLayer {...props} opacity={ambientLayerOpacity(cfg.ambientIntensity)} />;
}

function ConversationAuraLayer({
  isWorking,
  runIsLive,
  isConnecting,
  awaitingDecision,
  hasError,
  workStartedAt,
  liftoffSignal,
  className,
  opacity,
}: OpticalConversationAuraProps & { readonly opacity: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<AuraController | null>(null);
  const seenLiftoffRef = useRef(liftoffSignal);
  const running = isWorking || runIsLive || isConnecting;
  const readSignals = useEffectEvent((): AuraSignals => ({
    running,
    awaitingDecision,
    hasError,
    workStartedAt,
  }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the canvas render loop, GPU resources and window listeners for the layer's lifetime.
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const controller = mountConversationAura(host, canvas, readSignals());
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Run state drives a canvas phase machine outside React; nothing here renders.
  useEffect(() => {
    controllerRef.current?.setSignals({ running, awaitingDecision, hasError, workStartedAt });
  }, [running, awaitingDecision, hasError, workStartedAt]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A bumped signal is a one-shot pulse into the canvas, skipped for the value seen at mount.
  useEffect(() => {
    if (seenLiftoffRef.current === liftoffSignal) return;
    seenLiftoffRef.current = liftoffSignal;
    controllerRef.current?.triggerLiftoff();
  }, [liftoffSignal]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 h-[32%] overflow-hidden",
        className,
      )}
      style={{ opacity }}
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 block size-full" />
    </div>
  );
}
