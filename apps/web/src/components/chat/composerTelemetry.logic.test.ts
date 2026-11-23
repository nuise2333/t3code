import { ProviderThreadId, type ServerProviderUsageWindow } from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  countContextLayerSignals,
  deriveCacheHitRate,
  deriveComposerTelemetry,
  deriveContextLayerRatios,
  deriveOutputTokensPerSecond,
  deriveQuotaStatus,
  deriveVialTickLabels,
  deriveWindowQuotaStatus,
  detectVialCamp,
  formatCacheHitRate,
  formatTokensPerSecond,
} from "./composerTelemetry.logic";

const THREAD_A = ProviderThreadId.make("provider-thread-a");
const THREAD_B = ProviderThreadId.make("provider-thread-b");

function makeSnapshot(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    usedTokens: 20_480,
    totalProcessedTokens: null,
    maxTokens: 512_000,
    remainingTokens: 491_520,
    usedPercentage: 4,
    remainingPercentage: 96,
    inputTokens: 20_000,
    cachedInputTokens: 0,
    outputTokens: 480,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: true,
    autoCompactThreshold: null,
    cost: null,
    updatedAt: "2026-11-23T02:00:10.000Z",
    ...overrides,
  };
}

describe("deriveOutputTokensPerSecond", () => {
  it("computes tok/s from the latest completed turn on the active provider thread", () => {
    const tps = deriveOutputTokensPerSecond({
      activeProviderThreadId: THREAD_A,
      providerTurns: [
        {
          providerThreadId: THREAD_A,
          ordinal: 1,
          startedAt: DateTime.makeUnsafe("2026-11-23T02:00:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-11-23T02:00:10.000Z"),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 1000,
            outputTokens: 200,
            hasSubagents: false,
          },
        },
        {
          providerThreadId: THREAD_A,
          ordinal: 2,
          startedAt: DateTime.makeUnsafe("2026-11-23T02:01:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-11-23T02:01:05.000Z"),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 2000,
            outputTokens: 150,
            hasSubagents: false,
          },
        },
        {
          providerThreadId: THREAD_B,
          ordinal: 3,
          startedAt: DateTime.makeUnsafe("2026-11-23T02:02:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-11-23T02:02:02.000Z"),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 500,
            outputTokens: 500,
            hasSubagents: false,
          },
        },
      ],
      contextWindow: null,
    });
    expect(tps).toBeCloseTo(30, 5);
  });

  it("computes live tok/s during a running turn from tokenUsage.updatedAt", () => {
    const tps = deriveOutputTokensPerSecond({
      activeProviderThreadId: THREAD_A,
      providerTurns: [
        {
          providerThreadId: THREAD_A,
          ordinal: 1,
          startedAt: DateTime.makeUnsafe("2026-11-23T02:00:00.000Z"),
          completedAt: null,
          tokenUsage: {
            usedTokens: 4_000,
            outputTokens: 123,
            updatedAt: "2026-11-23T02:00:04.000Z",
          },
        },
      ],
      contextWindow: null,
    });
    expect(tps).toBeCloseTo(30.75, 5);
    expect(formatTokensPerSecond(tps)).toBe("30.8 tok/s");
  });

  it("falls back to contextWindow durationMs and rejects sub-250ms noise", () => {
    expect(
      deriveOutputTokensPerSecond({
        contextWindow: makeSnapshot({ lastOutputTokens: 90, durationMs: 3_000 }),
      }),
    ).toBeCloseTo(30, 5);

    expect(
      deriveOutputTokensPerSecond({
        contextWindow: makeSnapshot({ lastOutputTokens: 90, durationMs: 100 }),
      }),
    ).toBeNull();
  });

  it("returns null when no timing or output token data exists", () => {
    expect(
      deriveOutputTokensPerSecond({
        providerTurns: [],
        contextWindow: makeSnapshot({ outputTokens: null, durationMs: null }),
      }),
    ).toBeNull();
  });
});

describe("deriveCacheHitRate", () => {
  it("computes cache hit rate from the latest matching turn and preserves explicit 0%", () => {
    expect(
      deriveCacheHitRate({
        activeProviderThreadId: THREAD_A,
        providerTurns: [
          {
            providerThreadId: THREAD_A,
            ordinal: 1,
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              inputTokens: 20_000,
              cachedInputTokens: 15_000,
              outputTokens: 100,
              hasSubagents: false,
            },
          },
        ],
        contextWindow: null,
      }),
    ).toBeCloseTo(0.75, 5);

    const zeroRate = deriveCacheHitRate({
      contextWindow: makeSnapshot({ inputTokens: 12_000, cachedInputTokens: 0 }),
    });
    expect(zeroRate).toBe(0);
    expect(formatCacheHitRate(zeroRate)).toBe("0.0%");
  });

  it("returns null when cache telemetry is absent and clamps when cached exceeds input", () => {
    expect(
      deriveCacheHitRate({
        contextWindow: makeSnapshot({ inputTokens: 12_000, cachedInputTokens: null }),
      }),
    ).toBeNull();

    expect(
      deriveCacheHitRate({
        contextWindow: makeSnapshot({ inputTokens: 1_000, cachedInputTokens: 1_500 }),
      }),
    ).toBe(1);
  });
});

