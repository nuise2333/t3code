import { observeResize } from "~/lib/observeResize";

import {
  isDarkTheme,
  isOpticalReducedMotion,
  readOpticalConfig,
  resolveMinFrameGapMs,
  resolveSpectrumMode,
  subscribeOpticalConfig,
  type OpticalSpectrumCode,
} from "./config";

type RimTone = "default" | "warm" | "cobalt" | "iris" | "amber" | "mono";
type RimMode = "standard" | "mirror" | "reflect";
type GradientStops = ReadonlyArray<readonly [number, string]>;

const RIM_PALETTES: Record<
  RimTone,
  { readonly dark: GradientStops; readonly light: GradientStops }
> = {
  default: {
    dark: [
      [0, "rgba(255,255,255,0.96)"],
      [0.24, "#4285F4"],
      [0.5, "#9B72CB"],
      [0.74, "#EA4335"],
      [0.92, "#FBBC04"],
      [1, "rgba(251,188,4,0)"],
    ],
    light: [
      [0, "#2563EB"],
      [0.32, "#7C3AED"],
      [0.64, "#EA4335"],
      [0.88, "#D97706"],
      [1, "rgba(217,119,6,0)"],
    ],
  },
  warm: {
    dark: [
      [0, "rgba(255,246,238,0.95)"],
      [0.26, "#F6BD60"],
      [0.54, "#F0A37E"],
      [0.82, "#D97757"],
      [1, "rgba(217,119,87,0)"],
    ],
    light: [
      [0, "#9A3412"],
      [0.34, "#C25934"],
      [0.68, "#D97757"],
      [0.9, "#D97706"],
      [1, "rgba(217,119,6,0)"],
    ],
  },
  cobalt: {
    dark: [
      [0, "rgba(240,249,255,0.96)"],
      [0.26, "#7CE2FF"],
      [0.56, "#4285F4"],
      [0.86, "#1B49B2"],
      [1, "rgba(27,73,178,0)"],
    ],
    light: [
      [0, "#1D4ED8"],
      [0.35, "#2563EB"],
      [0.7, "#0284C7"],
      [0.92, "#38BDF8"],
      [1, "rgba(56,189,248,0)"],
    ],
  },
  iris: {
    dark: [
      [0, "rgba(245,243,255,0.95)"],
      [0.26, "#DDD6FE"],
      [0.56, "#A58AF8"],
      [0.86, "#6D28D9"],
      [1, "rgba(109,40,217,0)"],
    ],
    light: [
      [0, "#5B21B6"],
      [0.36, "#7C3AED"],
      [0.7, "#8B5CF6"],
      [0.92, "#A855F7"],
      [1, "rgba(168,85,247,0)"],
    ],
  },
  amber: {
    dark: [
      [0, "rgba(255,251,235,0.95)"],
      [0.26, "#FDE68A"],
      [0.56, "#F2B84B"],
      [0.86, "#D97706"],
      [1, "rgba(217,119,6,0)"],
    ],
    light: [
      [0, "#92400E"],
      [0.36, "#B45309"],
      [0.7, "#D97706"],
      [0.92, "#F59E0B"],
      [1, "rgba(245,158,11,0)"],
    ],
  },
  mono: {
    dark: [
      [0, "rgba(248,250,252,0.92)"],
      [0.28, "#E2E8F0"],
      [0.6, "#94A3B8"],
      [0.88, "#64748B"],
      [1, "rgba(100,116,139,0)"],
    ],
    light: [
      [0, "#1E293B"],
      [0.36, "#334155"],
      [0.7, "#64748B"],
      [0.92, "#94A3B8"],
      [1, "rgba(148,163,184,0)"],
    ],
  },
};

const TONE_BY_SPECTRUM: Record<OpticalSpectrumCode, RimTone> = {
  0: "default",
  1: "warm",
  2: "cobalt",
  3: "iris",
  4: "amber",
  5: "mono",
};

