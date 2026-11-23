import { describe, expect, it } from "vite-plus/test";

import {
  advanceFadeBuckets,
  createFadeBucketState,
  enqueueFadeEntry,
  HIGHLIGHT_NAMES,
  isStreamInkTier,
  MAX_FADE_RANGES,
  MERGE_WINDOW_MS,
  STREAM_FADE_MS,
  STREAM_FADE_STEP_MS,
} from "./streamChoreography";

const START = 1_000;

describe("advanceFadeBuckets", () => {
  it.each([
    { age: 0, bucket: 0 },
    { age: STREAM_FADE_STEP_MS - 1, bucket: 0 },
    { age: STREAM_FADE_STEP_MS, bucket: 1 },
    { age: 2 * STREAM_FADE_STEP_MS, bucket: 2 },
    { age: 3 * STREAM_FADE_STEP_MS, bucket: 3 },
    { age: 4 * STREAM_FADE_STEP_MS, bucket: 4 },
    { age: STREAM_FADE_MS - 1, bucket: 4 },
  ])("holds an entry aged $age ms in bucket $bucket", ({ age, bucket }) => {
    const state = createFadeBucketState<string>();
    enqueueFadeEntry(state, "node", 0, 5, START);

    const { moved, expired } = advanceFadeBuckets(state, START + age);

    expect(expired).toEqual([]);
    expect(state.entries.map((entry) => entry.bucket)).toEqual([bucket]);
    expect(moved.map(({ from, to }) => [from, to])).toEqual(bucket === 0 ? [] : [[0, bucket]]);
    expect(state.nextDueAt).toBe(START + (bucket + 1) * STREAM_FADE_STEP_MS);
  });

  it("promotes one stage per step through every highlight and expires at the fade end", () => {
    const state = createFadeBucketState<string>();
    enqueueFadeEntry(state, "node", 0, 5, START);
    expect(state.nextDueAt).toBe(START + STREAM_FADE_STEP_MS);

    const promotions: Array<[number, number]> = [];
    for (let stage = 1; stage < HIGHLIGHT_NAMES.length; stage++) {
      const { moved } = advanceFadeBuckets(state, state.nextDueAt);
      promotions.push(...moved.map(({ from, to }): [number, number] => [from, to]));
    }
    expect(promotions).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(state.nextDueAt).toBe(START + STREAM_FADE_MS);

    const { moved, expired } = advanceFadeBuckets(state, START + STREAM_FADE_MS);
    expect(moved).toEqual([]);
    expect(expired.map((entry) => entry.node)).toEqual(["node"]);
    expect(state.entries).toEqual([]);
    expect(state.nextDueAt).toBe(0);
  });

  it("expires an entry whose text node is gone and keeps the rest due on time", () => {
    const state = createFadeBucketState<string>();
    enqueueFadeEntry(state, "detached", 0, 5, START);
    enqueueFadeEntry(state, "live", 0, 5, START + 30);

    const { expired } = advanceFadeBuckets(
      state,
      START + STREAM_FADE_STEP_MS,
      (entry) => entry.node !== "detached",
    );

    expect(expired.map((entry) => entry.node)).toEqual(["detached"]);
    expect(state.entries.map((entry) => entry.node)).toEqual(["live"]);
    expect(state.nextDueAt).toBe(START + 30 + STREAM_FADE_STEP_MS);
  });
});

describe("enqueueFadeEntry", () => {
  it("extends the newest range when the next slice continues it within the merge window", () => {
    const state = createFadeBucketState<string>();
    enqueueFadeEntry(state, "node", 0, 5, START);

    const merged = enqueueFadeEntry(state, "node", 5, 9, START + MERGE_WINDOW_MS);

    expect(merged.kind).toBe("merged");
    expect(state.entries).toEqual([
      { node: "node", start: 0, end: 9, bucket: 0, startedAt: START },
    ]);
  });

  it.each([
    { reason: "after the merge window", node: "node", start: 5, at: START + MERGE_WINDOW_MS + 1 },
    { reason: "that leaves a gap", node: "node", start: 6, at: START + 10 },
    { reason: "on another text node", node: "other", start: 5, at: START + 10 },
  ])("starts a new range for a slice $reason", ({ node, start, at }) => {
    const state = createFadeBucketState<string>();
    enqueueFadeEntry(state, "node", 0, 5, START);

    const result = enqueueFadeEntry(state, node, start, start + 3, at);

    expect(result.kind).toBe("added");
    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]?.end).toBe(5);
  });

  it("rejects an empty or inverted slice", () => {
    const state = createFadeBucketState<string>();

    expect(enqueueFadeEntry(state, "node", 4, 4, START).kind).toBe("rejected");
    expect(enqueueFadeEntry(state, "node", 6, 2, START).kind).toBe("rejected");
    expect(state.entries).toEqual([]);
    expect(state.nextDueAt).toBe(0);
  });

  it("evicts the oldest range once the cap is reached", () => {
    const state = createFadeBucketState<number>();
    for (let node = 0; node < MAX_FADE_RANGES; node++) {
      expect(enqueueFadeEntry(state, node, 0, 1, START)).toMatchObject({ evicted: null });
    }

    const overflow = enqueueFadeEntry(state, MAX_FADE_RANGES, 0, 1, START);

    expect(overflow).toMatchObject({ kind: "added", evicted: { node: 0 } });
    expect(state.entries).toHaveLength(MAX_FADE_RANGES);
    expect(state.entries[0]?.node).toBe(1);
    expect(state.entries.at(-1)?.node).toBe(MAX_FADE_RANGES);
  });
});

describe("isStreamInkTier", () => {
  it.each([
    { tier: "off", enabled: false },
    { tier: "subtle", enabled: false },
    { tier: "standard", enabled: true },
    { tier: "ultra", enabled: true },
  ] as const)("is $enabled at tier $tier", ({ tier, enabled }) => {
    expect(isStreamInkTier(tier)).toBe(enabled);
  });
});
