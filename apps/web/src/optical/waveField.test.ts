import { describe, expect, it } from "vite-plus/test";

import { RIPPLE, createWaveField, type WaveField } from "./waveField";

const COLUMNS = 64;
const ROWS = 32;
const FRAME_SECONDS = 0.05;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function peakHeight(field: WaveField): number {
  let peak = 0;
  for (const value of field.height) peak = Math.max(peak, Math.abs(value));
  return peak;
}

function heightAt(field: WaveField, column: number, row: number): number {
  return Math.abs(field.height[row * field.columns + column] ?? 0);
}

function advance(field: WaveField, seconds: number) {
  for (let elapsed = 0; elapsed < seconds; elapsed += FRAME_SECONDS) field.advance(FRAME_SECONDS);
}

describe("createWaveField", () => {
  it("turns a disturbance into wave energy", () => {
    const field = createWaveField(COLUMNS, ROWS, seededRandom(1));
    expect(field.active()).toBe(false);
    expect(peakHeight(field)).toBe(0);

    field.disturb(32, 16);
    expect(field.active()).toBe(true);

    advance(field, 0.1);
    expect(peakHeight(field)).toBeGreaterThan(0.05);
    expect(field.active()).toBe(true);
  });

  it("propagates outward, then decays back to rest", () => {
    const field = createWaveField(COLUMNS, ROWS, seededRandom(2));
    field.disturb(32, 16, { amplitudeScale: 1, radiusScale: 1, duration: 0.4 });

    // 20 cells is 140px from the source, well outside its 36px envelope.
    advance(field, 0.05);
    const farEarly = heightAt(field, 52, 16);

    let farPeak = 0;
    for (let frame = 0; frame < 20; frame++) {
      field.advance(FRAME_SECONDS);
      farPeak = Math.max(farPeak, heightAt(field, 52, 16));
    }
    expect(farPeak).toBeGreaterThan(0.01);
    expect(farEarly).toBeLessThan(farPeak / 20);

    advance(field, 30);
    expect(field.active()).toBe(false);
    expect(field.sourceCount()).toBe(0);
    expect(peakHeight(field)).toBe(0);
  });

  it("soft-limits repeated extreme impulses below the height cap", () => {
    const field = createWaveField(COLUMNS, ROWS, seededRandom(3));
    let peak = 0;
    for (let burst = 0; burst < 40; burst++) {
      field.disturb(32, 16, { amplitudeScale: 50, radiusScale: 1, duration: 0.5, loadWeight: 0 });
      field.advance(FRAME_SECONDS);
      peak = Math.max(peak, peakHeight(field));
    }
    expect(peak).toBeGreaterThan(RIPPLE.heightKnee);
    expect(peak).toBeLessThan(RIPPLE.heightCap);
  });

  it("merges rapid nearby skimmer impulses and caps wake sources at 24", () => {
    const field = createWaveField(COLUMNS, ROWS, seededRandom(4));

    field.skimmer(10, 10, 0.5);
    field.skimmer(11, 11, 0.9);
    field.skimmer(12, 12, 0.2);
    expect(field.sourceCount()).toBe(1);

    field.skimmer(15, 10, 0.5);
    expect(field.sourceCount()).toBe(2);

    // Past the 36ms merge window the same cell opens a new wake.
    field.advance(0.04);
    field.skimmer(15, 10, 0.5);
    expect(field.sourceCount()).toBe(3);

    for (let i = 0; i < 40; i++) field.skimmer((i * 5) % COLUMNS, (i * 7) % ROWS, 1);
    expect(field.sourceCount()).toBe(24);
    expect(field.active()).toBe(true);
  });

  it("ignores disturbances on an empty grid", () => {
    const field = createWaveField(0, 0, seededRandom(5));
    field.disturb(3, 3);
    field.skimmer(3, 3);
    field.advance(FRAME_SECONDS);
    expect(field.active()).toBe(false);
  });
});
