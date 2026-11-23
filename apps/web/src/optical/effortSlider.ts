import type { OpticalMotionLevel, OpticalSpectrum } from "./config";

export interface EffortMotionParams {
  readonly maxSpeed: number;
  readonly accel: number;
  readonly decel: number;
  readonly snapEps: number;
  readonly velEps: number;
}

/** Track fractions per second; "fast" lands a one-step move in about 70ms. */
const MOTION_FULL: EffortMotionParams = {
  maxSpeed: 3.2,
  accel: 28,
  decel: 18,
  snapEps: 0.0015,
  velEps: 0.01,
};
const MOTION_FAST: EffortMotionParams = {
  maxSpeed: 18,
  accel: 260,
  decel: 180,
  snapEps: 0.002,
  velEps: 0.04,
};
const MOTION_INSTANT: EffortMotionParams = {
  maxSpeed: 1e6,
  accel: 1e9,
  decel: 1e9,
  snapEps: 1e-4,
  velEps: 1e6,
};

export function effortMotionParams(level: OpticalMotionLevel): EffortMotionParams {
  switch (level) {
    case "off":
      return MOTION_INSTANT;
    case "ultra":
      return MOTION_FULL;
    default:
      return MOTION_FAST;
  }
}

export interface EffortMotionState {
  x: number;
  v: number;
  target: number;
}

export const clamp01 = (value: number) =>
  !Number.isFinite(value) || value <= 0 ? 0 : value >= 1 ? 1 : value;

export function pctFromIndex(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(index))) / (count - 1);
}

export function indexFromPct(pct: number, count: number): number {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(clamp01(pct) * (count - 1))));
}

/** Ratchet: a third of a step forward switches level, two thirds back switches it back. */
export function detentTargetIndex(currentIndex: number, pointerPct: number, count: number): number {
  if (count <= 1) return 0;
  const p = clamp01(pointerPct);
  if (currentIndex < 0 || currentIndex >= count) return indexFromPct(p, count);
  const step = 1 / (count - 1);
  let index = currentIndex;
  if (p >= index * step) {
    while (index < count - 1 && p >= (index + 1 / 3) * step - 1e-9) index += 1;
  } else {
    while (index > 0 && p <= (index - 1 / 3) * step + 1e-9) index -= 1;
  }
  return index;
}

export function motionSettled(state: EffortMotionState, params: EffortMotionParams): boolean {
  return Math.abs(state.target - state.x) <= params.snapEps && Math.abs(state.v) <= params.velEps;
}

/** Chases the target at bounded speed, braking on v²/2a so it lands without overshoot. */
export function motionStep(
  state: EffortMotionState,
  dtSeconds: number,
  params: EffortMotionParams,
): void {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
  const dt = Math.min(dtSeconds, 0.05);
  const target = clamp01(state.target);
  const x = clamp01(state.x);
  const v = state.v;
  const diff = target - x;
  const dist = Math.abs(diff);
  if (dist <= params.snapEps && Math.abs(v) <= params.velEps) {
    state.x = target;
    state.v = 0;
    return;
  }
  const dir = diff >= 0 ? 1 : -1;
  const braking = v * dir >= 0 && (v * v) / (2 * params.decel) >= dist;
  const a = braking ? -dir * params.decel : dir * params.accel;
  const nextV = Math.max(-params.maxSpeed, Math.min(params.maxSpeed, v + a * dt));
  const nextX = x + nextV * dt;
  if ((target - x) * (target - nextX) <= 0) {
    state.x = target;
    state.v = 0;
    return;
  }
  if (nextX <= 0) {
    state.x = 0;
    state.v = Math.max(0, nextV);
  } else if (nextX >= 1) {
    state.x = 1;
    state.v = Math.min(0, nextV);
  } else {
    state.x = nextX;
    state.v = nextV;
  }
}

const RELEASE_PROJECTION_SEC = 0.09;
const POINTER_SETTLE_SEC = 0.05;
const POINTER_DECAY_TAU_SEC = 0.035;

/** A flick carries the knob on by its release speed; a held pointer lands where it rests. */
export function releaseIndexFor(
  pointerPct: number,
  pctPerSecond: number,
  idleSeconds: number,
  count: number,
): number {
  const decay =
    idleSeconds <= POINTER_SETTLE_SEC
      ? 1
      : Math.exp(-(idleSeconds - POINTER_SETTLE_SEC) / POINTER_DECAY_TAU_SEC);
  return indexFromPct(pointerPct + pctPerSecond * decay * RELEASE_PROJECTION_SEC, count);
}

const OFF_LEVEL_IDS = new Set(["off", "none", "disabled"]);

/** Energy, stars, and the violet ramp start after an Off level, so Off stays plain blue. */
export function effortEnergyStart(levelIds: ReadonlyArray<string>): number {
  const count = levelIds.length;
  if (count <= 1) return 0;
  return OFF_LEVEL_IDS.has((levelIds[0] ?? "").toLowerCase()) ? 1 / (count - 1) : 0;
}

export function energyForPct(pct: number, start: number): number {
  const p = clamp01(pct);
  if (p <= start || start >= 1) return 0;
  return clamp01((p - start) / (1 - start));
}

type EffortTone = OpticalSpectrum;

const TONE_RAMPS: Record<EffortTone, readonly [string, string, string]> = {
  follow: ["#4d93f8", "#9333ea", "#4c1d95"],
  cobalt: ["#1d4ed8", "#2563eb", "#0284c7"],
  iris: ["#6d28d9", "#8b5cf6", "#a855f7"],
  amber: ["#b45309", "#d97706", "#f59e0b"],
  mono: ["#71717a", "#a1a1aa", "#d4d4d8"],
};

