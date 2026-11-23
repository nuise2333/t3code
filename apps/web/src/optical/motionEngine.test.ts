import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getMotionTier, springLinear } from "./motionEngine";

const LINEAR_EASING = /^linear\(0(?:, -?\d+(?:\.\d+)?)+\)$/;

function stubMotionEnvironment(opticalMotion: string | undefined, reducedMotion: boolean) {
  vi.stubGlobal("document", {
    documentElement: { dataset: opticalMotion === undefined ? {} : { opticalMotion } },
  });
  vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("springLinear", () => {
  it.each([
    { regime: "underdamped", params: { stiffness: 380, damping: 20, mass: 1 } },
    { regime: "critically damped", params: { stiffness: 400, damping: 40, mass: 1 } },
    { regime: "overdamped", params: { stiffness: 200, damping: 40, mass: 1 } },
  ])("samples a $regime spring from 0 to 1", ({ regime, params }) => {
    const solved = springLinear(params);

    expect(solved.easing).toMatch(LINEAR_EASING);
    expect(solved.samples).toHaveLength(40);
    expect(solved.samples[0]).toBe(0);
    expect(solved.samples.at(-1)).toBe(1);
    expect(solved.durationMs).toBeGreaterThan(0);
    expect(solved.solveAt(0)).toBe(0);
    expect(solved.solveAt(solved.durationMs / 1000)).toBeCloseTo(1, 2);

    const peak = Math.max(...solved.samples);
    if (regime === "underdamped") expect(peak).toBeGreaterThan(1);
    else expect(peak).toBeLessThanOrEqual(1);
  });

  it("resolves presets and clamps out-of-range parameters", () => {
    expect(springLinear("bouncy")).toBe(springLinear({ stiffness: 380, damping: 20, mass: 1 }));
    expect(springLinear({ stiffness: 1e9 })).toBe(springLinear({ stiffness: 3000 }));
  });

  it("returns the cached solution and evicts the least recently used past 64 entries", () => {
    const evicted = springLinear({ stiffness: 1000 });
    const kept = springLinear({ stiffness: 1001 });
    for (let i = 0; i < 62; i++) springLinear({ stiffness: 1100 + i });

    expect(springLinear({ stiffness: 1001 })).toBe(kept);
    springLinear({ stiffness: 1200 });
    springLinear({ stiffness: 1201 });

    expect(springLinear({ stiffness: 1001 })).toBe(kept);
    const resolved = springLinear({ stiffness: 1000 });
    expect(resolved).not.toBe(evicted);
    expect(resolved).toEqual(expect.objectContaining({ easing: evicted.easing }));
  });
});

describe("getMotionTier", () => {
  it.each(["off", "subtle", "standard", "ultra"] as const)(
    "reads data-optical-motion=%s",
    (tier) => {
      stubMotionEnvironment(tier, false);
      expect(getMotionTier()).toBe(tier);
    },
  );

  it.each([undefined, "", "turbo"])("treats a missing or unknown tier (%s) as off", (raw) => {
    stubMotionEnvironment(raw, false);
    expect(getMotionTier()).toBe("off");
  });

  it("is off whenever reduced motion is requested", () => {
    stubMotionEnvironment("ultra", true);
    expect(getMotionTier()).toBe("off");
  });
});
