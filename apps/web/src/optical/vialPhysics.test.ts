import { describe, expect, it } from "vite-plus/test";

import { createVialPhysics, type VialPhysics } from "./vialCore";

const FRAME_SECONDS = 1 / 60;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function run(physics: VialPhysics, seconds: number) {
  const frames = Math.round(seconds / FRAME_SECONDS);
  for (let frame = 0; frame < frames; frame++) physics.step(FRAME_SECONDS);
}

function peakTilt(physics: VialPhysics, seconds: number): number {
  let peak = 0;
  const frames = Math.round(seconds / FRAME_SECONDS);
  for (let frame = 0; frame < frames; frame++) {
    physics.step(FRAME_SECONDS);
    peak = Math.max(peak, Math.abs(physics.snapshot().tiltAngle));
  }
  return peak;
}

describe("createVialPhysics", () => {
  it("starts at rest", () => {
    const physics = createVialPhysics({ fill: 0.5, random: seededRandom(1) });
    expect(physics.isSettled()).toBe(true);
    run(physics, 1);
    const snapshot = physics.snapshot();
    expect(snapshot.waveEnergy).toBe(0);
    expect(snapshot.tiltAngle).toBe(0);
    expect(physics.isSettled()).toBe(true);
  });

  it("agitates the shallow-water surface and conserves its mean level", () => {
    const physics = createVialPhysics({ fill: 0.5, random: seededRandom(2) });
    physics.injectSlosh(1.6);
    run(physics, 0.1);

    const snapshot = physics.snapshot();
    expect(snapshot.waveEnergy).toBeGreaterThan(1);
    expect(snapshot.bubbleCount).toBe(2);
    expect(physics.isSettled()).toBe(false);
    // A positive slosh piles liquid against the right wall.
    expect(physics.waveH[23]!).toBeGreaterThan(physics.waveH[0]!);

    let mean = 0;
    for (const height of physics.waveH) mean += height;
    expect(Math.abs(mean / physics.waveH.length)).toBeLessThan(0.5);
    for (const height of physics.waveH) expect(Math.abs(height)).toBeLessThanOrEqual(10);
  });

  it("clamps the pendulum and damps it back to level", () => {
    const physics = createVialPhysics({ fill: 0.5, random: seededRandom(3) });
    physics.injectTilt(5);
    expect(physics.snapshot().tiltAngle).toBeLessThanOrEqual(0.48);

    const early = peakTilt(physics, 0.5);
    const middle = peakTilt(physics, 0.5);
    const late = peakTilt(physics, 0.5);
    expect(early).toBeLessThanOrEqual(0.48);
    expect(early).toBeGreaterThan(0.2);
    expect(middle).toBeLessThan(early / 2);
    expect(late).toBeLessThan(middle / 2);

    run(physics, 3);
    expect(physics.snapshot().tiltAngle).toBe(0);
    expect(physics.snapshot().tiltVelocity).toBe(0);
  });

  it("converges on the target fill without overshooting", () => {
    const physics = createVialPhysics({ fill: 0.2, random: seededRandom(4) });
    physics.setTargetFill(0.8);
    expect(physics.isSettled()).toBe(false);

    let previous = physics.snapshot().fill;
    for (let frame = 0; frame < 240; frame++) {
      physics.step(FRAME_SECONDS);
      const { fill } = physics.snapshot();
      expect(fill).toBeGreaterThanOrEqual(previous);
      expect(fill).toBeLessThanOrEqual(0.8);
      previous = fill;
    }
    expect(physics.snapshot().fill).toBe(0.8);

    physics.setTargetFill(4);
    expect(physics.snapshot().targetFill).toBe(0.95);
    physics.snapFill(-1);
    expect(physics.snapshot().fill).toBe(0.06);
  });

  it("settles after a splash, and never while streaming", () => {
    const physics = createVialPhysics({ fill: 0.5, random: seededRandom(5) });
    physics.spawnDroplet();
    physics.injectFingerPoke(0.6, 0.5, 12, -4);
    expect(physics.isSettled()).toBe(false);

    run(physics, 0.5);
    expect(physics.isSettled()).toBe(false);
    run(physics, 12);
    expect(physics.snapshot().fallingCount).toBe(0);
    expect(physics.snapshot().bubbleCount).toBe(0);
    expect(physics.isSettled()).toBe(true);

    physics.setStreaming(true);
    run(physics, 6);
    expect(physics.isSettled()).toBe(false);
    expect(Math.abs(physics.snapshot().tiltAngle)).toBeGreaterThan(0);

    physics.setStreaming(false);
    run(physics, 12);
    expect(physics.isSettled()).toBe(true);
  });

  it("caps frame time so a stalled tab cannot explode the solver", () => {
    const physics = createVialPhysics({ fill: 0.5, random: seededRandom(6) });
    physics.injectSlosh(3.8);
    for (let frame = 0; frame < 20; frame++) physics.step(5);
    const snapshot = physics.snapshot();
    expect(Number.isFinite(snapshot.waveEnergy)).toBe(true);
    expect(Math.abs(snapshot.tiltAngle)).toBeLessThanOrEqual(0.48);
  });
});
