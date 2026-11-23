import { describe, expect, it } from "vite-plus/test";

import {
  ALL_POSE_KEYS,
  OFFICIAL_OPEN_REF,
  buildClipLayers,
  canJoinTower,
  decodeSpriteAtlas,
  isChromaTapEligible,
  registerChromaTap,
  resolveClawdStandGrid,
  resolveGroundSeparation,
  resolveStagePose,
  type StagePoseInput,
} from "./mascotRig";

describe("decodeSpriteAtlas", () => {
  it("expands run lengths and repeats, keeps offsets, and flags grounded frames", () => {
    const atlas = decodeSpriteAtlas(
      "c.body!stand=2,-1:3#.s*2/o;w12=1,10,g:4h|p!empty=0,0:|m!cowboy=0,5:..##",
    );
    expect(atlas.c.body?.stand).toEqual({ rows: ["###.s", "###.s", "o"], ox: 2, oy: -1 });
    expect(atlas.c.body?.w12).toEqual({ rows: ["hhhh"], ox: 1, oy: 10, grounded: true });
    expect(atlas.p.empty).toEqual({ rows: [], ox: 0, oy: 0 });
    expect(atlas.m.cowboy).toEqual({ rows: ["..##"], ox: 0, oy: 5 });
  });

  it("composites Clawd's standing parts onto the official reference grid", () => {
    expect(resolveClawdStandGrid()).toEqual([...OFFICIAL_OPEN_REF]);
  });
});

describe("resolveStagePose", () => {
  const base: StagePoseInput = {
    actorId: "clawd",
    camp: "claude",
    yieldMode: "none",
    hasError: false,
    streaming: false,
    dozing: false,
    now: 0,
    pose: "idle",
  };

  it.each([
    [{ yieldMode: "peek", hasError: true, streaming: true }, "peek"],
    [{ hasError: true, streaming: true }, "angry"],
    [{ actorId: "cat", hasError: true }, "idle"],
    [{ streaming: true }, "write"],
    [{ actorId: "cat", streaming: true }, "loaf"],
    [{ camp: "gemini", streaming: true }, "sleep"],
    [{ camp: "gemini", actorId: "cat", streaming: true }, "write"],
    [{ dozing: true }, "sleep"],
    [{ actorId: "cat", now: 9000 }, "loaf"],
    [{ actorId: "cat", now: 18000 }, "idle"],
    [{ pose: "" }, "idle"],
  ] as const)("%o resolves to %s", (overrides, expected) => {
    expect(resolveStagePose({ ...base, ...overrides })).toBe(expected);
  });
});

describe("buildClipLayers", () => {
  it("builds layers for every pose on both characters", () => {
    for (const pose of ALL_POSE_KEYS) {
      for (const kind of ["clawd", "cat"] as const) {
        for (const tick of [0, 1, 7, 33]) {
          expect(buildClipLayers(kind, pose, tick, { clipTick: tick }).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("splits yawnStretch into a yawn and then a stretch", () => {
    expect(buildClipLayers("cat", "yawnStretch", 4, { clipTick: 9 })).toEqual(
      buildClipLayers("cat", "yawn", 4, { clipTick: 9 }),
    );
    expect(buildClipLayers("cat", "yawnStretch", 4, { clipTick: 12 })).toEqual(
      buildClipLayers("cat", "stretch", 4, { clipTick: 2 }),
    );
  });

  it("blinks only in blinkable poses", () => {
    const open = buildClipLayers("clawd", "idle", 0);
    expect(buildClipLayers("clawd", "idle", 0, { blinkStage: "closed" })).not.toEqual(open);
    expect(buildClipLayers("clawd", "write", 0, { blinkStage: "closed" })).toEqual(
      buildClipLayers("clawd", "write", 0),
    );
  });

  it("hides the orchestrator crystal under head props", () => {
    const idle = buildClipLayers("clawd", "idle", 0).length;
    expect(buildClipLayers("clawd", "idle", 0, { crystal: true })).toHaveLength(idle + 1);
    const siren = buildClipLayers("clawd", "siren", 0).length;
    expect(buildClipLayers("clawd", "siren", 0, { crystal: true })).toHaveLength(siren);
  });
});

describe("towers", () => {
  it.each([
    [1, 1, false, true],
    [2, 1, false, false],
    [1, 2, false, false],
    [4, 1, true, true],
    [3, 2, true, true],
    [5, 1, true, false],
  ])("base %i + rider %i with minis=%s joins: %s", (baseLen, riderLen, minis, ok) => {
    expect(canJoinTower(baseLen, riderLen, minis)).toBe(ok);
  });

  it("pushes overlapping grounded bodies apart and never moves a locked one", () => {
    const bodies = [
      { cx: 100, halfW: 22, locked: true },
      { cx: 110, halfW: 22 },
      { cx: 112, halfW: 13 },
    ];
    resolveGroundSeparation(bodies, 12, 708, 6);
    const [locked, a, b] = bodies;
    expect(locked?.cx).toBe(100);
    const sorted = [...bodies].sort((l, r) => l.cx - r.cx);
    for (let i = 1; i < sorted.length; i++) {
      const left = sorted[i - 1];
      const right = sorted[i];
      if (!left || !right) continue;
      expect(right.cx - left.cx).toBeGreaterThanOrEqual(left.halfW + right.halfW + 6 - 0.01);
    }
    expect(a && b && Math.min(a.cx, b.cx)).toBeGreaterThan(100);
  });
});

describe("chroma resonance", () => {
  it.each([
    [1, true, { tuned: true, forged: true }, false],
    [2, true, { tuned: false, forged: false }, true],
    [2, false, { tuned: true, forged: false }, false],
    [2, false, { tuned: true, forged: true }, true],
  ])("tower %i, coat %s, gates %o is eligible: %s", (towerLen, coatOn, gates, ok) => {
    expect(isChromaTapEligible(towerLen, coatOn, gates)).toBe(ok);
  });

  it("toggles on the fourth tap inside 2.6s and starts a fresh window after", () => {
    const taps: number[] = [];
    expect([0, 500, 1000].map((t) => registerChromaTap(taps, t))).toEqual([false, false, false]);
    expect(registerChromaTap(taps, 1500)).toBe(true);
    expect(taps).toEqual([]);
  });

  it("forgets taps older than the window", () => {
    const taps: number[] = [];
    expect([0, 1000, 2000, 3000, 4000].some((t) => registerChromaTap(taps, t))).toBe(false);
    expect(taps).toEqual([2000, 3000, 4000]);
  });
});
