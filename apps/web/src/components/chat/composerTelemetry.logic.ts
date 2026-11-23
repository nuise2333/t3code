import type {
  OrchestrationV2ProviderTurn,
  ProviderThreadId,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";

import type { VialCamp } from "../../optical/vialCore";

const DEFAULT_MAX_TOKENS = 512_000;
const ESTIMATED_SYSTEM_OVERHEAD_TOKENS = 14_000;
const MIN_DURATION_MS_FOR_TPS = 250;
const DEFAULT_TOOL_SHARE = 0.24;

const TOOL_TURN_ITEM_TYPES = new Set<string>([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "mcp_tool_call",
  "dynamic_tool_call",
]);

const CONVERSATION_TURN_ITEM_TYPES = new Set<string>([
  "user_message",
  "assistant_message",
  "reasoning",
  "proposed_plan",
]);

const CLAUDE_MODEL_PATTERN = /claude|anthropic/i;

export type ContextLayerRatios = readonly [
  system: number,
  conversation: number,
  toolOutput: number,
];
export type VialTickLabels = readonly [quarter: string, half: string, threeQuarter: string];
export type QuotaStatusKind = "low" | "tight" | "ok";

export interface QuotaStatus {
  readonly status: QuotaStatusKind;
  readonly label: string;
}

export interface ContextLayerSignals {
  readonly toolItemCount: number;
  readonly conversationItemCount: number;
}

export interface ComposerTelemetrySummary {
  readonly fill: number;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly tokensPerSecond: number | null;
  readonly cacheHitRate: number | null;
  readonly ratios: ContextLayerRatios;
  readonly tickLabels: VialTickLabels | null;
  readonly camp: VialCamp;
  readonly isCritical: boolean;
  readonly isWarning: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toEpochMillis(value: DateTime.Utc | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "string" ? Date.parse(value) : DateTime.toEpochMillis(value);
  return Number.isFinite(ms) ? ms : null;
}

function matchingProviderTurns<T extends Pick<OrchestrationV2ProviderTurn, "providerThreadId">>(
  turns: ReadonlyArray<T>,
  activeProviderThreadId: ProviderThreadId | null | undefined,
): ReadonlyArray<T> {
  if (activeProviderThreadId == null) return turns;
  return turns.filter((turn) => turn.providerThreadId === activeProviderThreadId);
}

/** Derives output tok/s from latest turn timings or contextWindow.durationMs; null when unavailable. */
export function deriveOutputTokensPerSecond(input: {
  readonly providerTurns?:
    | ReadonlyArray<
        Pick<
          OrchestrationV2ProviderTurn,
          | "providerThreadId"
          | "ordinal"
          | "startedAt"
          | "completedAt"
          | "tokenUsage"
          | "turnTokenUsage"
        >
      >
    | undefined;
  readonly activeProviderThreadId?: ProviderThreadId | null | undefined;
  readonly contextWindow: Pick<
    ContextWindowSnapshot,
    "outputTokens" | "lastOutputTokens" | "durationMs"
  > | null;
}): number | null {
  const candidates = matchingProviderTurns(input.providerTurns ?? [], input.activeProviderThreadId);
  let best: { readonly ordinal: number; readonly updatedMs: number; readonly tps: number } | null =
    null;

  for (const turn of candidates) {
    const outputTokens = turn.turnTokenUsage?.outputTokens ?? turn.tokenUsage?.outputTokens ?? null;
    if (outputTokens === null || !Number.isFinite(outputTokens) || outputTokens <= 0) continue;
    const startMs = toEpochMillis(turn.startedAt);
    const endMs =
      toEpochMillis(turn.completedAt) ?? toEpochMillis(turn.tokenUsage?.updatedAt ?? null);
    if (startMs === null || endMs === null) continue;
    const durationMs = endMs - startMs;
    if (durationMs < MIN_DURATION_MS_FOR_TPS) continue;
    const tps = outputTokens / (durationMs / 1000);
    if (!Number.isFinite(tps) || tps <= 0) continue;
    const updatedMs = endMs;
    if (
      best === null ||
      turn.ordinal > best.ordinal ||
      (turn.ordinal === best.ordinal && updatedMs >= best.updatedMs)
    ) {
      best = { ordinal: turn.ordinal, updatedMs, tps };
    }
  }
  if (best !== null) return best.tps;

  const cw = input.contextWindow;
  if (!cw) return null;
  const outputTokens = cw.lastOutputTokens ?? cw.outputTokens ?? null;
  const durationMs = cw.durationMs ?? null;
  if (
    outputTokens === null ||
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0 ||
    durationMs === null ||
    !Number.isFinite(durationMs) ||
    durationMs < MIN_DURATION_MS_FOR_TPS
  ) {
    return null;
  }
  const tps = outputTokens / (durationMs / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : null;
}

/** Derives prompt cache hit rate (0..1) from cached vs. total input tokens; null when absent. */
export function deriveCacheHitRate(input: {
  readonly providerTurns?:
    | ReadonlyArray<
        Pick<
          OrchestrationV2ProviderTurn,
          "providerThreadId" | "ordinal" | "tokenUsage" | "turnTokenUsage"
        >
      >
    | undefined;
  readonly activeProviderThreadId?: ProviderThreadId | null | undefined;
  readonly contextWindow: Pick<
    ContextWindowSnapshot,
    "inputTokens" | "cachedInputTokens" | "lastInputTokens" | "lastCachedInputTokens"
  > | null;
}): number | null {
  const candidates = matchingProviderTurns(input.providerTurns ?? [], input.activeProviderThreadId);
  let best: { readonly ordinal: number; readonly rate: number } | null = null;
  for (const turn of candidates) {
    const cached =
      turn.turnTokenUsage?.cachedInputTokens ?? turn.tokenUsage?.cachedInputTokens ?? null;
    const totalInput = turn.turnTokenUsage?.inputTokens ?? turn.tokenUsage?.inputTokens ?? null;
    if (
      cached === null ||
      totalInput === null ||
      !Number.isFinite(cached) ||
      !Number.isFinite(totalInput) ||
      cached < 0 ||
      totalInput <= 0
    ) {
      continue;
    }
    const rate = clamp(cached / Math.max(totalInput, cached), 0, 1);
    if (best === null || turn.ordinal >= best.ordinal) {
      best = { ordinal: turn.ordinal, rate };
    }
  }
  if (best !== null) return best.rate;

  const cw = input.contextWindow;
  if (!cw) return null;
  const cached = cw.lastCachedInputTokens ?? cw.cachedInputTokens ?? null;
  const totalInput = cw.lastInputTokens ?? cw.inputTokens ?? null;
  if (
    cached === null ||
    totalInput === null ||
    !Number.isFinite(cached) ||
    !Number.isFinite(totalInput) ||
    cached < 0 ||
    totalInput <= 0
  ) {
    return null;
  }
  return clamp(cached / Math.max(totalInput, cached), 0, 1);
}

export function countContextLayerSignals(
  visibleTurnItems: ReadonlyArray<Pick<ThreadStructureVisibleTurnItem, "item">>,
): ContextLayerSignals {
  let toolItemCount = 0;
  let conversationItemCount = 0;
  for (const entry of visibleTurnItems) {
    const type = entry.item.type;
    if (TOOL_TURN_ITEM_TYPES.has(type)) toolItemCount += 1;
    else if (CONVERSATION_TURN_ITEM_TYPES.has(type)) conversationItemCount += 1;
  }
  return { toolItemCount, conversationItemCount };
}

/**
 * Estimates [system, conversation, toolOutput] window fractions from aggregate context usage:
 * ~14k bounded system overhead (2%-12% of window, <=34% of used), remainder split by tool vs. message count.
 */
export function deriveContextLayerRatios(input: {
  readonly usedFraction: number;
  readonly maxTokens: number | null;
  readonly toolUses?: number | null | undefined;
  readonly toolItemCount?: number | null | undefined;
  readonly conversationItemCount?: number | null | undefined;
}): ContextLayerRatios {
  const total = Number.isFinite(input.usedFraction) ? clamp(input.usedFraction, 0, 1) : 0;
  if (total <= 0) return [0, 0, 0];

  const windowSize =
    input.maxTokens !== null && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : DEFAULT_MAX_TOKENS;
  const system = Math.min(
    total * 0.34,
    clamp(ESTIMATED_SYSTEM_OVERHEAD_TOKENS / windowSize, 0.02, 0.12),
  );
  const rest = Math.max(0, total - system);

  const hasToolSignal =
    (input.toolItemCount !== null && input.toolItemCount !== undefined) ||
    (input.toolUses !== null && input.toolUses !== undefined);
  let toolShare = DEFAULT_TOOL_SHARE;
  if (hasToolSignal) {
    const toolSignal = Math.max(0, input.toolItemCount ?? 0, input.toolUses ?? 0);
    const convSignal = Math.max(0, input.conversationItemCount ?? 0);
    if (toolSignal === 0 && convSignal > 0) {
      toolShare = 0;
    } else if (toolSignal > 0) {
      toolShare = clamp(toolSignal / (toolSignal + Math.max(1, convSignal)), 0.14, 0.52);
    }
  }

  const toolOutput = rest * toolShare;
  const conversation = Math.max(0, rest - toolOutput);
  return [system, conversation, toolOutput];
}

export function formatVialTickTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 10_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${Math.round(tokens)}`;
}

/** Formats 25% / 50% / 75% graduation marks scaled to the model's context window. */
export function deriveVialTickLabels(maxTokens: number | null): VialTickLabels | null {
  if (maxTokens === null || !Number.isFinite(maxTokens) || maxTokens <= 0) return null;
  return [
    formatVialTickTokens(maxTokens * 0.25),
    formatVialTickTokens(maxTokens * 0.5),
    formatVialTickTokens(maxTokens * 0.75),
  ];
}

export function detectVialCamp(modelOrProvider: string | null | undefined): VialCamp {
  return modelOrProvider && CLAUDE_MODEL_PATTERN.test(modelOrProvider) ? "claude" : "gemini";
}

export function deriveWindowQuotaStatus(window: ServerProviderUsageWindow): QuotaStatusKind {
  const left = remainingPercent(window);
  if (left <= 15) return "low";
  if (left <= 35) return "tight";
  return "ok";
}

export function deriveQuotaStatus(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): QuotaStatus | null {
  if (windows.length === 0) return null;
  let minLeft = 100;
  for (const window of windows) {
    const left = remainingPercent(window);
    if (left < minLeft) minLeft = left;
  }
  if (minLeft <= 15) return { status: "low", label: "Low quota" };
  if (minLeft <= 35) return { status: "tight", label: "Tight" };
  return { status: "ok", label: "Healthy" };
}

export function formatTokensPerSecond(tps: number | null): string | null {
  if (tps === null || !Number.isFinite(tps) || tps <= 0) return null;
  return `${tps.toFixed(1)} tok/s`;
}

export function formatCacheHitRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate) || rate < 0) return null;
  return `${(clamp(rate, 0, 1) * 100).toFixed(1)}%`;
}

export function deriveComposerTelemetry(input: {
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly providerTurns?:
    | ReadonlyArray<
        Pick<
          OrchestrationV2ProviderTurn,
          | "providerThreadId"
          | "ordinal"
          | "startedAt"
          | "completedAt"
          | "tokenUsage"
          | "turnTokenUsage"
        >
      >
    | undefined;
  readonly activeProviderThreadId?: ProviderThreadId | null | undefined;
  readonly visibleTurnItems?:
    | ReadonlyArray<Pick<ThreadStructureVisibleTurnItem, "item">>
    | undefined;
  readonly modelOrProvider?: string | null | undefined;
}): ComposerTelemetrySummary | null {
  const cw = input.contextWindow;
  if (!cw) return null;

  const maxTokens = cw.maxTokens != null && cw.maxTokens > 0 ? cw.maxTokens : null;
  const rawFraction =
    cw.usedPercentage !== null && Number.isFinite(cw.usedPercentage)
      ? clamp(cw.usedPercentage / 100, 0, 1)
      : maxTokens !== null
        ? clamp(cw.usedTokens / maxTokens, 0, 1)
        : 0;
  const usedPercent = maxTokens !== null ? Math.round(rawFraction * 100) : null;
  const remaining = usedPercent !== null ? Math.max(0, 100 - usedPercent) : null;
  const signals = input.visibleTurnItems ? countContextLayerSignals(input.visibleTurnItems) : null;

  return {
    fill: rawFraction,
    usedPercent,
    remainingPercent: remaining,
    usedTokens: cw.usedTokens,
    maxTokens,
    tokensPerSecond: deriveOutputTokensPerSecond({
      providerTurns: input.providerTurns,
      activeProviderThreadId: input.activeProviderThreadId,
      contextWindow: cw,
    }),
    cacheHitRate: deriveCacheHitRate({
      providerTurns: input.providerTurns,
      activeProviderThreadId: input.activeProviderThreadId,
      contextWindow: cw,
    }),
    ratios: deriveContextLayerRatios({
      usedFraction: rawFraction,
      maxTokens,
      toolUses: cw.toolUses ?? null,
      toolItemCount: signals?.toolItemCount ?? null,
      conversationItemCount: signals?.conversationItemCount ?? null,
    }),
    tickLabels: deriveVialTickLabels(maxTokens),
    camp: detectVialCamp(input.modelOrProvider),
    isCritical: rawFraction >= 0.85,
    isWarning: rawFraction >= 0.8,
  };
}
