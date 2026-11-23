import { describe, expect, it } from "vite-plus/test";

import {
  AURA_TIMING,
  advanceAura,
  computeAuraFrame,
  createAuraState,
  resumeAuraFocus,
  triggerAuraLiftoff,
  type AuraFrameEnv,
  type AuraInputs,
} from "./auraPhase";

const QUIET: AuraInputs = {
  running: false,
  awaitingDecision: false,
  hasError: false,
  runStartedAt: null,
  windowFocused: true,
};
const RUNNING: AuraInputs = { ...QUIET, running: true };

const ENV: AuraFrameEnv = {
  isDark: true,
  ambientScale: 1,
  motionLevel: "ultra",
  hidden: false,
  windowFocused: true,
  gpu: true,
  minFrameGapMs: 7.5,
};

describe("aura phase machine", () => {
  it("runs start, running, complete, idle, then sleeps", () => {
    let state = createAuraState(QUIET, 0);
    expect(state.phase).toBe("idle");

    state = advanceAura(state, RUNNING, 1000);
    expect(state.phase).toBe("start");
    const surge = computeAuraFrame(state, 1000 + AURA_TIMING.START_MS / 2, ENV);
    expect(surge.shouldSleep).toBe(false);
    expect(surge.surge).toBeGreaterThan(0);
    expect(surge.semantic).toBe(0);

    state = advanceAura(state, RUNNING, 1000 + AURA_TIMING.START_MS - 1);
    expect(state.phase).toBe("start");
    state = advanceAura(state, RUNNING, 1000 + AURA_TIMING.START_MS);
    expect(state.phase).toBe("running");

    state = advanceAura(state, QUIET, 6000);
    expect(state.phase).toBe("complete");
    const chime = computeAuraFrame(state, 6100, ENV);
    expect(chime.surge).toBeLessThan(0);
    expect(chime.shouldSleep).toBe(false);

    const idleAt = 6000 + AURA_TIMING.COMPLETE_MS;
    state = advanceAura(state, QUIET, idleAt);
    expect(state.phase).toBe("idle");
    const breathing = computeAuraFrame(state, idleAt + 100, ENV);
    expect(breathing.shouldSleep).toBe(false);
    expect(breathing.staticSnapshot).toBe(false);

    const settled = computeAuraFrame(state, idleAt + AURA_TIMING.IDLE_SLEEP_MS, ENV);
    expect(settled.shouldSleep).toBe(true);
    expect(settled.staticSnapshot).toBe(true);
    expect(settled.clearCanvas).toBe(false);
    expect(settled.nextFrameMs).toBe(0);
    expect(settled.presence).toBeGreaterThan(0);
  });

  it("caps the running cadence at 30fps on GPU and 20fps on the fallback", () => {
    const state = advanceAura(
      advanceAura(createAuraState(QUIET, 0), RUNNING, 0),
      RUNNING,
      AURA_TIMING.START_MS,
    );
    expect(state.phase).toBe("running");
    expect(computeAuraFrame(state, 5000, ENV).nextFrameMs).toBeGreaterThanOrEqual(33);
    expect(
      computeAuraFrame(state, 5000, { ...ENV, minFrameGapMs: 0 }).nextFrameMs,
    ).toBeGreaterThanOrEqual(33);
    expect(
      computeAuraFrame(state, 5000, { ...ENV, gpu: false }).nextFrameMs,
    ).toBeGreaterThanOrEqual(50);
  });

  it("holds a long-task afterglow while unfocused and fades it on return", () => {
    let state = createAuraState({ ...RUNNING, runStartedAt: 0 }, 0);
    expect(state.phase).toBe("running");

    const endedAt = AURA_TIMING.LONG_TASK_MS;
    state = advanceAura(state, { ...QUIET, windowFocused: false }, endedAt);
    expect(state.phase).toBe("long-task-complete");

    const held = computeAuraFrame(state, endedAt, { ...ENV, windowFocused: false });
    expect(held.shouldSleep).toBe(true);
    expect(held.staticSnapshot).toBe(true);
    expect(held.semantic).toBe(3);
    expect(held.state.unfocusedHold).toBe(true);

    // The hold survives any amount of time away.
    state = advanceAura(held.state, { ...QUIET, windowFocused: false }, endedAt + 60_000);
    expect(state.phase).toBe("long-task-complete");

    const returnedAt = endedAt + 90_000;
    state = resumeAuraFocus(state, returnedAt);
    expect(state.phase).toBe("focus-fade");
    expect(state.unfocusedHold).toBe(false);
    expect(computeAuraFrame(state, returnedAt + 100, ENV).shouldSleep).toBe(false);

    state = advanceAura(state, QUIET, returnedAt + AURA_TIMING.FOCUS_FADE_MS);
    expect(state.phase).toBe("idle");
    expect(computeAuraFrame(state, returnedAt + AURA_TIMING.FOCUS_FADE_MS, ENV).shouldSleep).toBe(
      true,
    );
  });

  it("plays the long-task chime in jade and settles when focused", () => {
    let state = createAuraState(RUNNING, 0);
    state = advanceAura(state, QUIET, AURA_TIMING.LONG_TASK_MS - 1);
    expect(state.phase).toBe("complete");

    state = advanceAura(createAuraState(RUNNING, 0), QUIET, AURA_TIMING.LONG_TASK_MS);
    expect(state.phase).toBe("long-task-complete");
    let frame = computeAuraFrame(state, AURA_TIMING.LONG_TASK_MS, ENV);
    expect(frame.shouldSleep).toBe(false);
    frame = computeAuraFrame(frame.state, AURA_TIMING.LONG_TASK_MS + 600, ENV);
    expect(Math.floor(frame.semantic)).toBe(3);
    expect(frame.surge).toBeLessThan(0);

    const doneAt = AURA_TIMING.LONG_TASK_MS + AURA_TIMING.LONG_COMPLETE_MS;
    state = advanceAura(frame.state, QUIET, doneAt);
    expect(state.phase).toBe("idle");
    expect(computeAuraFrame(state, doneAt, ENV).shouldSleep).toBe(true);
  });

  it("breathes once for a pending decision, holds static, then clears", () => {
    const awaiting: AuraInputs = { ...QUIET, awaitingDecision: true };
    let state = advanceAura(createAuraState(QUIET, 0), awaiting, 2000);
    expect(state.phase).toBe("awaiting-decision");

    const breath = computeAuraFrame(state, 2400, ENV);
    expect(breath.shouldSleep).toBe(false);
    expect(Math.floor(breath.semantic)).toBe(1);

    const hold = computeAuraFrame(breath.state, 2000 + AURA_TIMING.DECISION_BREATH_MS, ENV);
    expect(hold.shouldSleep).toBe(true);
    expect(hold.staticSnapshot).toBe(true);
    expect(hold.semantic).toBe(1);
    expect(hold.surge).toBe(0);

    state = advanceAura(hold.state, QUIET, 9000);
    expect(state.phase).toBe("decision-clear");
    expect(computeAuraFrame(state, 9100, ENV).shouldSleep).toBe(false);
    state = advanceAura(state, QUIET, 9000 + AURA_TIMING.DECISION_CLEAR_MS);
    expect(state.phase).toBe("idle");
  });

  it("resumes a run with a start surge once the decision is answered", () => {
    const paused: AuraInputs = { ...RUNNING, awaitingDecision: true };
    const state = advanceAura(createAuraState(RUNNING, 0), paused, 100);
    expect(state.phase).toBe("awaiting-decision");
    expect(advanceAura(state, RUNNING, 500).phase).toBe("start");
  });

  it("halts in coral on a fresh error, then clears the canvas and sleeps", () => {
    const failed: AuraInputs = { ...QUIET, hasError: true };
    expect(advanceAura(createAuraState(failed, 0), failed, 500).phase).toBe("idle");

    let state = createAuraState(RUNNING, 0);
    state = advanceAura(state, { ...RUNNING, hasError: true }, 1000);
    expect(state.phase).not.toBe("error-halted");

    state = advanceAura(state, failed, 3000);
    expect(state.phase).toBe("error-halted");
    let frame = computeAuraFrame(state, 3000, ENV);
    frame = computeAuraFrame(frame.state, 3300, ENV);
    expect(Math.floor(frame.semantic)).toBe(2);
    expect(frame.surge).toBeLessThan(0);
    expect(frame.shouldSleep).toBe(false);

    state = advanceAura(frame.state, failed, 3000 + AURA_TIMING.ERROR_MS);
    expect(state.phase).toBe("idle");
    const cleared = computeAuraFrame(state, 3000 + AURA_TIMING.ERROR_MS, ENV);
    expect(cleared.clearCanvas).toBe(true);
    expect(cleared.shouldSleep).toBe(true);
    expect(cleared.state.pendingErrorClear).toBe(false);

    // The same error is not replayed; a new run starts clean.
    expect(advanceAura(cleared.state, failed, 9000).phase).toBe("idle");
    expect(advanceAura(cleared.state, { ...RUNNING, hasError: true }, 9000).phase).toBe("start");
  });

  it("draws one static frame on subtle and nothing when off, hidden, or ambient is zero", () => {
    const state = advanceAura(
      advanceAura(createAuraState(QUIET, 0), RUNNING, 0),
      RUNNING,
      AURA_TIMING.START_MS,
    );

    const subtle = computeAuraFrame(state, 4000, { ...ENV, motionLevel: "subtle" });
    expect(subtle.staticSnapshot).toBe(true);
    expect(subtle.shouldSleep).toBe(true);
    expect(subtle.clearCanvas).toBe(false);
    expect(subtle.presence).toBeGreaterThan(0);

    const off = computeAuraFrame(state, 4000, { ...ENV, motionLevel: "off" });
    expect(off.clearCanvas).toBe(true);
    expect(off.shouldSleep).toBe(true);

    const dark = computeAuraFrame(state, 4000, { ...ENV, ambientScale: 0 });
    expect(dark.clearCanvas).toBe(true);
    expect(dark.shouldSleep).toBe(true);
    expect(dark.presence).toBe(0);

    const hidden = computeAuraFrame(state, 4000, { ...ENV, hidden: true });
    expect(hidden.shouldSleep).toBe(true);
    expect(hidden.clearCanvas).toBe(false);

    const blurred = computeAuraFrame(state, 4000, { ...ENV, windowFocused: false });
    expect(blurred.staticSnapshot).toBe(true);
    expect(blurred.shouldSleep).toBe(true);
  });

  it("ebbs a liftoff surge for 520ms over the running glow", () => {
    let state = createAuraState(RUNNING, 0);
    const calm = computeAuraFrame(state, 2000, ENV);
    state = triggerAuraLiftoff(calm.state, 2000);

    const burst = computeAuraFrame(state, 2010, ENV);
    expect(burst.presence).toBeGreaterThan(calm.presence);
    expect(burst.surge).toBeGreaterThan(calm.surge);
    expect(burst.nextFrameMs).toBeLessThan(33);

    const after = computeAuraFrame(burst.state, 2000 + AURA_TIMING.LIFTOFF_EBB_MS, ENV);
    expect(after.state.liftoffAt).toBeNull();
    expect(after.nextFrameMs).toBeGreaterThanOrEqual(33);
  });
});