const BOX_SELECTOR = '[data-optical-prism-box="1"]';
const RIM_CLASS = "optical-prism-rim-cv";
const MOUNTED_ATTRIBUTE = "data-optical-prism-cv";
const GRADIENT_RADIUS = 240;
const POINTER_REACH = 280;
const FAR_IDLE_REACH = 360;
const MAX_DPR = 1.5;
const MOVE_EPSILON = 1.5;
const RECLAIM_DELAY_MS = 1800;
const RESCAN_MS = 8000;
const FAR_RESCAN_MS = 6000;
const EMPTY_RESCAN_MS = 1000;
const RECT_REFRESH_MS = 1500;
const DEFAULT_RADIUS = 10;
const OFFSCREEN = -9999;
// A cursor reflection repaints the whole box, so large mirror surfaces go without one.
const MAX_REFLECTION_AREA = 120_000;

interface RimEntry {
  readonly box: HTMLElement;
  readonly canvas: HTMLCanvasElement | null;
  readonly context: CanvasRenderingContext2D | null;
  readonly unobserve: () => void;
  mode: RimMode;
  rect: DOMRect | null;
  borderRadius: number;
  cleared: boolean;
  signature: string;
  lastX: number;
  lastY: number;
  gradient: CanvasGradient | null;
  gradientKey: string;
  fallbackX: string;
  fallbackY: string;
}

export interface PrismRimController {
  start(): void;
  teardown(): void;
  /** A prism box mounted or unmounted. */
  markDirty(): void;
  /** Box geometry or corner radii changed in a way a resize does not report. */
  invalidateMetrics(): void;
}

function readMode(box: HTMLElement): RimMode {
  if (box.dataset.opticalPrismMirror === "1") return "mirror";
  return box.dataset.opticalPrismReflect === "bottom" ? "reflect" : "standard";
}

function styleRimCanvas(canvas: HTMLCanvasElement, mode: RimMode) {
  const { style } = canvas;
  const outset = mode === "mirror" ? 0 : 1;
  style.position = "absolute";
  style.inset = `${-outset}px`;
  style.width = `calc(100% + ${outset * 2}px)`;
  style.height = `calc(100% + ${outset * 2}px)`;
  style.boxSizing = "border-box";
  style.borderRadius = "inherit";
  style.pointerEvents = "none";
  style.margin = "0";
  style.padding = "0";
  style.border = "0";
}

function addStops(gradient: CanvasGradient, stops: GradientStops) {
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function cursorGhostPath(ctx: CanvasRenderingContext2D, s: number) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 13.8 * s);
  ctx.lineTo(3.6 * s, 10.5 * s);
  ctx.lineTo(6.1 * s, 15.6 * s);
  ctx.lineTo(8.0 * s, 14.7 * s);
  ctx.lineTo(5.5 * s, 9.6 * s);
  ctx.lineTo(10.1 * s, 9.6 * s);
  ctx.closePath();
}

const rgba = (rgb: string, alpha: number) => `rgba(${rgb},${alpha.toFixed(4)})`;

