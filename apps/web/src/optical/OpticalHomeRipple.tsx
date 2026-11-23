import { useEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import {
  ambientLayerOpacity,
  isDarkTheme,
  isOpticalReducedMotion,
  readOpticalConfig,
  resolveMinFrameGapMs,
  resolveOpticalMonoFont,
  resolveSpectrumMode,
  resolveThemeRippleColors,
  subscribeOpticalConfig,
  useOpticalConfig,
} from "./config";
import { createGlyphField, mountBrandHorizonGlow, type GlyphField } from "./rippleCore";
import { RIPPLE, createWaveField } from "./waveField";

const INTRO_MS = 1600;
const AURA_IDLE_SLEEP_MS = 1200;
const AURA_HOT_MS = 180;
const TIDE_SWELL_MS = 480;
const IDLE_FRAME_GAP_MS = 33;
const SKIM_MIN_SPEED = 220;
const SKIM_SPEED_SPAN = 1800;
const SKIM_STEP_PX = 42;
const RECT_CACHE_MS = 1500;
const GLOW_RESOLUTION = 0.6;
const MAX_DPR = 2;
const REST_REACH = 0.47;
const SLEEP_ATTRIBUTE = "data-optical-ripple-sleep";

interface HomeRippleController {
  triggerLiftoffBurst(): void;
  triggerTideSwell(): void;
  dispose(): void;
}

function mountHomeRipple(
  host: HTMLElement,
  glowCanvas: HTMLCanvasElement,
  canvas: HTMLCanvasElement,
  calmZoneSelector: string | undefined,
): HomeRippleController {
  const { cellWidth, cellHeight } = RIPPLE;
  const aura = { x: 0, y: 0, active: false };
  let cfg = readOpticalConfig();
  let still = isOpticalReducedMotion(cfg);
  let dark = isDarkTheme();
  let spectrumCode = resolveSpectrumMode(cfg, dark);
  let colors = resolveThemeRippleColors(dark, spectrumCode);
  let fontFamily = resolveOpticalMonoFont();
  let waves = createWaveField(0, 0);
  let field: GlyphField | null = null;
  let width = -1;
  let height = -1;
  let dpr = 0;
  let pixelWidth = 0;
  let pixelHeight = 0;
  const mountedAt = performance.now();
  let previous = mountedAt;
  let lastRenderAt = 0;
  let lastFrameAt = 0;
  let lastSkimX: number | null = null;
  let lastSkimY: number | null = null;
  let lastSkimAt = 0;
  let skimCarry = 0;
  let cachedRect: DOMRect | null = null;
  let cachedRectAt = 0;
  let tideSwellAt = 0;
  let swellReach = REST_REACH;
  let swellStrength = 1;
  let timer = 0;
  let frame = 0;
  let layoutFrame = 0;
  let frameWanted = false;
  let drawnOnce = false;
  let forceDraw = true;
  let sleeping = false;
  let shrunk = false;
  let glowCleared = false;
  let windowBlurred = !document.hasFocus();
  let disposed = false;

  const requestRedraw = () => {
    forceDraw = true;
    wake();
  };
  const glow = mountBrandHorizonGlow(glowCanvas, { onContextRestored: requestRedraw });
  const isPaused = () => document.hidden || windowBlurred;

  function cancelPending() {
    if (timer) window.clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    timer = 0;
    frame = 0;
    frameWanted = false;
  }

  function enterIdleSleep() {
    cancelPending();
    if (!sleeping) host.setAttribute(SLEEP_ATTRIBUTE, "1");
    sleeping = true;
  }

  // A hidden tab keeps no backing store; the next layout restores both canvases.
  function reclaim() {
    enterIdleSleep();
    if (shrunk) return;
    field?.reclaim();
    glow.reclaim();
    shrunk = true;
    forceDraw = true;
    drawnOnce = false;
  }

  function readCanvasRect(maxAgeMs: number): DOMRect {
    const now = performance.now();
    if (!cachedRect || now - cachedRectAt > maxAgeMs) {
      cachedRect = canvas.getBoundingClientRect();
      cachedRectAt = now;
    }
    return cachedRect;
  }

  function updateCalmZones() {
    if (!field) return;
    const target = calmZoneSelector
      ? (host.parentElement?.querySelector(calmZoneSelector) ??
        document.querySelector(calmZoneSelector))
      : null;
    if (!target) {
      field.setCalmZones([]);
      return;
    }
    const bounds = readCanvasRect(0);
    const calm = target.getBoundingClientRect();
    if (bounds.width <= 0 || calm.width <= 0) return;
    field.setCalmZones([
      {
        x: calm.left - bounds.left - 28,
        y: calm.top - bounds.top - 14,
        w: calm.width + 56,
        h: calm.height + 28,
      },
    ]);
  }

  function layout() {
    if (document.hidden) {
      reclaim();
      return;
    }
    const nextWidth = host.clientWidth;
    const nextHeight = host.clientHeight;
    const nextDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (nextWidth === width && nextHeight === height && nextDpr === dpr) {
      cachedRect = null;
      const lostBacking =
        pixelWidth > 0 && pixelHeight > 0 && (canvas.width === 0 || glowCanvas.width === 0);
      if (!shrunk && !lostBacking) return;
      shrunk = false;
      drawnOnce = false;
      forceDraw = true;
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      if (width > 0 && height > 0) glow.resize(width, height, GLOW_RESOLUTION);
      field?.invalidate();
      glow.invalidate();
      return;
    }
    const columns = Math.ceil(nextWidth / cellWidth);
    const rows = Math.ceil(nextHeight / cellHeight);
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    pixelWidth = Math.round(columns * cellWidth * dpr);
    pixelHeight = Math.round(rows * cellHeight * dpr);
    shrunk = false;
    drawnOnce = false;
    forceDraw = true;
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${columns * cellWidth}px`;
    canvas.style.height = `${rows * cellHeight}px`;
    if (width > 0 && height > 0) glow.resize(width, height, GLOW_RESOLUTION);
    field?.dispose();
    waves = createWaveField(columns, rows);
    field = createGlyphField(canvas, { columns, rows, waves, onContextRestored: requestRedraw });
    cachedRect = null;
    updateCalmZones();
  }

  function wake() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    if (disposed || frameWanted) return;
    if (document.hidden) {
      reclaim();
      return;
    }
    if (shrunk) layout();
    if (sleeping) host.removeAttribute(SLEEP_ATTRIBUTE);
    sleeping = false;
    if (isPaused()) {
      if (!drawnOnce && canvas.width > 0 && canvas.height > 0) drawFrame(performance.now());
      enterIdleSleep();
      return;
    }
    frameWanted = true;
    frame = requestAnimationFrame(drawFrame);
  }

  function drawFrame(now: number) {
    frame = 0;
    frameWanted = false;
    if (disposed) return;
    if (document.hidden) {
      reclaim();
      return;
    }
    const vsyncGap = lastFrameAt > 0 && now > lastFrameAt ? now - lastFrameAt : now - lastRenderAt;
    lastFrameAt = now;
    // Waves and a moving pointer render at the target rate; the ambient drift stays at 30fps.
    const targetGap = resolveMinFrameGapMs(cfg.targetFps);
    const interactive =
      waves.active() ||
      (aura.active && lastSkimAt > 0 && now - lastSkimAt < AURA_HOT_MS) ||
      (tideSwellAt > 0 && now - tideSwellAt < TIDE_SWELL_MS);
    const minGap = interactive ? targetGap : Math.max(IDLE_FRAME_GAP_MS, targetGap);
    const sinceRender = now - lastRenderAt;
    const throttled =
      !still &&
      drawnOnce &&
      !forceDraw &&
      !isPaused() &&
      minGap > 0 &&
      lastRenderAt > 0 &&
      sinceRender < minGap;
    if (throttled) {
      const remaining = minGap - sinceRender;
      if (remaining > Math.max(8, vsyncGap + 2)) {
        timer = window.setTimeout(wake, Math.max(4, Math.ceil(remaining)));
      } else {
        wake();
      }
      return;
    }
    lastRenderAt = now;
    waves.advance(still ? 0 : Math.min(0.05, Math.max(0, (now - previous) / 1000)));
    previous = now;

    const tideElapsed = tideSwellAt > 0 ? now - tideSwellAt : -1;
    const inTideSwell = !still && tideElapsed >= 0 && tideElapsed < TIDE_SWELL_MS;
    if (inTideSwell) {
      const ease = 1 - (1 - tideElapsed / TIDE_SWELL_MS) ** 2.2;
      swellReach = 0.2 + (REST_REACH - 0.2) * ease;
      swellStrength = 0.32 + 0.68 * ease;
    } else if (tideSwellAt > 0) {
      tideSwellAt = 0;
      swellReach = REST_REACH;
      swellStrength = 1;
      forceDraw = true;
    }

    const ambient = cfg.ambientIntensity;
    const lit = ambient > 0.001;
    if (!lit) aura.active = false;
    const auraRecent = aura.active && lastSkimAt > 0 && now - lastSkimAt < AURA_IDLE_SLEEP_MS;
    const inIntro = !still && lit && now - mountedAt < INTRO_MS;
    const fieldBusy = field?.busy() ?? false;
    const needsRender =
      forceDraw ||
      !drawnOnce ||
      (!lit && !glowCleared) ||
      inTideSwell ||
      inIntro ||
      auraRecent ||
      (field?.needsDraw(now, still) ?? false);

    if (field && canvas.width > 0 && canvas.height > 0 && needsRender) {
      forceDraw = false;
      if (glowCanvas.width > 0 && glowCanvas.height > 0) {
        if (lit) {
          glowCleared = false;
          glow.draw(now, {
            dark,
            still,
            strength: inTideSwell ? swellStrength : 1,
            reach: swellReach,
            ambientIntensity: ambient,
            spectrumCode,
          });
        } else if (!glowCleared) {
          glow.clear();
          glowCleared = true;
        }
      }
      field.draw(
        now,
        {
          dark,
          ink: colors.ink,
          wave: colors.wave,
          fontFamily,
          spectrumCode,
          ambientIntensity: ambient,
          prismStrength: ambient * (spectrumCode === 5 ? 0.45 : 1),
          aura:
            aura.active && !still
              ? { x: aura.x, y: aura.y, radius: RIPPLE.auraRadius, strength: ambient }
              : null,
          auraPhase: now * 0.0006,
        },
        still,
      );
      drawnOnce = true;
    }

    if (!isPaused() && !still && (inTideSwell || fieldBusy || inIntro || auraRecent)) wake();
    else enterIdleSleep();
  }

  // The 2D path bakes the aura into its pixels, so a moved aura needs a full repaint there.
  const invalidateSoftwareField = () => {
    if (field && field.mode !== "webgl2") field.invalidate();
  };

  function dropAura() {
    lastSkimX = null;
    lastSkimY = null;
    skimCarry = 0;
    if (!aura.active) return;
    aura.active = false;
    forceDraw = true;
    invalidateSoftwareField();
    wake();
  }

  function onPointerMove(event: PointerEvent) {
    if (still || isPaused()) return;
    const rect = readCanvasRect(RECT_CACHE_MS);
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      dropAura();
      return;
    }
    const now = performance.now();
    if (lastSkimX !== null && lastSkimY !== null) {
      const distance = Math.hypot(x - lastSkimX, y - lastSkimY);
      const speed = distance / Math.max(0.004, (now - lastSkimAt) / 1000);
      if (speed >= SKIM_MIN_SPEED) {
        skimCarry += distance;
        if (skimCarry >= SKIM_STEP_PX) {
          skimCarry = Math.min(20, skimCarry - SKIM_STEP_PX);
          const speedNorm = Math.max(0.05, Math.min(1, (speed - SKIM_MIN_SPEED) / SKIM_SPEED_SPAN));
          waves.skimmer(Math.floor(x / cellWidth), Math.floor(y / cellHeight), speedNorm);
        }
      } else {
        skimCarry *= 0.85;
      }
    }
    lastSkimX = x;
    lastSkimY = y;
    lastSkimAt = now;
    if (cfg.ambientIntensity > 0.001) {
      aura.x = x;
      aura.y = y;
      aura.active = true;
      if (sleeping) previous = now;
      invalidateSoftwareField();
      wake();
    } else if (waves.active()) {
      if (sleeping) previous = now;
      field?.invalidate();
      wake();
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || still || isPaused() || cfg.ambientIntensity <= 0.001) return;
    const rect = readCanvasRect(0);
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    if (sleeping) previous = performance.now();
    waves.disturb(Math.floor(x / cellWidth), Math.floor(y / cellHeight));
    field?.invalidate();
    wake();
  }

  function onVisibilityChange() {
    if (document.hidden) {
      reclaim();
      return;
    }
    const wasShrunk = shrunk;
    if (wasShrunk || canvas.width === 0 || canvas.height === 0) layout();
    const restored = wasShrunk && canvas.width > 0 && canvas.height > 0;
    if (!isPaused()) {
      previous = performance.now();
      forceDraw = true;
      if (restored) drawFrame(previous);
      else wake();
    } else if (restored && !drawnOnce) {
      drawFrame(performance.now());
    } else {
      enterIdleSleep();
    }
  }

  function onWindowBlur() {
    windowBlurred = true;
    enterIdleSleep();
  }

  function onWindowFocus() {
    windowBlurred = false;
    onVisibilityChange();
  }

  function refresh() {
    cfg = readOpticalConfig();
    still = isOpticalReducedMotion(cfg);
    dark = isDarkTheme();
    spectrumCode = resolveSpectrumMode(cfg, dark);
    colors = resolveThemeRippleColors(dark, spectrumCode);
    fontFamily = resolveOpticalMonoFont();
    field?.invalidate();
    glow.invalidate();
    requestRedraw();
  }

  const unobserveResize = observeResize(host, () => {
    layoutFrame ||= requestAnimationFrame(() => {
      layoutFrame = 0;
      if (disposed) return;
      layout();
      wake();
    });
  });
  const unsubscribeConfig = subscribeOpticalConfig(refresh);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.documentElement.addEventListener("pointerleave", dropAura);

  layout();
  wake();

  return {
    triggerLiftoffBurst() {
      if (disposed || still || cfg.motionLevel !== "ultra" || !field) return;
      if (sleeping) previous = performance.now();
      field.triggerLiftoffBurst();
      wake();
    },
    triggerTideSwell() {
      if (disposed || still || !field) return;
      const now = performance.now();
      if (sleeping) previous = now;
      tideSwellAt = now;
      swellReach = 0.2;
      swellStrength = 0.32;
      updateCalmZones();
      field.triggerTideSwell();
      wake();
    },
    dispose() {
      disposed = true;
      cancelPending();
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      unobserveResize();
      unsubscribeConfig();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.documentElement.removeEventListener("pointerleave", dropAura);
      field?.reclaim();
      field?.dispose();
      glow.reclaim();
      glow.dispose();
      host.removeAttribute(SLEEP_ATTRIBUTE);
    },
  };
}

export interface OpticalHomeRippleProps {
  /** Element the glyph field dims around, usually the hero headline. */
  readonly calmZoneSelector?: string | undefined;
  /** Bump to fire the send burst; only the ultra motion level plays it. */
  readonly liftoffSignal?: number | undefined;
  /** Bump when the home view comes back; it also swells once on mount. */
  readonly tideSwellSignal?: number | undefined;
  readonly className?: string | undefined;
}

/** Full-bleed interactive glyph ripple with a horizon glow, for the empty home view. */
export function OpticalHomeRipple(props: OpticalHomeRippleProps) {
  const cfg = useOpticalConfig();
  if (!cfg.homeRipple || cfg.ambientIntensity === 0) return null;
  return <HomeRippleLayer {...props} opacity={ambientLayerOpacity(cfg.ambientIntensity)} />;
}

function HomeRippleLayer({
  calmZoneSelector,
  liftoffSignal,
  tideSwellSignal,
  className,
  opacity,
}: OpticalHomeRippleProps & { readonly opacity: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<HomeRippleController | null>(null);
  const seenLiftoffRef = useRef(liftoffSignal);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the canvases' render loop, GPU resources and window listeners for the layer's lifetime.
  useEffect(() => {
    const host = hostRef.current;
    const glowCanvas = glowRef.current;
    const canvas = canvasRef.current;
    if (!host || !glowCanvas || !canvas) return;
    const controller = mountHomeRipple(host, glowCanvas, canvas, calmZoneSelector);
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [calmZoneSelector]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A bumped signal is a one-shot pulse into the canvas; it also plays once on mount.
  useEffect(() => {
    controllerRef.current?.triggerTideSwell();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each bump of the signal replays the swell.
  }, [tideSwellSignal]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A bumped signal is a one-shot pulse into the canvas, skipped for the value seen at mount.
  useEffect(() => {
    if (seenLiftoffRef.current === liftoffSignal) return;
    seenLiftoffRef.current = liftoffSignal;
    controllerRef.current?.triggerLiftoffBurst();
  }, [liftoffSignal]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-optical-ripple-host=""
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{ opacity }}
    >
      <canvas
        ref={glowRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 block size-full"
      />
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none relative block" />
    </div>
  );
}
