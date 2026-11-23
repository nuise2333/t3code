import { describe, expect, it } from "vite-plus/test";

import { computeProximityFactor, evaluateDeterministicGlints } from "./crystalPrismCore";

describe("computeProximityFactor", () => {
  const W = 240;
  const H = 12;

  it("is full inside the capsule and on its rim", () => {
    expect(computeProximityFactor(W / 2, H / 2, W, H)).toBe(1);
    expect(computeProximityFactor(0, H / 2, W, H)).toBe(1);
    expect(computeProximityFactor(W / 2, 0, W, H)).toBe(1);
  });

  it("falls to zero at the radius and stays there", () => {
    expect(computeProximityFactor(W / 2, H + 105, W, H)).toBe(0);
    expect(computeProximityFactor(W + 400, H / 2, W, H)).toBe(0);
    expect(computeProximityFactor(W / 2, H + 20, W, H, 20)).toBe(0);
  });

  it("decreases monotonically between rim and radius", () => {
    let previous = 1;
    for (let gap = 5; gap < 105; gap += 5) {
      const value = computeProximityFactor(W / 2, H + gap, W, H);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  it("ignores off-screen and non-finite pointers", () => {
    expect(computeProximityFactor(-9999, -9999, W, H)).toBe(0);
    expect(computeProximityFactor(Number.NaN, 0, W, H)).toBe(0);
    expect(computeProximityFactor(0, Number.POSITIVE_INFINITY, W, H)).toBe(0);
  });
});

describe("evaluateDeterministicGlints", () => {
  it("returns the same glints for the same time", () => {
    for (const t of [0, 0.5, 3.7, 128.25]) {
      expect(evaluateDeterministicGlints(t)).toEqual(evaluateDeterministicGlints(t));
    }
  });

  it("keeps every intensity in 0..1 and the glints out of phase", () => {
    let sawSingleGlint = false;
    for (let t = 0; t < 30; t += 0.05) {
      const glints = evaluateDeterministicGlints(t);
      expect(glints).toHaveLength(4);
      for (const glint of glints) {
        expect(glint.intensity).toBeGreaterThanOrEqual(0);
        expect(glint.intensity).toBeLessThanOrEqual(1);
      }
      if (glints.filter((glint) => glint.intensity > 0.5).length === 1) sawSingleGlint = true;
    }
    expect(sawSingleGlint).toBe(true);
  });

  it("freezes to a fixed pattern under reduced motion", () => {
    const at = (t: number) => evaluateDeterministicGlints(t, true).map((g) => g.intensity);
    expect(at(0)).toEqual([0, 0.42, 0.24, 0]);
    expect(at(42)).toEqual(at(0));
  });

  it("treats negative and non-finite time as zero", () => {
    expect(evaluateDeterministicGlints(-5)).toEqual(evaluateDeterministicGlints(0));
    expect(evaluateDeterministicGlints(Number.NaN)).toEqual(evaluateDeterministicGlints(0));
  });
});
