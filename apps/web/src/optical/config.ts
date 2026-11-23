import { useSyncExternalStore } from "react";

export type OpticalMotionLevel = "off" | "subtle" | "standard" | "ultra";
export type OpticalTargetFps = "60" | "120" | "180" | "native";
export type OpticalSpectrum = "follow" | "cobalt" | "iris" | "amber" | "mono";
export type OpticalMascotMode = "crab" | "minis" | "off";
/** 0 default, 1 warm, 2 cobalt, 3 iris, 4 amber, 5 mono. */
export type OpticalSpectrumCode = 0 | 1 | 2 | 3 | 4 | 5;
export type Rgb = readonly [number, number, number];

export interface OpticalRuntimeConfig {
  readonly motionLevel: OpticalMotionLevel;
  readonly ambientIntensity: number;
  readonly targetFps: OpticalTargetFps;
  readonly homeRipple: boolean;
  readonly smoothCaret: boolean;
  readonly spectrum: OpticalSpectrum;
  readonly mascot: OpticalMascotMode;
}

interface ThemeRippleColors {
  readonly ink: Rgb;
  readonly wave: Rgb;
}

const OPTICAL_SETTINGS_EVENT = "t3:optical-settings-changed";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MOTION_LEVELS = ["off", "subtle", "standard", "ultra"] as const;
const TARGET_FPS = ["60", "120", "180", "native"] as const;
const SPECTRA = ["follow", "cobalt", "iris", "amber", "mono"] as const;
const MASCOT_MODES = ["crab", "minis", "off"] as const;
const OBSERVED_ROOT_ATTRIBUTES = [
  "class",
  "data-theme-id",
  "data-optical-motion",
  "data-optical-ambient",
  "data-optical-fps",
  "data-optical-home-ripple",
  "data-optical-smooth-caret",
  "data-optical-spectrum",
  "data-optical-mascot",
];
const WARM_THEME_PATTERN = /^(?:ember|claude)$|^warm(?:-|$)/u;
const FALLBACK_MONO_FONT = "ui-monospace, Consolas, monospace";

const DEFAULT_CONFIG: OpticalRuntimeConfig = {
  motionLevel: "ultra",
  ambientIntensity: 1,
  targetFps: "120",
  homeRipple: true,
  smoothCaret: true,
  spectrum: "follow",
  mascot: "crab",
};

const INK_FALLBACK_DARK: Rgb = [146, 148, 156];
const WAVE_FALLBACK_DARK: Rgb = [214, 218, 228];
const INK_FALLBACK_LIGHT: Rgb = [85, 102, 130];
const WAVE_FALLBACK_LIGHT: Rgb = [37, 99, 235];
// An explicit spectrum outranks the theme accent on light surfaces, where the wave carries the hue.
const LIGHT_WAVE_BY_SPECTRUM: Partial<Record<OpticalSpectrumCode, Rgb>> = {
  2: [37, 99, 235],
  3: [124, 58, 237],
  4: [217, 119, 6],
  5: [51, 65, 85],
};

function oneOf<T extends string>(allowed: readonly T[], raw: string | undefined, fallback: T): T {
  return allowed.find((value) => value === raw) ?? fallback;
}

/** Accepts a 0..1 scale or a 0..100 percentage. */
function parseAmbientScale(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 1;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  if (value <= 0) return 0;
  return Math.min(1, value > 1 ? value / 100 : value);
}

export function readOpticalConfig(): OpticalRuntimeConfig {
  if (typeof document === "undefined") return DEFAULT_CONFIG;
  const data = document.documentElement.dataset;
  return {
    motionLevel: oneOf(MOTION_LEVELS, data.opticalMotion, DEFAULT_CONFIG.motionLevel),
    ambientIntensity: parseAmbientScale(data.opticalAmbient),
    targetFps: oneOf(TARGET_FPS, data.opticalFps, DEFAULT_CONFIG.targetFps),
    homeRipple: data.opticalHomeRipple !== "0",
    smoothCaret: data.opticalSmoothCaret !== "0",
    spectrum: oneOf(SPECTRA, data.opticalSpectrum, DEFAULT_CONFIG.spectrum),
    mascot: oneOf(MASCOT_MODES, data.opticalMascot, DEFAULT_CONFIG.mascot),
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

export function isOpticalReducedMotion(cfg: OpticalRuntimeConfig): boolean {
  return cfg.motionLevel === "off" || prefersReducedMotion();
}

/** The OS reduced-motion preference demotes living motion to a static frame. */
export function resolveEffectiveMotionLevel(cfg: OpticalRuntimeConfig): OpticalMotionLevel {
  if (cfg.motionLevel === "off") return "off";
  return prefersReducedMotion() ? "subtle" : cfg.motionLevel;
}

export function resolveMinFrameGapMs(fps: OpticalTargetFps): number {
  switch (fps) {
    case "native":
      return 0;
    case "180":
      return 4.8;
    case "120":
      return 7.5;
    case "60":
      return 15.2;
  }
}

export function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export function resolveSpectrumMode(
  cfg: OpticalRuntimeConfig,
  _isDark: boolean,
): OpticalSpectrumCode {
  switch (cfg.spectrum) {
    case "cobalt":
      return 2;
    case "iris":
      return 3;
    case "amber":
      return 4;
    case "mono":
      return 5;
    case "follow": {
      if (typeof document === "undefined") return 0;
      return WARM_THEME_PATTERN.test(document.documentElement.dataset.themeId ?? "") ? 1 : 0;
    }
  }
}

function parseSimpleCssColor(color: string): Rgb | null {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const wide = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join("") : hex;
    if (wide.length < 6) return null;
    const channels = [0, 2, 4].map((at) => Number.parseInt(wide.slice(at, at + 2), 16));
    const [r, g, b] = channels;
    if (r === undefined || g === undefined || b === undefined) return null;
    return channels.every(Number.isFinite) ? [r, g, b] : null;
  }
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/iu.exec(color);
  if (!match) return null;
  return [Math.round(Number(match[1])), Math.round(Number(match[2])), Math.round(Number(match[3]))];
}

const resolvedColors = new Map<string, Rgb | null>();
let colorProbe: CanvasRenderingContext2D | null | undefined;

// Theme tokens are oklch or color-mix; only a canvas resolves every CSS color to sRGB bytes.
function rasterizeCssColor(color: string): Rgb | null {
  if (colorProbe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorProbe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!colorProbe) return null;
  const sentinel = "#010203";
  colorProbe.fillStyle = sentinel;
  colorProbe.fillStyle = color;
  if (colorProbe.fillStyle === sentinel && color !== sentinel) return null;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined || !a) return null;
  return [r, g, b];
}