function drawCursorReflection(
  ctx: CanvasRenderingContext2D,
  rect: DOMRect,
  gx: number,
  gy: number,
  w: number,
  h: number,
  dpr: number,
  dark: boolean,
  alpha: number,
  localX: number,
  localY: number,
) {
  const { width, height } = rect;
  if (width * height > MAX_REFLECTION_AREA) return;
  const outX = localX < 0 ? -localX : localX > width ? localX - width : 0;
  const outY = localY < 0 ? -localY : localY > height ? localY - height : 0;
  const distance = Math.hypot(outX, outY);
  if (distance > 42) return;
  const reflection = alpha * (1 - distance / 42) * (dark ? 1 : 0.65);
  if (reflection <= 0.01) return;

  // The ghost sits a few pixels off the pointer, as if refracted through the glass thickness.
  const rx = gx + 3.2 * dpr;
  const ry = gy + 4.2 * dpr;
  const bloom = ctx.createRadialGradient(
    rx + 2 * dpr,
    ry + 3 * dpr,
    0,
    rx + 2 * dpr,
    ry + 3 * dpr,
    26 * dpr,
  );
  if (dark) {
    bloom.addColorStop(0, rgba("248,252,255", 0.135 * reflection));
    bloom.addColorStop(0.45, rgba("216,232,252", 0.05 * reflection));
    bloom.addColorStop(1, "rgba(200,220,250,0)");
  } else {
    bloom.addColorStop(0, rgba("37,99,235", 0.065 * reflection));
    bloom.addColorStop(1, "rgba(37,99,235,0)");
  }
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, w, h);

  // Two soft low-alpha passes read as defocus without allocating a blur surface.
  const outer = 1.18 * dpr;
  ctx.save();
  ctx.translate(rx - 0.55 * dpr, ry - 0.55 * dpr);
  cursorGhostPath(ctx, outer);
  const halo = ctx.createLinearGradient(0, 0, 8 * outer, 16 * outer);
  if (dark) {
    halo.addColorStop(0, rgba("232,242,255", 0.055 * reflection));
    halo.addColorStop(0.55, rgba("204,224,248", 0.024 * reflection));
    halo.addColorStop(1, "rgba(180,205,238,0)");
  } else {
    halo.addColorStop(0, rgba("15,23,42", 0.032 * reflection));
    halo.addColorStop(1, "rgba(15,23,42,0)");
  }
  ctx.fillStyle = halo;
  ctx.fill();
  ctx.restore();

  const inner = 1.04 * dpr;
  ctx.save();
  ctx.translate(rx, ry);
  cursorGhostPath(ctx, inner);
  const core = ctx.createLinearGradient(0, 0, 7 * inner, 15 * inner);
  if (dark) {
    core.addColorStop(0, rgba("252,254,255", 0.115 * reflection));
    core.addColorStop(0.45, rgba("222,235,252", 0.048 * reflection));
    core.addColorStop(1, rgba("190,210,240", 0.006 * reflection));
  } else {
    core.addColorStop(0, rgba("15,23,42", 0.06 * reflection));
    core.addColorStop(1, "rgba(15,23,42,0.004)");
  }
  ctx.fillStyle = core;
  ctx.fill();
  ctx.restore();
}

function clearEntry(entry: RimEntry) {
  entry.signature = "";
  if (entry.cleared || !entry.canvas || !entry.context) return;
  if (entry.canvas.width > 0 && entry.canvas.height > 0) {
    entry.context.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
  }
  entry.cleared = true;
}

function reclaimEntry(entry: RimEntry) {
  entry.signature = "";
  entry.gradient = null;
  entry.gradientKey = "";
  entry.cleared = true;
  if (entry.canvas && (entry.canvas.width > 0 || entry.canvas.height > 0)) {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }
}