const TONE_VALUE: Record<EffortTone, readonly [string, string] | null> = {
  follow: ["#4d93f8", "#8b5cf6"],
  cobalt: ["#2563eb", "#38bdf8"],
  iris: ["#8b5cf6", "#a78bfa"],
  amber: ["#d97706", "#f59e0b"],
  mono: null,
};

function parseHex(hex: string): readonly [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  const k = clamp01(t);
  const from = parseHex(a);
  const to = parseHex(b);
  const channel = (i: 0 | 1 | 2) => Math.round(from[i] + (to[i] - from[i]) * k);
  return `#${((1 << 24) | (channel(0) << 16) | (channel(1) << 8) | channel(2)).toString(16).slice(1)}`;
}

/** Blue through violet to deep indigo; the midpoint of the energized range is pure violet. */
export function fillColorFor(pct: number, start: number, tone: EffortTone): string {
  const [low, mid, high] = TONE_RAMPS[tone];
  const p = clamp01(pct);
  const end = (start + 1) / 2;
  if (p <= start + 1e-6) return low;
  if (p <= end + 1e-6) return mixHex(low, mid, (p - start) / Math.max(1e-6, end - start));
  return mixHex(mid, high, (p - end) / Math.max(1e-6, 1 - end));
}

export function fillBackgroundFor(pct: number, start: number, tone: EffortTone): string {
  const p = clamp01(pct);
  const [low, mid] = TONE_RAMPS[tone];
  const edge = fillColorFor(p, start, tone);
  if (tone !== "follow") return `linear-gradient(90deg, ${low} 0%, ${edge} 100%)`;
  if (p <= start + 1e-6) return low;
  const startStop = start > 0 ? Math.round((start / p) * 100) : 0;
  const head = `linear-gradient(90deg, ${low} 0%,${startStop > 0 ? ` ${low} ${startStop}%,` : ""}`;
  const end = (start + 1) / 2;
  return p <= end + 1e-6
    ? `${head} ${edge} 100%)`
    : `${head} ${mid} ${Math.round((end / p) * 100)}%, ${edge} 100%)`;
}

/** The head's value color; the top level always takes the bright end. */
export function valueColorFor(
  index: number,
  count: number,
  isOff: boolean,
  hasOffFirst: boolean,
  tone: EffortTone,
): string | null {
  const ramp = TONE_VALUE[tone];
  if (!ramp || isOff || count <= 1) return null;
  const [low, high] = ramp;
  if (index >= count - 1) return high;
  const first = hasOffFirst ? 1 : 0;
  if (tone === "follow" && index <= first) return low;
  return mixHex(low, high, clamp01((index - first) / Math.max(1, count - 1 - first)));
}

const PARTICLE_COUNT = 22;
const GOLDEN_RATIO = 0.6180339887498949;
const STAR_MEAN_SEC = 1.5;
const STAR_SPREAD = 0.08;
const MAX_SPEED_FACTOR = 2;

/** Deterministic hash, so the starfield is identical on every render. */
function starHash01(index: number, salt: number): number {
  const value = ((index + 1) * salt * 2654435761) % 4294967296;
  return ((value >>> 8) % 1000) / 1000;
}

export interface EffortStar {
  readonly id: number;
  /** Percent from the track's top. */
  readonly y: number;
  readonly phase: number;
  readonly brightness: number;
}

const Y_SLOTS = [10, 21, 1, 8, 19, 6, 17, 4, 15, 2, 13, 20, 0, 11, 18, 9, 16, 7, 14, 5, 12, 3];

export const EFFORT_STARS: ReadonlyArray<EffortStar> = (() => {
  const base = Array.from({ length: PARTICLE_COUNT }, (_, id) => ({
    id,
    phase: ((id + 1) * GOLDEN_RATIO) % 1,
    brightness: Math.round((0.5 + 0.5 * starHash01(id, 61)) * 1000) / 1000,
  }));
  const byPhase = base.map((star) => star.id).toSorted((a, b) => base[a]!.phase - base[b]!.phase);
  const y = new Array<number>(PARTICLE_COUNT).fill(0);
  byPhase.forEach((id, rank) => {
    y[id] = Math.round((8 + ((Y_SLOTS[rank] ?? 0) / (PARTICLE_COUNT - 1)) * 84) * 100) / 100;
  });
  return base.map((star) => ({ ...star, y: y[star.id] ?? 50 }));
})();

/** Stars cross faster as energy rises: from about 8.6s at the threshold to 1.5s at the top. */
export function starTiming(id: number, energy: number): { duration: number; delay: number } {
  const speed = Math.min(MAX_SPEED_FACTOR, Math.max(0.35, 2 * energy));
  const duration =
    ((STAR_MEAN_SEC * MAX_SPEED_FACTOR) / speed) *
    (1 - STAR_SPREAD + 2 * STAR_SPREAD * starHash01(id, 29));
  const phase = EFFORT_STARS[id]?.phase ?? 0;
  return { duration, delay: -((phase + starHash01(id, 53) * 0.03) % 1) * duration };
}

export function visibleStarCount(energy: number): number {
  return Math.round(clamp01(energy) * PARTICLE_COUNT);
}

export function starLayerOpacity(energy: number): number {
  return energy <= 0 ? 0 : Math.round((0.6 + 0.4 * energy) * 1000) / 1000;
}