describe("deriveContextLayerRatios", () => {
  it("sums to usedFraction and reflects observed tool vs. conversation signals", () => {
    const withTools = deriveContextLayerRatios({
      usedFraction: 0.5,
      maxTokens: 512_000,
      toolItemCount: 8,
      conversationItemCount: 8,
    });
    expect(withTools[0] + withTools[1] + withTools[2]).toBeCloseTo(0.5, 6);
    expect(withTools[0]).toBeCloseTo(14_000 / 512_000, 6);
    expect(withTools[2]).toBeGreaterThan(withTools[1] * 0.8);

    const noTools = deriveContextLayerRatios({
      usedFraction: 0.2,
      maxTokens: 200_000,
      toolItemCount: 0,
      conversationItemCount: 4,
    });
    expect(noTools[0] + noTools[1] + noTools[2]).toBeCloseTo(0.2, 6);
    expect(noTools[2]).toBe(0);
    expect(noTools[1]).toBeCloseTo(0.2 - noTools[0], 6);
  });

  it("caps system overhead at 34% of tiny fills and returns zeros when empty", () => {
    const tiny = deriveContextLayerRatios({ usedFraction: 0.04, maxTokens: 512_000 });
    expect(tiny[0]).toBeCloseTo(0.04 * 0.34, 6);
    expect(tiny[0] + tiny[1] + tiny[2]).toBeCloseTo(0.04, 6);

    expect(deriveContextLayerRatios({ usedFraction: 0, maxTokens: 512_000 })).toEqual([0, 0, 0]);
  });

  it("counts tool vs. conversation turn items cleanly", () => {
    const counts = countContextLayerSignals([
      { item: { type: "user_message" } },
      { item: { type: "assistant_message" } },
      { item: { type: "command_execution" } },
      { item: { type: "file_change" } },
      { item: { type: "checkpoint" } },
    ] as never);
    expect(counts).toEqual({ toolItemCount: 2, conversationItemCount: 2 });
  });
});

describe("deriveVialTickLabels & detectVialCamp", () => {
  it("scales quarter tick labels to the model window", () => {
    expect(deriveVialTickLabels(512_000)).toEqual(["128k", "256k", "384k"]);
    expect(deriveVialTickLabels(200_000)).toEqual(["50k", "100k", "150k"]);
    expect(deriveVialTickLabels(1_000_000)).toEqual(["250k", "500k", "750k"]);
    expect(deriveVialTickLabels(2_000_000)).toEqual(["500k", "1M", "1.5M"]);
    expect(deriveVialTickLabels(null)).toBeNull();
  });

  it("detects claude vs. gemini camp from model or provider name", () => {
    expect(detectVialCamp("claude-sonnet-4-6")).toBe("claude");
    expect(detectVialCamp("anthropic/opus")).toBe("claude");
    expect(detectVialCamp("gemini-4-neon")).toBe("gemini");
    expect(detectVialCamp("gpt-5.4")).toBe("gemini");
  });
});

describe("deriveQuotaStatus", () => {
  const window = (id: string, usedPercent: number): ServerProviderUsageWindow => ({
    id,
    kind: "session",
    label: id,
    usedPercent,
  });

  it("classifies low, tight, and healthy states from minimum remaining room", () => {
    expect(deriveQuotaStatus([])).toBeNull();
    expect(deriveQuotaStatus([window("5h", 40), window("week", 55)])).toEqual({
      status: "ok",
      label: "Healthy",
    });
    expect(deriveQuotaStatus([window("5h", 70), window("week", 20)])).toEqual({
      status: "tight",
      label: "Tight",
    });
    expect(deriveQuotaStatus([window("5h", 90), window("week", 20)])).toEqual({
      status: "low",
      label: "Low quota",
    });
    expect(deriveWindowQuotaStatus(window("5h", 85))).toBe("low");
    expect(deriveWindowQuotaStatus(window("5h", 65))).toBe("tight");
    expect(deriveWindowQuotaStatus(window("5h", 64))).toBe("ok");
  });
});

describe("deriveComposerTelemetry", () => {
  it("bundles context fill, throughput, cache rate, ratios, and tick labels", () => {
    const summary = deriveComposerTelemetry({
      contextWindow: makeSnapshot({
        usedTokens: 20_480,
        maxTokens: 512_000,
        usedPercentage: 4,
        inputTokens: 20_000,
        cachedInputTokens: 0,
        outputTokens: 307,
        durationMs: 10_000,
      }),
      modelOrProvider: "gemini-4-neon",
    });
    expect(summary).not.toBeNull();
    expect(summary?.usedPercent).toBe(4);
    expect(summary?.remainingPercent).toBe(96);
    expect(summary?.tokensPerSecond).toBeCloseTo(30.7, 5);
    expect(summary?.cacheHitRate).toBe(0);
    expect(summary?.tickLabels).toEqual(["128k", "256k", "384k"]);
    expect(summary?.camp).toBe("gemini");
    expect(summary?.isCritical).toBe(false);
  });
});