function paintRim(
  entry: RimEntry,
  localX: number,
  localY: number,
  dark: boolean,
  tone: RimTone,
  ambient: number,
) {
  const { canvas, context: ctx, rect } = entry;
  if (!canvas || !ctx || !rect) return;
  const mirror = entry.mode === "mirror";
  const pad = mirror ? 0 : 2;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const w = Math.max(4, Math.round((rect.width + pad) * dpr));
  const h = Math.max(4, Math.round((rect.height + pad) * dpr));
  const cssRadius = entry.borderRadius > 0 ? entry.borderRadius : DEFAULT_RADIUS;
  const alpha = Math.min(1, ambient * (!mirror && tone === "mono" ? 0.58 : 1));
  const signature = `${w}|${h}|${dark}|${entry.mode}|${tone}|${alpha.toFixed(3)}|${cssRadius}`;
  const settled =
    !entry.cleared &&
    canvas.width === w &&
    canvas.height === h &&
    entry.signature === signature &&
    Math.abs(localX - entry.lastX) < MOVE_EPSILON &&
    Math.abs(localY - entry.lastY) < MOVE_EPSILON;
  if (settled) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  entry.cleared = false;
  entry.signature = signature;
  entry.lastX = localX;
  entry.lastY = localY;
  ctx.clearRect(0, 0, w, h);
  const gx = (localX + pad * 0.5) * dpr;
  const gy = (localY + pad * 0.5) * dpr;
  const gr = GRADIENT_RADIUS * dpr;
  const strokeInset = (mirror ? 0.75 : 1) * dpr;
  const rw = Math.max(2, w - strokeInset * 2);
  const rh = Math.max(2, h - strokeInset * 2);
  const rr = Math.min(rw * 0.5, rh * 0.5, cssRadius * dpr);
  const stops = RIM_PALETTES[tone][dark ? "dark" : "light"];

  if (mirror) {
    ctx.save();
    roundedRectPath(ctx, 0, 0, w, h, Math.min(w * 0.5, h * 0.5, cssRadius * dpr));
    ctx.clip();
    const wash = ctx.createRadialGradient(gx, gy, 0, gx, gy, 210 * dpr);
    if (dark) {
      wash.addColorStop(0, rgba("238,245,255", 0.068 * alpha));
      wash.addColorStop(0.42, rgba("206,224,250", 0.026 * alpha));
      wash.addColorStop(0.8, rgba("180,202,238", 0.006 * alpha));
      wash.addColorStop(1, "rgba(180,202,238,0)");
    } else {
      wash.addColorStop(0, rgba("37,99,235", 0.042 * alpha));
      wash.addColorStop(0.5, rgba("37,99,235", 0.014 * alpha));
      wash.addColorStop(1, "rgba(37,99,235,0)");
    }
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);
    drawCursorReflection(ctx, rect, gx, gy, w, h, dpr, dark, alpha, localX, localY);
    ctx.restore();

    const specular = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    if (dark) {
      specular.addColorStop(0, "rgba(255,255,255,0.95)");
      specular.addColorStop(0.24, "rgba(232,240,252,0.56)");
      specular.addColorStop(0.54, "rgba(186,202,228,0.18)");
      specular.addColorStop(0.85, "rgba(148,168,198,0.03)");
      specular.addColorStop(1, "rgba(148,168,198,0)");
    } else {
      specular.addColorStop(0, "rgba(30,64,175,0.52)");
      specular.addColorStop(0.42, "rgba(59,130,246,0.2)");
      specular.addColorStop(1, "rgba(59,130,246,0)");
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    roundedRectPath(ctx, strokeInset, strokeInset, rw, rh, rr);
    ctx.lineWidth = 1.35 * dpr;
    ctx.strokeStyle = specular;
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (entry.mode === "reflect") {
    const below = localY - rect.height;
    const falloff =
      below > 150
        ? Math.max(0, 1 - (below - 150) / 190)
        : localY < 0
          ? Math.max(0, 1 + localY / 80)
          : 1;
    const reflected = alpha * 0.46 * falloff;
    if (reflected <= 0.004) return;
    const sourceY = h + 16 * dpr;
    const radius = Math.max(GRADIENT_RADIUS * 1.15, 220) * dpr;
    const glow = ctx.createRadialGradient(gx, sourceY, 0, gx, sourceY, radius);
    addStops(glow, stops);
    ctx.save();
    ctx.globalAlpha = reflected;
    roundedRectPath(ctx, strokeInset, strokeInset, rw, rh, rr);
    ctx.lineWidth = 1.15 * dpr;
    ctx.strokeStyle = glow;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    roundedRectPath(ctx, strokeInset, strokeInset, rw, rh, rr);
    ctx.clip();
    const washHeight = Math.min(rh, 14 * dpr);
    const wash = ctx.createRadialGradient(
      gx,
      h + 2 * dpr,
      0,
      gx,
      h + 2 * dpr,
      Math.max(radius * 0.72, 160 * dpr),
    );
    const washRgb = dark ? "255,255,255" : "59,130,246";
    wash.addColorStop(0, rgba(washRgb, 0.032 * reflected));
    wash.addColorStop(1, `rgba(${washRgb},0)`);
    ctx.fillStyle = wash;
    ctx.fillRect(0, Math.max(0, h - washHeight), w, washHeight);
    ctx.restore();

    // The reflection only climbs the lower half of the box.
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    const fade = ctx.createLinearGradient(0, h, 0, 0);
    fade.addColorStop(0, "rgba(0,0,0,1)");
    fade.addColorStop(0.22, "rgba(0,0,0,0.68)");
    fade.addColorStop(0.48, "rgba(0,0,0,0)");
    fade.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    return;
  }

  // The gradient is built around the origin and translated to the pointer, so it is reused.
  const gradientKey = `${gr}|${dark}|${tone}`;
  if (entry.gradientKey !== gradientKey || !entry.gradient) {
    entry.gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
    addStops(entry.gradient, stops);
    entry.gradientKey = gradientKey;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(gx, gy);
  roundedRectPath(ctx, strokeInset - gx, strokeInset - gy, rw, rh, rr);
  ctx.lineWidth = 1.45 * dpr;
  ctx.strokeStyle = entry.gradient;
  ctx.stroke();
  ctx.restore();
}

function isInRange(entry: RimEntry, rect: DOMRect, x: number, y: number): boolean {
  if (rect.width < 4 || rect.height < 4) return false;
  if (entry.mode === "reflect") {
    return (
      x >= rect.left - 240 && x <= rect.right + 240 && y >= rect.top - 80 && y <= rect.bottom + 340
    );
  }
  return (
    x >= rect.left - POINTER_REACH &&
    x <= rect.right + POINTER_REACH &&
    y >= rect.top - POINTER_REACH &&
    y <= rect.bottom + POINTER_REACH
  );
}

/** Pointer-tracked chromatic rim on every `[data-optical-prism-box="1"]` element. */
export function createPrismRimController(): PrismRimController {
  const entries = new Map<HTMLElement, RimEntry>();
  const pointer = { x: OFFSCREEN, y: OFFSCREEN };
  let cfg = readOpticalConfig();
  let running = false;
  let blurred = false;
  let raf = 0;
  let reclaimTimer = 0;
  let lastDrawAt = 0;
  let cacheDirty = true;
  let cacheAt = Number.NEGATIVE_INFINITY;
  let lastRectReadAt = 0;
  let unsubscribeConfig: (() => void) | null = null;

  const enabled = () =>
    cfg.motionLevel !== "subtle" && cfg.ambientIntensity > 0.001 && !isOpticalReducedMotion(cfg);
  const pointerInside = () => pointer.x > OFFSCREEN / 2;

  function cancelFrame() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function cancelReclaim() {
    if (reclaimTimer) window.clearTimeout(reclaimTimer);
    reclaimTimer = 0;
  }

  function reclaimAll() {
    cancelReclaim();
    for (const entry of entries.values()) reclaimEntry(entry);
  }

  // A cleared canvas still holds its backing store; drop it once the pointer has stayed away.
  function armReclaim() {
    const holdsCleared = (entry: RimEntry) =>
      entry.cleared && entry.canvas !== null && (entry.canvas.width > 0 || entry.canvas.height > 0);
    if (![...entries.values()].some(holdsCleared)) {
      cancelReclaim();
      return;
    }
    reclaimTimer ||= window.setTimeout(() => {
      reclaimTimer = 0;
      for (const entry of entries.values()) if (entry.cleared) reclaimEntry(entry);
    }, RECLAIM_DELAY_MS);
  }

  function clearAll(immediateReclaim: boolean) {
    for (const entry of entries.values()) {
      clearEntry(entry);
      setFallbackPosition(entry, false, OFFSCREEN, OFFSCREEN);
    }
    if (immediateReclaim) reclaimAll();
    else armReclaim();
  }

  function removeEntry(entry: RimEntry) {
    entry.unobserve();
    entry.canvas?.remove();
    entry.box.removeAttribute(MOUNTED_ATTRIBUTE);
    entry.box.style.removeProperty("--optical-px");
    entry.box.style.removeProperty("--optical-py");
    entries.delete(entry.box);
  }

  function onBoxResize() {
    cacheDirty = true;
    if (!running || blurred || document.hidden || raf || !enabled() || !pointerInside()) return;
    if (![...entries.values()].some((entry) => !entry.cleared)) return;
    lastDrawAt = 0;
    schedule();
  }

  function mountEntry(box: HTMLElement, mode: RimMode, rect: DOMRect | null, borderRadius: number) {
    const canvas = document.createElement("canvas");
    canvas.className = RIM_CLASS;
    canvas.width = 0;
    canvas.height = 0;
    canvas.setAttribute("aria-hidden", "true");
    styleRimCanvas(canvas, mode);
    const context = canvas.getContext("2d");
    if (context) {
      box.append(canvas);
      box.setAttribute(MOUNTED_ATTRIBUTE, "1");
    }
    entries.set(box, {
      box,
      canvas: context ? canvas : null,
      context,
      unobserve: observeResize(box, onBoxResize),
      mode,
      rect,
      borderRadius,
      cleared: true,
      signature: "",
      lastX: OFFSCREEN,
      lastY: OFFSCREEN,
      gradient: null,
      gradientKey: "",
      fallbackX: "",
      fallbackY: "",
    });
  }

  // With no 2D context the stylesheet draws the rim from these custom properties instead.
  function setFallbackPosition(entry: RimEntry, inRange: boolean, x: number, y: number) {
    if (entry.context) return;
    const nextX = inRange ? `${x.toFixed(1)}px` : `${OFFSCREEN}px`;
    const nextY = inRange ? `${y.toFixed(1)}px` : `${OFFSCREEN}px`;
    if (entry.fallbackX !== nextX) {
      entry.fallbackX = nextX;
      entry.box.style.setProperty("--optical-px", nextX);
    }
    if (entry.fallbackY !== nextY) {
      entry.fallbackY = nextY;
      entry.box.style.setProperty("--optical-py", nextY);
    }
  }

  function refreshEntries(now: number, readRects: boolean) {
    // Every layout read happens before the first DOM write, so mounting canvases cannot thrash.
    const measured = [...document.querySelectorAll<HTMLElement>(BOX_SELECTOR)].map((box) => {
      const known = entries.get(box);
      const radius =
        known && known.borderRadius >= 0
          ? known.borderRadius
          : Number.parseFloat(getComputedStyle(box).borderTopLeftRadius);
      return {
        box,
        known,
        mode: readMode(box),
        rect: readRects ? box.getBoundingClientRect() : (known?.rect ?? null),
        borderRadius: Number.isFinite(radius) && radius >= 0 ? radius : DEFAULT_RADIUS,
      };
    });
    const live = new Set(measured.map((item) => item.box));
    for (const entry of entries.values()) {
      if (!live.has(entry.box) || !entry.box.isConnected || entry.canvas?.isConnected === false) {
        removeEntry(entry);
      }
    }
    for (const { box, mode, rect, borderRadius } of measured) {
      const entry = entries.get(box);
      if (!entry) {
        mountEntry(box, mode, rect, borderRadius);
        continue;
      }
      if (entry.mode !== mode) {
        entry.mode = mode;
        entry.signature = "";
        if (entry.canvas) styleRimCanvas(entry.canvas, mode);
      }
      entry.rect = rect;
      entry.borderRadius = borderRadius;
    }
    cacheDirty = false;
    cacheAt = now;
  }

  function flush(frameNow: number) {
    raf = 0;
    if (!running) return;
    if (document.hidden) {
      reclaimAll();
      return;
    }
    if (blurred) return;
    if (!enabled()) {
      clearAll(true);
      return;
    }
    const minGap = resolveMinFrameGapMs(cfg.targetFps);
    if (minGap > 0 && lastDrawAt > 0 && frameNow - lastDrawAt < minGap) {
      schedule();
      return;
    }
    lastDrawAt = frameNow;
    const inside = pointerInside();
    const cacheAge = frameNow - cacheAt;
    const stale =
      cacheDirty ||
      cacheAge > RESCAN_MS ||
      (entries.size === 0 && cacheAge > EMPTY_RESCAN_MS) ||
      [...entries.values()].some(
        (entry) => !entry.box.isConnected || entry.borderRadius < 0 || (inside && !entry.rect),
      );
    if (stale) {
      refreshEntries(frameNow, inside);
      lastRectReadAt = frameNow;
    } else if (inside && frameNow - lastRectReadAt >= RECT_REFRESH_MS) {
      lastRectReadAt = frameNow;
      for (const entry of entries.values()) entry.rect = entry.box.getBoundingClientRect();
    }

    const dark = isDarkTheme();
    const tone = TONE_BY_SPECTRUM[resolveSpectrumMode(cfg, dark)];
    for (const entry of entries.values()) {
      const rect = inside ? entry.rect : null;
      const inRange = rect !== null && isInRange(entry, rect, pointer.x, pointer.y);
      const localX = rect ? pointer.x - rect.left : OFFSCREEN;
      const localY = rect ? pointer.y - rect.top : OFFSCREEN;
      setFallbackPosition(entry, inRange, localX, localY);
      if (inRange) paintRim(entry, localX, localY, dark, tone, cfg.ambientIntensity);
      else clearEntry(entry);
    }
    armReclaim();
  }

  function onPointerMove(event: PointerEvent) {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!running || blurred || raf || document.hidden || !enabled()) return;
    const now = event.timeStamp;
    const cacheAge = now - cacheAt;
    if (entries.size === 0) {
      if (cacheDirty || cacheAge > EMPTY_RESCAN_MS) schedule();
      return;
    }
    const far = (entry: RimEntry) => {
      const rect = entry.rect;
      if (!entry.cleared || !rect) return false;
      return (
        rect.width < 4 ||
        rect.height < 4 ||
        pointer.x < rect.left - FAR_IDLE_REACH ||
        pointer.x > rect.right + FAR_IDLE_REACH ||
        pointer.y < rect.top - FAR_IDLE_REACH ||
        pointer.y > rect.bottom + FAR_IDLE_REACH
      );
    };
    const farIdle =
      !cacheDirty &&
      cacheAge <= FAR_RESCAN_MS &&
      now - lastRectReadAt < RECT_REFRESH_MS &&
      [...entries.values()].every(far);
    if (!farIdle) schedule();
  }

  function onPointerLeave() {
    pointer.x = OFFSCREEN;
    pointer.y = OFFSCREEN;
    if (running && !blurred) schedule();
  }

  function resume() {
    if (!running || document.hidden || blurred || !enabled() || !pointerInside()) return;
    lastDrawAt = 0;
    schedule();
  }

  function onVisibilityChange() {
    if (!document.hidden) {
      resume();
      return;
    }
    cancelFrame();
    reclaimAll();
  }

  function onWindowBlur() {
    blurred = true;
    cancelFrame();
    clearAll(false);
  }

  function onWindowFocus() {
    blurred = false;
    resume();
  }

  function invalidateMetrics() {
    cacheDirty = true;
    for (const entry of entries.values()) entry.borderRadius = -1;
    if (!running) return;
    if (document.hidden || !enabled()) {
      cancelFrame();
      clearAll(true);
      return;
    }
    resume();
  }

  return {
    start() {
      if (running || typeof window === "undefined") return;
      running = true;
      blurred = !document.hasFocus();
      cfg = readOpticalConfig();
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("focus", onWindowFocus);
      document.addEventListener("visibilitychange", onVisibilityChange);
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
      unsubscribeConfig = subscribeOpticalConfig(() => {
        cfg = readOpticalConfig();
        for (const entry of entries.values()) entry.signature = "";
        invalidateMetrics();
      });
    },
    teardown() {
      if (!running) return;
      running = false;
      cancelFrame();
      cancelReclaim();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      unsubscribeConfig?.();
      unsubscribeConfig = null;
      for (const entry of entries.values()) {
        reclaimEntry(entry);
        removeEntry(entry);
      }
      pointer.x = OFFSCREEN;
      pointer.y = OFFSCREEN;
    },
    markDirty() {
      cacheDirty = true;
      if (running && !enabled()) {
        cancelFrame();
        clearAll(true);
      }
    },
    invalidateMetrics,
  };
}
