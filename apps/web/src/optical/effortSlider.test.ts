import { describe, expect, it } from "vite-plus/test";

import {
  detentTargetIndex,
  effortEnergyStart,
  effortMotionParams,
  energyForPct,
  fillColorFor,
  motionSettled,
  motionStep,
  releaseIndexFor,
  valueColorFor,
} from "./effortSlider";

describe("detentTargetIndex", () => {
  it("switches a level once the pointer moves a third of a step away from it", () => {
    // Four levels sit at 0, 1/3, 2/3, and 1.
    expect(detentTargetIndex(0, 0.1, 4)).toBe(0);
    expect(detentTargetIndex(0, 0.12, 4)).toBe(1);
    expect(detentTargetIndex(1, 0.23, 4)).toBe(1);
    expect(detentTargetIndex(1, 0.22, 4)).toBe(0);
    expect(detentTargetIndex(1, 0.44, 4)).toBe(1);
    expect(detentTargetIndex(1, 0.45, 4)).toBe(2);
    expect(detentTargetIndex(0, 1, 4)).toBe(3);
  });
});

describe("motionStep", () => {
  it("reaches the target without overshooting", () => {
    const params = effortMotionParams("ultra");
    const state = { x: 0, v: 0, target: 0.5 };
    let peak = 0;
    for (let frame = 0; frame < 240 && !motionSettled(state, params); frame += 1) {
      motionStep(state, 1 / 120, params);
      peak = Math.max(peak, state.x);
    }
    expect(motionSettled(state, params)).toBe(true);
    expect(state.x).toBe(0.5);
    expect(peak).toBeLessThanOrEqual(0.5);
  });

  it("jumps straight to the target with motion off", () => {
    const params = effortMotionParams("off");
    const state = { x: 0, v: 0, target: 1 };
    motionStep(state, 1 / 60, params);
    expect(state.x).toBe(1);
  });
});

describe("releaseIndexFor", () => {
  it("carries a flick forward and lands a resting pointer where it is", () => {
    expect(releaseIndexFor(0.3, 4, 0, 4)).toBe(2);
    expect(releaseIndexFor(0.3, 4, 1, 4)).toBe(1);
  });
});

describe("energy and color", () => {
  it("keeps an Off first level out of the energized range", () => {
    const start = effortEnergyStart(["off", "low", "medium", "high"]);
    expect(start).toBeCloseTo(1 / 3);
    expect(energyForPct(1 / 3, start)).toBe(0);
    expect(energyForPct(1, start)).toBe(1);
    expect(effortEnergyStart(["low", "medium", "high"])).toBe(0);
  });

  it("ramps the fill from blue through violet", () => {
    expect(fillColorFor(0, 0, "follow")).toBe("#4d93f8");
    expect(fillColorFor(0.5, 0, "follow")).toBe("#9333ea");
    expect(fillColorFor(1, 0, "follow")).toBe("#4c1d95");
  });

  it("gives the top level the bright value color and mono none", () => {
    expect(valueColorFor(3, 4, false, false, "follow")).toBe("#8b5cf6");
    expect(valueColorFor(0, 4, false, false, "follow")).toBe("#4d93f8");
    expect(valueColorFor(3, 4, false, false, "mono")).toBeNull();
    expect(valueColorFor(0, 4, true, true, "follow")).toBeNull();
  });
});
