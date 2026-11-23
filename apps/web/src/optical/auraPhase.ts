import type { OpticalMotionLevel } from "./config";

export type AuraPhase =
  | "idle"
  | "start"
  | "running"
  | "awaiting-decision"
  | "decision-clear"
  | "error-halted"
  | "complete"
  | "long-task-complete"
  | "focus-fade";

/** 0 none, 1 awaiting decision (amber), 2 error halted (coral), 3 long task complete (jade). */
export type AuraSemantic = 0 | 1 | 2 | 3;

export const AURA_TIMING = {
  START_MS: 1150,
  COMPLETE_MS: 1400,
  IDLE_SLEEP_MS: 1200,
  DECISION_BREATH_MS: 1600,
  DECISION_CLEAR_MS: 400,
  ERROR_MS: 900,
  LONG_TASK_MS: 15000,
  LONG_COMPLETE_MS: 1200,
  FOCUS_FADE_MS: 600,
  LIFTOFF_EBB_MS: 520,
} as const;

const AURA_HEIGHT_RATIO = 0.32;
export const HORIZON_STRETCH = 0.6;
export const HORIZON_STATIC_FLOW_SEC = 2.4;
export const HORIZON_STATIC_BREATH = 0.64;
export const HORIZON_TIME_OFFSET_SEC = 12;

const SEMANTIC_CROSSFADE_SEC = 0.45;
const MAX_FLOW_STEP_SEC = 0.35;
const RUNNING_GAP_GPU_MS = 33;
const RUNNING_GAP_FALLBACK_MS = 50;

export function horizonBreath(flowSec: number): number {
  return 0.46 + 0.24 * Math.sin(flowSec * 1.15) + 0.06 * Math.sin(flowSec * 2.05 + 0.9);
}

export function horizonPresenceGain(strength: number): number {
  if (strength <= 0) return 0;
  return strength >= 0.999 ? 1 : strength ** 0.78;
}

export function advanceSemanticMix(mix: number, target: 0 | 1, dtSec: number): number {
  const next = mix + (target - mix) * Math.min(1, Math.max(0.04, dtSec / SEMANTIC_CROSSFADE_SEC));
  return Math.abs(target - next) < 0.01 ? target : next;
}

/** The shader reads the integer part as the tone and the fraction as how far it has faded out. */
export function encodeSemanticUniform(hold: number, mix: number): number {
  return hold > 0 && mix > 0.005 ? hold + (1 - mix) * 0.98 : 0;
}

export interface AuraState {
  readonly phase: AuraPhase;
  readonly phaseAt: number;
  readonly wasRunning: boolean;
  readonly runStartedAt: number | null;
  readonly liftoffAt: number | null;
  readonly unfocusedHold: boolean;
  readonly pendingErrorClear: boolean;
  readonly errorSeen: boolean;
  readonly flowSec: number;
  readonly flowAt: number | null;
  readonly semanticMix: number;
  readonly semanticHold: AuraSemantic;
}

export interface AuraInputs {
  readonly running: boolean;
  readonly awaitingDecision: boolean;
  readonly hasError: boolean;
  /** Run start on the same clock as `nowMs`, when the host knows it. */
  readonly runStartedAt: number | null;
  readonly windowFocused: boolean;
}

export interface AuraFrameEnv {
  readonly isDark: boolean;
  readonly ambientScale: number;
  readonly motionLevel: OpticalMotionLevel;
  readonly hidden: boolean;
  readonly windowFocused: boolean;
  readonly gpu: boolean;
  readonly minFrameGapMs: number;
}

export interface AuraFrame {
  readonly state: AuraState;
  readonly timeSec: number;
  readonly intensity: number;
  readonly reach: number;
  readonly stretch: number;
  readonly presence: number;
  readonly prism: number;
  readonly surge: number;
  readonly speed: number;
  readonly semantic: number;
  readonly staticSnapshot: boolean;
  readonly shouldSleep: boolean;
  readonly clearCanvas: boolean;
  /** Delay before the next frame; 0 while asleep. */
  readonly nextFrameMs: number;
}

