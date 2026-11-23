export type MotionTier = "off" | "subtle" | "standard" | "ultra";

/** Dispatched on `window` after the `data-optical-*` settings on the root element change. */
export const OPTICAL_SETTINGS_EVENT = "t3:optical-settings-changed";

const SPRING_PRESETS = {
  snappy: { stiffness: 420, damping: 30, mass: 0.9 },
  bouncy: { stiffness: 380, damping: 20, mass: 1 },
  default: { stiffness: 380, damping: 26, mass: 1 },
  gentle: { stiffness: 260, damping: 26, mass: 1.05 },
  micro: { stiffness: 440, damping: 24, mass: 0.85 },
  indicator: { stiffness: 430, damping: 32, mass: 0.9 },
} as const;

type SpringPresetName = keyof typeof SPRING_PRESETS;

export interface SpringParams {
  readonly preset?: SpringPresetName;
  readonly stiffness?: number;
  readonly damping?: number;
  readonly mass?: number;
  readonly velocity?: number;
  readonly restDelta?: number;
  readonly restSpeed?: number;
  readonly sampleCount?: number;
}

export interface SpringSolution {
  readonly easing: string;
  readonly durationMs: number;
  readonly samples: ReadonlyArray<number>;
  readonly solveAt: (seconds: number) => number;
}

type SpringKeyframes = Keyframe[] | PropertyIndexedKeyframes;

interface SpringOptions extends SpringParams {
  /** Animations sharing a slot on one element interrupt each other. */
  readonly slot?: string;
  readonly delay?: number;
  readonly durationMs?: number;
  readonly fill?: FillMode;
  readonly interrupt?: "cancel" | "commit";
  readonly commitOnFinish?: boolean;
  readonly applyReducedFinal?: boolean;
  readonly transformOrigin?: string;
  readonly motionTier?: MotionTier;
}

interface SpringHandle {
  readonly animation: Animation | null;
  readonly durationMs: number;
  readonly easing: string;
  readonly finished: Promise<void>;
  readonly cancel: () => void;
}

const MOTION_TIERS: ReadonlySet<string> = new Set(["off", "subtle", "standard", "ultra"]);
const SPRING_CACHE_LIMIT = 64;
const FALLBACK_BEZIER = "cubic-bezier(0.22, 1.25, 0.36, 1)";
const SUBTLE_DURATION_MS = 120;
const TOKEN_SPRING: SpringParams = { stiffness: 420, damping: 32, mass: 1 };
const LIFTOFF_VEIL_MS = 540;
const HOVER_COOLDOWN_MS = 150;
const MAX_HOVER_ICON_PX = 28;
const MAX_PRESS_WIDTH_PX = 420;
const MAX_PRESS_HEIGHT_PX = 160;

const PRESS_SELECTOR =
  'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
const PRESS_EXCLUDE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  ".monaco-editor",
  ".xterm",
  ".ProseMirror",
  ".cm-editor",
  "[data-no-press-spring]",
  "[data-optical-ignore]",
].join(", ");
const EDITABLE_DESCENDANT_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

const springCache = new Map<string, SpringSolution>();
const slotAnimations = new WeakMap<Element, Map<string, Animation>>();
const hoverCooldown = new WeakMap<Element, number>();

let reducedMotionQuery: MediaQueryList | null = null;
let reducedMotionSource: typeof globalThis.matchMedia | undefined;
let linearEasingSupported: boolean | undefined;
let activeVeil: { readonly element: HTMLElement; readonly timer: number } | null = null;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const finiteOr = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function prefersReducedMotion(): boolean {
  const matchMedia =
    typeof globalThis.matchMedia === "function" ? globalThis.matchMedia : undefined;
  if (matchMedia !== reducedMotionSource) {
    reducedMotionSource = matchMedia;
    reducedMotionQuery = matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  }
  return reducedMotionQuery?.matches === true;
}

/** An unset or unknown `data-optical-motion` reads as "off", so nothing moves until settings are applied. */
export function getMotionTier(): MotionTier {
  if (prefersReducedMotion()) return "off";
  if (typeof document === "undefined") return "off";
  const raw = document.documentElement.dataset.opticalMotion;
  return raw !== undefined && MOTION_TIERS.has(raw) ? (raw as MotionTier) : "off";
}

function resolveTier(options: SpringOptions): MotionTier {
  if (options.motionTier === undefined) return getMotionTier();
  return prefersReducedMotion() ? "off" : options.motionTier;
}