function cssColorToRgb(color: string): Rgb | null {
  const cached = resolvedColors.get(color);
  if (cached !== undefined) return cached;
  const resolved = parseSimpleCssColor(color) ?? rasterizeCssColor(color);
  if (resolvedColors.size > 48) resolvedColors.clear();
  resolvedColors.set(color, resolved);
  return resolved;
}

function readThemeColor(style: CSSStyleDeclaration, variable: string): Rgb | null {
  const value = style.getPropertyValue(variable).trim();
  return value === "" ? null : cssColorToRgb(value);
}

/** Ink follows the muted text token; the wave follows foreground on dark and the accent on light. */
export function resolveThemeRippleColors(
  isDark: boolean,
  spectrumCode: OpticalSpectrumCode = 0,
): ThemeRippleColors {
  const inkFallback = isDark ? INK_FALLBACK_DARK : INK_FALLBACK_LIGHT;
  const waveFallback = isDark ? WAVE_FALLBACK_DARK : WAVE_FALLBACK_LIGHT;
  if (typeof document === "undefined") return { ink: inkFallback, wave: waveFallback };
  const style = getComputedStyle(document.documentElement);
  const spectrumWave = isDark ? undefined : LIGHT_WAVE_BY_SPECTRUM[spectrumCode];
  const ink = readThemeColor(style, "--muted-foreground") ?? inkFallback;
  const wave =
    spectrumWave ?? readThemeColor(style, isDark ? "--foreground" : "--primary") ?? waveFallback;
  // Neutral and cobalt light surfaces lean the ink and wave toward a cool slate blue.
  if (isDark || (spectrumCode !== 0 && spectrumCode !== 2)) return { ink, wave };
  return {
    ink: mixRgb(ink, LIGHT_INK_COOL, LIGHT_COOL_MIX),
    wave: mixRgb(wave, LIGHT_WAVE_COOL, LIGHT_COOL_MIX * 0.65),
  };
}

const LIGHT_INK_COOL: Rgb = [74, 90, 118];
const LIGHT_WAVE_COOL: Rgb = [37, 99, 235];
const LIGHT_COOL_MIX = 0.68;

function mixRgb(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ];
}

export function resolveOpticalMonoFont(): string {
  if (typeof document === "undefined") return FALLBACK_MONO_FONT;
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  return font === "" ? FALLBACK_MONO_FONT : font;
}

/** Layer opacity paired with each ambient step, on top of the in-shader scaling. */
export function ambientLayerOpacity(ambient: number): number {
  if (ambient >= 1) return 1;
  if (ambient > 0.5) return 0.72;
  return ambient > 0 ? 0.38 : 0;
}

const listeners = new Set<() => void>();
let detachSources: (() => void) | null = null;

function attachSources(): () => void {
  const notify = () => {
    for (const listener of listeners) listener();
  };
  window.addEventListener(OPTICAL_SETTINGS_EVENT, notify);
  const media =
    typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
  media?.addEventListener("change", notify);
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: OBSERVED_ROOT_ATTRIBUTES,
  });
  return () => {
    window.removeEventListener(OPTICAL_SETTINGS_EVENT, notify);
    media?.removeEventListener("change", notify);
    observer.disconnect();
  };
}

/** Fires on settings changes, reduced-motion changes, and theme switches. */
export function subscribeOpticalConfig(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(listener);
  detachSources ??= attachSources();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    detachSources?.();
    detachSources = null;
  };
}

let snapshot = DEFAULT_CONFIG;
let snapshotKey = "";

function readConfigSnapshot(): OpticalRuntimeConfig {
  const next = readOpticalConfig();
  const key = `${next.motionLevel}|${next.ambientIntensity}|${next.targetFps}|${next.homeRipple}|${next.smoothCaret}|${next.spectrum}|${next.mascot}`;
  if (key !== snapshotKey) {
    snapshotKey = key;
    snapshot = next;
  }
  return snapshot;
}

export function useOpticalConfig(): OpticalRuntimeConfig {
  return useSyncExternalStore(subscribeOpticalConfig, readConfigSnapshot, () => DEFAULT_CONFIG);
}