interface AuraOptics {
  readonly strength: number;
  readonly reach: number;
  readonly prism: number;
  readonly surge: number;
  readonly speed: number;
  readonly semantic: AuraSemantic;
  readonly frameMs: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const easeOut = (p: number, power: number) => 1 - (1 - p) ** power;

// Reach is authored against the full viewport; the aura host covers only its bottom band.
const scaleReach = (viewportReach: number) =>
  Math.max(0.08, Math.min(0.98, viewportReach / AURA_HEIGHT_RATIO));

const idleStrength = (dark: boolean) => (dark ? 0.21 : 0.52);
const runStrength = (dark: boolean) => (dark ? 0.31 : 0.64);
const idlePrism = (dark: boolean) => (dark ? 0.14 : 0.26);

function idleOptics(nowMs: number, dark: boolean): AuraOptics {
  return {
    strength: idleStrength(dark) + (dark ? 0.024 : 0.038) * Math.sin(nowMs * 0.0018),
    reach: scaleReach(0.16),
    prism: idlePrism(dark),
    surge: 0,
    speed: 0.72,
    semantic: 0,
    frameMs: 110,
  };
}

function runningHoldOptics(dark: boolean): AuraOptics {
  return {
    strength: runStrength(dark),
    reach: scaleReach(0.22),
    prism: 0.7,
    surge: 0,
    speed: 0,
    semantic: 0,
    frameMs: 0,
  };
}

function decisionHoldOptics(dark: boolean): AuraOptics {
  return {
    strength: dark ? 0.22 : 0.42,
    reach: scaleReach(0.18),
    prism: 0.3,
    surge: 0,
    speed: 0,
    semantic: 1,
    frameMs: 0,
  };
}

function jadeHoldOptics(dark: boolean): AuraOptics {
  return {
    strength: dark ? 0.16 : 0.3,
    reach: scaleReach(0.17),
    prism: 0.24,
    surge: 0,
    speed: 0,
    semantic: 3,
    frameMs: 0,
  };
}

function liftoffOptics(elapsedMs: number, dark: boolean): AuraOptics {
  const ease = easeOut(clamp01(elapsedMs / AURA_TIMING.LIFTOFF_EBB_MS), 2.25);
  return {
    strength: lerp(0.92, runStrength(dark), ease),
    reach: scaleReach(lerp(0.31, 0.22, ease)),
    prism: lerp(0.78, 0.7, ease),
    surge: 0.38 * (1 - ease),
    speed: lerp(1.65, 1.45, ease),
    semantic: 0,
    frameMs: 16,
  };
}

function phaseOptics(state: AuraState, nowMs: number, dark: boolean): AuraOptics {
  const elapsed = Math.max(0, nowMs - state.phaseAt);
  const idleStr = idleStrength(dark);
  const idlePr = idlePrism(dark);
  switch (state.phase) {
    case "start": {
      const p = clamp01(elapsed / AURA_TIMING.START_MS);
      const s = Math.sin(p * Math.PI);
      const rising = p <= 0.5;
      const peak = dark ? 0.46 : 0.78;
      const endStrength = state.wasRunning ? runStrength(dark) : idleStr;
      const endReach = state.wasRunning ? 0.22 : 0.16;
      const endPrism = state.wasRunning ? 0.7 : idlePr;
      const settle = p ** 2.4;
      return {
        strength: lerp(rising ? idleStr : endStrength, peak, s),
        reach: scaleReach(lerp(rising ? 0.16 : endReach, 0.26, s)),
        prism: lerp(rising ? idlePr : endPrism, 0.74, s),
        surge: 0.5 * (1 - 0.32 * settle),
        speed: lerp(1.95, state.wasRunning ? 1.45 : 0.72, settle),
        semantic: 0,
        frameMs: 22,
      };
    }
    case "running":
      return {
        strength: runStrength(dark) + (dark ? 0.035 : 0.045) * Math.sin(nowMs * 0.0021),
        reach: scaleReach(0.22),
        prism: 0.7,
        surge: 0.025 * (1 + Math.sin(nowMs * 0.0016)),
        speed: 1.45,
        semantic: 0,
        frameMs: 32,
      };
    case "awaiting-decision": {
      const p = Math.min(1, elapsed / AURA_TIMING.DECISION_BREATH_MS);
      const wave = p < 1 ? Math.sin(p * Math.PI * 2) * (1 - 0.35 * p) : 0;
      return {
        strength: Math.max(0.08, (dark ? 0.22 : 0.42) + (dark ? 0.045 : 0.065) * wave),
        reach: scaleReach(0.18 + 0.025 * Math.max(0, wave)),
        prism: 0.32,
        surge: 0.12 * wave,
        speed: p < 1 ? 0.85 : 0,
        semantic: 1,
        frameMs: 36,
      };
    }
    case "decision-clear": {
      const fade = 1 - easeOut(clamp01(elapsed / AURA_TIMING.DECISION_CLEAR_MS), 2);
      return {
        strength: (dark ? 0.22 : 0.42) * fade,
        reach: scaleReach(0.14 + 0.04 * fade),
        prism: 0.24 * fade,
        surge: -0.14 * fade,
        speed: 0.65 * fade,
        semantic: 1,
        frameMs: 28,
      };
    }
    case "error-halted": {
      const ease = easeOut(clamp01(elapsed / AURA_TIMING.ERROR_MS), 2.2);
      return {
        strength: (dark ? 0.26 : 0.46) * (1 - ease),
        reach: scaleReach(0.21 - 0.09 * ease),
        prism: 0.36 * (1 - ease),
        surge: -0.44 * (1 - ease),
        speed: 0.9 * (1 - 0.6 * ease),
        semantic: 2,
        frameMs: 28,
      };
    }
    case "long-task-complete": {
      const ease = easeOut(clamp01(elapsed / AURA_TIMING.LONG_COMPLETE_MS), 2.05);
      return {
        strength: lerp(dark ? 0.36 : 0.62, dark ? 0.16 : 0.3, ease),
        reach: scaleReach(lerp(0.24, 0.17, ease)),
        prism: lerp(0.52, 0.24, ease),
        surge: -0.48 * (1 - ease * 0.92),
        speed: lerp(1.25, 0.55, ease),
        semantic: 3,
        frameMs: 28,
      };
    }
    case "focus-fade": {
      const ease = easeOut(clamp01(elapsed / AURA_TIMING.FOCUS_FADE_MS), 2);
      return {
        strength: lerp(dark ? 0.16 : 0.3, idleStr, ease),
        reach: scaleReach(lerp(0.17, 0.16, ease)),
        prism: lerp(0.24, idlePr, ease),
        surge: 0,
        speed: lerp(0.55, 0.72, ease),
        semantic: 0,
        frameMs: 32,
      };
    }
    case "complete": {
      const ease = easeOut(clamp01(elapsed / AURA_TIMING.COMPLETE_MS), 2.1);
      return {
        strength: lerp(dark ? 0.38 : 0.7, idleStr, ease),
        reach: scaleReach(lerp(0.24, 0.16, ease)),
        prism: lerp(0.76, idlePr, ease),
        surge: -0.36 * (1 - ease * 0.85),
        speed: lerp(1.45, 0.72, ease),
        semantic: 0,
        frameMs: 28,
      };
    }
    case "idle":
      return idleOptics(nowMs, dark);
  }
}

export function createAuraState(inputs: AuraInputs, nowMs: number): AuraState {
  return {
    phase: inputs.awaitingDecision ? "awaiting-decision" : inputs.running ? "running" : "idle",
    phaseAt: nowMs,
    wasRunning: inputs.running,
    runStartedAt: inputs.running ? (inputs.runStartedAt ?? nowMs) : null,
    liftoffAt: null,
    unfocusedHold: false,
    pendingErrorClear: false,
    // An error already on screen at mount is history, not a fresh halt.
    errorSeen: inputs.hasError,
    flowSec: 0,
    flowAt: null,
    semanticMix: 0,
    semanticHold: 0,
  };
}

function applyInputs(state: AuraState, inputs: AuraInputs, nowMs: number): AuraState {
  const { running } = inputs;
  // A live run is not halted; the error fires once the run has stopped.
  if (inputs.hasError && !state.errorSeen && !running) {
    return {
      ...state,
      errorSeen: true,
      wasRunning: false,
      runStartedAt: null,
      unfocusedHold: false,
      phase: "error-halted",
      phaseAt: nowMs,
    };
  }
  const errorSeen = inputs.hasError && state.errorSeen;
  const liveRunStart = running
    ? (inputs.runStartedAt ?? state.runStartedAt ?? nowMs)
    : state.runStartedAt;
  if (inputs.awaitingDecision) {
    const held = {
      ...state,
      errorSeen,
      wasRunning: running,
      runStartedAt: liveRunStart,
      unfocusedHold: false,
    };
    return state.phase === "awaiting-decision"
      ? held
      : { ...held, phase: "awaiting-decision", phaseAt: nowMs };
  }
  if (state.phase === "awaiting-decision") {
    return running
      ? {
          ...state,
          errorSeen,
          wasRunning: true,
          runStartedAt: liveRunStart,
          phase: "start",
          phaseAt: nowMs,
        }
      : { ...state, errorSeen, phase: "decision-clear", phaseAt: nowMs };
  }
  if (running && !state.wasRunning) {
    return {
      ...state,
      errorSeen,
      unfocusedHold: false,
      wasRunning: true,
      runStartedAt: inputs.runStartedAt ?? nowMs,
      phase: "start",
      phaseAt: state.phase === "start" ? state.phaseAt : nowMs,
    };
  }
  if (!running && state.wasRunning) {
    const ranMs = state.runStartedAt === null ? 0 : nowMs - state.runStartedAt;
    return {
      ...state,
      errorSeen,
      wasRunning: false,
      runStartedAt: null,
      phase: ranMs >= AURA_TIMING.LONG_TASK_MS ? "long-task-complete" : "complete",
      phaseAt: nowMs,
    };
  }
  return { ...state, errorSeen, runStartedAt: liveRunStart };
}

function applyTimers(state: AuraState, windowFocused: boolean, nowMs: number): AuraState {
  const elapsed = nowMs - state.phaseAt;
  // Landing on idle already past its breath lets the next frame settle straight to sleep.
  const settledIdle = { phase: "idle", phaseAt: nowMs - AURA_TIMING.IDLE_SLEEP_MS } as const;
  switch (state.phase) {
    case "start":
      return elapsed >= AURA_TIMING.START_MS
        ? { ...state, phase: state.wasRunning ? "running" : "idle", phaseAt: nowMs }
        : state;
    case "complete":
      return elapsed >= AURA_TIMING.COMPLETE_MS
        ? { ...state, phase: "idle", phaseAt: nowMs }
        : state;
    case "decision-clear":
      return elapsed >= AURA_TIMING.DECISION_CLEAR_MS
        ? { ...state, phase: "idle", phaseAt: nowMs }
        : state;
    case "error-halted":
      return elapsed >= AURA_TIMING.ERROR_MS
        ? { ...state, ...settledIdle, pendingErrorClear: true }
        : state;
    case "focus-fade":
      return elapsed >= AURA_TIMING.FOCUS_FADE_MS ? { ...state, ...settledIdle } : state;
    case "long-task-complete":
      return !state.unfocusedHold && windowFocused && elapsed >= AURA_TIMING.LONG_COMPLETE_MS
        ? { ...state, ...settledIdle }
        : state;
    default:
      return state;
  }
}

/** Folds the host's live signals and elapsed time into the phase. */
export function advanceAura(state: AuraState, inputs: AuraInputs, nowMs: number): AuraState {
  return applyTimers(applyInputs(state, inputs, nowMs), inputs.windowFocused, nowMs);
}

export function triggerAuraLiftoff(state: AuraState, nowMs: number): AuraState {
  return { ...state, liftoffAt: nowMs };
}

/** The user came back to a held long-task afterglow; fade it out instead of cutting. */
export function resumeAuraFocus(state: AuraState, nowMs: number): AuraState {
  if (!state.unfocusedHold) return state;
  return { ...state, unfocusedHold: false, phase: "focus-fade", phaseAt: nowMs };
}

function darkFrame(state: AuraState, clearCanvas: boolean): AuraFrame {
  return {
    state,
    timeSec: HORIZON_TIME_OFFSET_SEC + state.flowSec,
    intensity: 0,
    reach: scaleReach(0.16),
    stretch: HORIZON_STRETCH,
    presence: 0,
    prism: 0,
    surge: 0,
    speed: 0,
    semantic: 0,
    staticSnapshot: false,
    shouldSleep: true,
    clearCanvas,
    nextFrameMs: 0,
  };
}

function staticFrame(
  state: AuraState,
  optics: AuraOptics,
  nowMs: number,
  ambient: number,
): AuraFrame {
  const flowSec = state.flowSec === 0 ? HORIZON_STATIC_FLOW_SEC : state.flowSec;
  const semanticMix = optics.semantic > 0 ? 1 : 0;
  const semanticHold = optics.semantic > 0 ? optics.semantic : state.semanticHold;
  const strength = clamp01(optics.strength) * ambient;
  return {
    state: { ...state, flowSec, flowAt: nowMs, semanticMix, semanticHold },
    timeSec: HORIZON_TIME_OFFSET_SEC + flowSec,
    intensity: HORIZON_STATIC_BREATH * (0.55 + 0.45 * strength),
    reach: optics.reach,
    stretch: HORIZON_STRETCH,
    presence: horizonPresenceGain(strength),
    prism: optics.prism,
    surge: optics.surge,
    speed: optics.speed,
    semantic: encodeSemanticUniform(semanticHold, semanticMix),
    staticSnapshot: true,
    shouldSleep: true,
    clearCanvas: false,
    nextFrameMs: 0,
  };
}

// Nothing ticks while motion is paused, so a transient phase draws the look it would settle into.
function pausedFrame(state: AuraState, nowMs: number, env: AuraFrameEnv): AuraFrame {
  const ambient = clamp01(env.ambientScale);
  switch (state.phase) {
    case "start":
    case "running":
      return staticFrame(state, runningHoldOptics(env.isDark), nowMs, ambient);
    case "awaiting-decision":
      return staticFrame(state, decisionHoldOptics(env.isDark), nowMs, ambient);
    case "long-task-complete":
      return env.windowFocused
        ? staticFrame(state, idleOptics(nowMs, env.isDark), nowMs, ambient)
        : staticFrame(
            { ...state, unfocusedHold: true },
            jadeHoldOptics(env.isDark),
            nowMs,
            ambient,
          );
    default:
      return staticFrame(state, idleOptics(nowMs, env.isDark), nowMs, ambient);
  }
}

function remainingMs(state: AuraState, nowMs: number): number | null {
  const elapsed = nowMs - state.phaseAt;
  switch (state.phase) {
    case "start":
      return AURA_TIMING.START_MS - elapsed;
    case "complete":
      return AURA_TIMING.COMPLETE_MS - elapsed;
    case "awaiting-decision":
      return AURA_TIMING.DECISION_BREATH_MS - elapsed;
    case "decision-clear":
      return AURA_TIMING.DECISION_CLEAR_MS - elapsed;
    case "error-halted":
      return AURA_TIMING.ERROR_MS - elapsed;
    case "long-task-complete":
      return AURA_TIMING.LONG_COMPLETE_MS - elapsed;
    case "focus-fade":
      return AURA_TIMING.FOCUS_FADE_MS - elapsed;
    case "idle":
      return AURA_TIMING.IDLE_SLEEP_MS - elapsed;
    case "running":
      return null;
  }
}

function cadenceMs(
  state: AuraState,
  optics: AuraOptics,
  inLiftoff: boolean,
  env: AuraFrameEnv,
): number {
  if (state.phase === "running" && !inLiftoff) {
    return env.gpu ? Math.max(RUNNING_GAP_GPU_MS, env.minFrameGapMs) : RUNNING_GAP_FALLBACK_MS;
  }
  const settling =
    !inLiftoff &&
    (state.phase === "idle" ||
      state.phase === "awaiting-decision" ||
      state.phase === "long-task-complete");
  if (env.gpu) return Math.max(settling ? 33 : 16, env.minFrameGapMs);
  return state.phase === "idle" && !inLiftoff ? Math.max(160, optics.frameMs) : optics.frameMs;
}

/** Every horizon shader uniform for this instant, plus whether the loop may stop. */
export function computeAuraFrame(state: AuraState, nowMs: number, env: AuraFrameEnv): AuraFrame {
  if (env.hidden) return darkFrame(state, false);
  const ambient = clamp01(env.ambientScale);
  if (ambient <= 0 || env.motionLevel === "off") return darkFrame(state, true);

  const elapsed = nowMs - state.phaseAt;
  const living = env.motionLevel !== "subtle" && env.windowFocused;
  const errorSpent = state.phase === "error-halted" && (!living || elapsed >= AURA_TIMING.ERROR_MS);
  if (state.pendingErrorClear || errorSpent) {
    return darkFrame(
      {
        ...state,
        pendingErrorClear: false,
        phase: "idle",
        phaseAt: nowMs - AURA_TIMING.IDLE_SLEEP_MS,
      },
      true,
    );
  }
  if (!living) return pausedFrame(state, nowMs, env);

  const liftElapsed = state.liftoffAt === null ? -1 : nowMs - state.liftoffAt;
  const inLiftoff = liftElapsed >= 0 && liftElapsed < AURA_TIMING.LIFTOFF_EBB_MS;
  const current = state.liftoffAt !== null && !inLiftoff ? { ...state, liftoffAt: null } : state;

  if (current.phase === "awaiting-decision" && elapsed >= AURA_TIMING.DECISION_BREATH_MS) {
    return staticFrame(current, decisionHoldOptics(env.isDark), nowMs, ambient);
  }
  if (current.phase === "long-task-complete" && elapsed >= AURA_TIMING.LONG_COMPLETE_MS) {
    const settled = {
      ...current,
      phase: "idle",
      phaseAt: nowMs - AURA_TIMING.IDLE_SLEEP_MS,
    } as const;
    return staticFrame(settled, idleOptics(nowMs, env.isDark), nowMs, ambient);
  }
  if (current.phase === "idle" && !inLiftoff && elapsed >= AURA_TIMING.IDLE_SLEEP_MS) {
    return staticFrame(current, idleOptics(nowMs, env.isDark), nowMs, ambient);
  }

  const optics = inLiftoff
    ? liftoffOptics(liftElapsed, env.isDark)
    : phaseOptics(current, nowMs, env.isDark);
  const resumed = current.flowAt === null || nowMs < current.flowAt;
  const dtSec = resumed
    ? 0
    : Math.min(MAX_FLOW_STEP_SEC, Math.max(0, (nowMs - (current.flowAt ?? nowMs)) / 1000));
  const flowSec = current.flowSec + dtSec * optics.speed;
  const semanticHold = optics.semantic > 0 ? optics.semantic : current.semanticHold;
  const semanticMix = advanceSemanticMix(current.semanticMix, optics.semantic > 0 ? 1 : 0, dtSec);
  const strength = clamp01(optics.strength) * ambient;

  const cadence = cadenceMs(current, optics, inLiftoff, env);
  const remaining = inLiftoff
    ? AURA_TIMING.LIFTOFF_EBB_MS - liftElapsed
    : remainingMs(current, nowMs);
  const nextFrameMs = remaining === null ? cadence : Math.min(cadence, Math.max(16, remaining + 4));

  return {
    state: { ...current, flowSec, flowAt: nowMs, semanticMix, semanticHold },
    timeSec: HORIZON_TIME_OFFSET_SEC + flowSec,
    intensity: horizonBreath(flowSec) * (0.55 + 0.45 * strength),
    reach: optics.reach,
    stretch: HORIZON_STRETCH,
    presence: horizonPresenceGain(strength),
    prism: optics.prism,
    surge: optics.surge,
    speed: optics.speed,
    semantic: encodeSemanticUniform(semanticHold, semanticMix),
    staticSnapshot: false,
    shouldSleep: false,
    clearCanvas: false,
    nextFrameMs,
  };
}