function supportsLinearEasing(): boolean {
  if (linearEasingSupported === undefined) {
    linearEasingSupported =
      typeof CSS !== "undefined" && typeof CSS.supports === "function"
        ? CSS.supports("animation-timing-function", "linear(0, 1)")
        : true;
  }
  return linearEasingSupported;
}

/**
 * Closed-form step response of a damped harmonic oscillator, sampled into a CSS `linear()`
 * easing. The duration is the last moment the spring is still outside its rest thresholds.
 */
export function springLinear(params: SpringParams | SpringPresetName = {}): SpringSolution {
  const input: SpringParams = typeof params === "string" ? { preset: params } : params;
  const preset = input.preset === undefined ? null : SPRING_PRESETS[input.preset];
  const stiffness = clamp(finiteOr(input.stiffness, preset?.stiffness ?? 380), 20, 3000);
  const damping = clamp(finiteOr(input.damping, preset?.damping ?? 26), 1, 400);
  const mass = clamp(finiteOr(input.mass, preset?.mass ?? 1), 0.05, 20);
  const velocity = clamp(finiteOr(input.velocity, 0), -50, 50);
  const restDelta = clamp(finiteOr(input.restDelta, 0.001), 0.0001, 0.05);
  const restSpeed = clamp(finiteOr(input.restSpeed, 0.001), 0.0001, 0.05);
  const sampleCount = Math.round(clamp(finiteOr(input.sampleCount, 40), 12, 96));

  const key = `${stiffness}|${damping}|${mass}|${velocity}|${restDelta}|${restSpeed}|${sampleCount}`;
  const cached = springCache.get(key);
  if (cached) {
    springCache.delete(key);
    springCache.set(key, cached);
    return cached;
  }

  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let position: (t: number) => number;
  let speed: (t: number) => number;
  if (zeta < 1 - 1e-5) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    const b = (velocity - zeta * omega) / omegaD;
    position = (t) =>
      t <= 0
        ? 0
        : 1 + Math.exp(-zeta * omega * t) * (-Math.cos(omegaD * t) + b * Math.sin(omegaD * t));
    speed = (t) => {
      if (t <= 0) return velocity;
      const cos = Math.cos(omegaD * t);
      const sin = Math.sin(omegaD * t);
      return (
        Math.exp(-zeta * omega * t) *
        (-zeta * omega * (-cos + b * sin) + omegaD * sin + b * omegaD * cos)
      );
    };
  } else if (zeta > 1 + 1e-5) {
    const gamma = omega * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega + gamma;
    const r2 = -zeta * omega - gamma;
    const c1 = (velocity + r2) / (2 * gamma);
    const c2 = -1 - c1;
    position = (t) => (t <= 0 ? 0 : 1 + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t));
    speed = (t) => (t <= 0 ? velocity : c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t));
  } else {
    const b = velocity - omega;
    position = (t) => (t <= 0 ? 0 : 1 + Math.exp(-omega * t) * (-1 + b * t));
    speed = (t) => (t <= 0 ? velocity : Math.exp(-omega * t) * (-omega * (-1 + b * t) + b));
  }

  const dt = 1 / 240;
  let settledAt = 0.08;
  for (let t = dt; t <= 3.6; t += dt) {
    if (Math.abs(1 - position(t)) > restDelta || Math.abs(speed(t)) > restSpeed) settledAt = t;
  }
  const seconds = clamp(settledAt + dt, 0.08, 3.6);
  const samples: number[] = [0];
  for (let i = 1; i < sampleCount - 1; i++) {
    samples.push(Number(position((i / (sampleCount - 1)) * seconds).toFixed(4)));
  }
  samples.push(1);

  const solution: SpringSolution = Object.freeze({
    easing: `linear(${samples.join(", ")})`,
    durationMs: Math.round(seconds * 1000),
    samples: Object.freeze(samples),
    solveAt: position,
  });
  if (springCache.size >= SPRING_CACHE_LIMIT) {
    const oldest = springCache.keys().next();
    if (!oldest.done) springCache.delete(oldest.value);
  }
  springCache.set(key, solution);
  return solution;
}

const inertHandle = (durationMs = 0, easing = "linear"): SpringHandle => ({
  animation: null,
  durationMs,
  easing,
  finished: Promise.resolve(),
  cancel: () => {},
});

const SKIPPED_KEYFRAME_KEYS: ReadonlySet<string> = new Set(["offset", "easing", "composite"]);

function writeFinalKeyframe(element: Element, keyframes: SpringKeyframes): void {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;
  const final: Record<string, unknown> = {};
  if (Array.isArray(keyframes)) {
    Object.assign(final, keyframes[keyframes.length - 1]);
  } else {
    for (const [property, value] of Object.entries(keyframes)) {
      final[property] = Array.isArray(value) ? value[value.length - 1] : value;
    }
  }
  for (const [property, value] of Object.entries(final)) {
    if (SKIPPED_KEYFRAME_KEYS.has(property) || value === null || value === undefined) continue;
    const cssName = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    element.style.setProperty(cssName, String(value));
  }
}

function endpointFrames(keyframes: SpringKeyframes): SpringKeyframes {
  if (!Array.isArray(keyframes) || keyframes.length <= 2) return keyframes;
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  return first && last ? [first, last] : keyframes;
}

/**
 * Plays keyframes through WAAPI with a solved spring easing. Tier "off" skips the animation
 * and writes the end state only where the animation would have left one behind (a forwards
 * fill); tier "subtle" plays a 120ms ease-out between the first and last keyframe.
 */
function spring(
  element: Element | null | undefined,
  keyframes: SpringKeyframes,
  options: SpringOptions = {},
): SpringHandle {
  if (!element) return inertHandle();
  const tier = resolveTier(options);
  const slot = options.slot ?? "default";
  let slots = slotAnimations.get(element);
  if (!slots) {
    slots = new Map();
    slotAnimations.set(element, slots);
  }
  const previous = slots.get(slot);
  if (previous) {
    try {
      if (options.interrupt === "commit") previous.commitStyles();
      previous.cancel();
    } catch {
      // commitStyles throws for an element that is no longer rendered; the cancel still applies.
    }
    slots.delete(slot);
  }
  if (
    options.transformOrigin !== undefined &&
    (element instanceof HTMLElement || element instanceof SVGElement)
  ) {
    element.style.transformOrigin = options.transformOrigin;
  }

  const fill = options.fill ?? "none";
  const persists = fill === "forwards" || fill === "both";
  if (tier === "off") {
    if (persists || options.applyReducedFinal === true) writeFinalKeyframe(element, keyframes);
    return inertHandle(0, "step-end");
  }

  const subtle = tier === "subtle";
  const solved = subtle ? null : springLinear(options);
  const durationMs =
    solved === null
      ? SUBTLE_DURATION_MS
      : options.durationMs !== undefined && Number.isFinite(options.durationMs)
        ? Math.max(16, Math.round(options.durationMs))
        : solved.durationMs;
  const easing =
    solved === null ? "ease-out" : supportsLinearEasing() ? solved.easing : FALLBACK_BEZIER;
  const frames = subtle ? endpointFrames(keyframes) : keyframes;
  const delay = Math.max(0, finiteOr(options.delay, 0));

  if (typeof element.animate !== "function") {
    if (persists) writeFinalKeyframe(element, frames);
    return inertHandle(durationMs, easing);
  }
  let animation: Animation;
  try {
    animation = element.animate(frames, { duration: durationMs, delay, easing, fill });
  } catch {
    try {
      animation = element.animate(frames, {
        duration: Math.min(durationMs, 360),
        delay,
        easing: subtle ? "ease-out" : FALLBACK_BEZIER,
        fill,
      });
    } catch {
      if (persists) writeFinalKeyframe(element, frames);
      return inertHandle(durationMs, easing);
    }
  }

  const ownedSlots = slots;
  ownedSlots.set(slot, animation);
  const release = () => {
    if (ownedSlots.get(slot) === animation) ownedSlots.delete(slot);
  };
  const finished = animation.finished.then(() => {
    release();
    if (options.commitOnFinish !== true) return;
    try {
      animation.commitStyles();
      animation.cancel();
    } catch {
      // The element left the document mid-flight; there is nothing to commit to.
    }
  }, release);
  return {
    animation,
    durationMs,
    easing,
    finished,
    cancel: () => {
      animation.cancel();
      release();
    },
  };
}

/** Publishes the house spring as `--optical-spring-ease` / `--optical-spring-dur` for plain CSS transitions. */
export function syncOpticalSpringTokens(root?: HTMLElement): void {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!target) return;
  const solved = springLinear(TOKEN_SPRING);
  target.style.setProperty(
    "--optical-spring-ease",
    supportsLinearEasing() ? solved.easing : FALLBACK_BEZIER,
  );
  target.style.setProperty("--optical-spring-dur", `${solved.durationMs}ms`);
}

/** Bursts a one-shot prism ring from a viewport point. Tier "ultra" only; removes itself. */
export function triggerLiftoffVeil(originX: number, originY: number): void {
  if (typeof document === "undefined" || getMotionTier() !== "ultra") return;
  if (activeVeil) {
    window.clearTimeout(activeVeil.timer);
    activeVeil.element.remove();
    activeVeil = null;
  }
  const veil = document.createElement("div");
  veil.className = "optical-liftoff-veil";
  veil.setAttribute("aria-hidden", "true");
  veil.style.setProperty("--optical-lift-x", `${Math.round(originX)}px`);
  veil.style.setProperty("--optical-lift-y", `${Math.round(originY)}px`);
  const ring = document.createElement("div");
  ring.className = "optical-liftoff-ring";
  veil.append(ring);
  document.body.append(veil);
  const timer = window.setTimeout(() => {
    veil.remove();
    if (activeVeil?.element === veil) activeVeil = null;
  }, LIFTOFF_VEIL_MS);
  activeVeil = { element: veil, timer };
}

const isDisabled = (element: Element) =>
  element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";

function findPressTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(PRESS_EXCLUDE_SELECTOR)) return null;
  const hit = target.closest(PRESS_SELECTOR);
  if (!(hit instanceof HTMLElement) || isDisabled(hit)) return null;
  if (hit.querySelector(EDITABLE_DESCENDANT_SELECTOR)) return null;
  const box = hit.getBoundingClientRect();
  if (box.width > MAX_PRESS_WIDTH_PX || box.height > MAX_PRESS_HEIGHT_PX) return null;
  return hit;
}

function findHoverIcon(target: EventTarget | null, timeStamp: number): SVGElement | null {
  if (!(target instanceof Element)) return null;
  const host = target.closest(PRESS_SELECTOR);
  if (!host || isDisabled(host) || host.closest(PRESS_EXCLUDE_SELECTOR)) return null;
  if (timeStamp - (hoverCooldown.get(host) ?? -Infinity) < HOVER_COOLDOWN_MS) return null;
  const icon = host.querySelector("svg");
  if (!icon) return null;
  const box = icon.getBoundingClientRect();
  if (box.width <= 0 || box.width > MAX_HOVER_ICON_PX || box.height > MAX_HOVER_ICON_PX) {
    return null;
  }
  hoverCooldown.set(host, timeStamp);
  return icon;
}

const isLivelyTier = () => {
  const tier = getMotionTier();
  return tier === "standard" || tier === "ultra";
};

// The `scale` property composes with a spinner's own rotating `transform` instead of replacing it.
const springIcon = (icon: SVGElement) =>
  spring(icon, [{ scale: "1" }, { scale: "1.12" }, { scale: "1" }], {
    stiffness: 420,
    damping: 22,
    mass: 0.85,
    slot: "micro",
  });

/**
 * Delegated press and icon springs for every button-like control in a window. Returns a
 * teardown that removes the listeners.
 */
export function bindMicroInteractions(win?: Window): () => void {
  const target = win ?? (typeof window === "undefined" ? null : window);
  if (!target) return () => {};

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !isLivelyTier()) return;
    const button = findPressTarget(event.target);
    if (!button) return;
    const inline = button.style.transform.trim();
    // An inline non-scale transform is positioning the control, so animate `scale` beside it.
    const keepsTransform = inline !== "" && inline !== "none" && !/^scale\([^)]+\)$/.test(inline);
    spring(
      button,
      keepsTransform
        ? [{ scale: "1" }, { scale: "0.965" }, { scale: "1" }]
        : [{ transform: "scale(1)" }, { transform: "scale(0.965)" }, { transform: "scale(1)" }],
      { stiffness: 520, damping: 30, mass: 0.72, slot: "btn-press" },
    );
  };

  const onPointerOver = (event: PointerEvent) => {
    if (!(event.target instanceof Element)) return;
    const host = event.target.closest(PRESS_SELECTOR);
    if (!host) return;
    if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
    if (!isLivelyTier()) return;
    const icon = findHoverIcon(host, event.timeStamp);
    if (icon) springIcon(icon);
  };

  const onFocusIn = (event: FocusEvent) => {
    if (!(event.target instanceof Element) || !event.target.matches(":focus-visible")) return;
    if (!isLivelyTier()) return;
    const icon = findHoverIcon(event.target, event.timeStamp);
    if (icon) springIcon(icon);
  };

  const listenerOptions = { passive: true } as const;
  target.addEventListener("pointerdown", onPointerDown, listenerOptions);
  target.addEventListener("pointerover", onPointerOver, listenerOptions);
  target.addEventListener("focusin", onFocusIn, listenerOptions);
  return () => {
    target.removeEventListener("pointerdown", onPointerDown);
    target.removeEventListener("pointerover", onPointerOver);
    target.removeEventListener("focusin", onFocusIn);
  };
}
