import type {
  EnvironmentId,
  OrchestrationV2ProviderTurn,
  ProviderInstanceId,
  ProviderThreadId,
  ServerProvider,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/models";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { Minimize2Icon } from "lucide-react";
import { memo, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { OpticalContextVial } from "../../optical/OpticalContextVial";
import { useServerConfigs } from "../../state/entities";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  deriveComposerTelemetry,
  deriveQuotaStatus,
  formatCacheHitRate,
  formatTokensPerSecond,
  type QuotaStatusKind,
} from "./composerTelemetry.logic";
import { ProviderUsageLimitRows, resolveProviderInstanceLimits } from "./ThreadDetailsUsage";

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const SLICE_META = [
  { label: "System", fullLabel: "System & Rules", colorClass: "bg-primary/55" },
  { label: "Messages", fullLabel: "Messages", colorClass: "bg-primary" },
  { label: "Tools", fullLabel: "Tool Output", colorClass: "bg-info" },
] as const;

const QUOTA_BADGE_CLASS: Record<QuotaStatusKind, string> = {
  low: "bg-error-surface text-error-foreground",
  tight: "bg-warning-surface text-warning-foreground",
  ok: "bg-success/15 text-success-foreground",
};

const EMPTY_USAGE_LIMIT_SOURCES: UsageLimitSourceSnapshots = [];

export interface ComposerTelemetryVialProps {
  readonly environmentId: EnvironmentId;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly providerTurns?: ReadonlyArray<OrchestrationV2ProviderTurn> | undefined;
  readonly activeProviderThreadId?: ProviderThreadId | null | undefined;
  readonly visibleTurnItems?: ReadonlyArray<ThreadStructureVisibleTurnItem> | undefined;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Optional override for tests; defaults to the environment server config's usageLimitSources. */
  readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
  readonly modelLabel: string;
  readonly modelSlug: string;
  readonly isStreaming: boolean;
  readonly compactDisabled: boolean;
  readonly onCompactContext: () => void;
}

function ContextRing({
  fill,
  isWarning,
  isCritical,
}: {
  readonly fill: number;
  readonly isWarning: boolean;
  readonly isCritical: boolean;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fill) ? fill : 0));
  const dashOffset = RING_CIRCUMFERENCE * (1 - clamped);
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className="size-3.5 shrink-0 -rotate-90"
    >
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth="1.75"
        className="text-muted-foreground/25"
      />
      {clamped > 0 ? (
        <circle
          cx="7"
          cy="7"
          r={RING_RADIUS}
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          className={cn(isCritical ? "text-error" : isWarning ? "text-warning" : "text-primary")}
        />
      ) : null}
    </svg>
  );
}

export const ComposerTelemetryVial = memo(function ComposerTelemetryVial({
  environmentId,
  contextWindow,
  providerTurns,
  activeProviderThreadId,
  visibleTurnItems,
  providerInstanceId,
  providers,
  usageLimitSources,
  modelLabel,
  modelSlug,
  isStreaming,
  compactDisabled,
  onCompactContext,
}: ComposerTelemetryVialProps) {
  const [open, setOpen] = useState(false);
  const [hoveredSlice, setHoveredSlice] = useState<number>(-1);
  const serverConfig = useServerConfigs().get(environmentId);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);

  const telemetry = deriveComposerTelemetry({
    contextWindow,
    providerTurns,
    activeProviderThreadId,
    visibleTurnItems,
    modelOrProvider: `${modelSlug} ${modelLabel}`,
  });

  if (!telemetry || !contextWindow) return null;

  const sources = usageLimitSources ?? serverConfig?.usageLimitSources ?? EMPTY_USAGE_LIMIT_SOURCES;
  const limits = resolveProviderInstanceLimits({
    providerInstanceId,
    providers,
    sources,
    now,
  });
  const activeProvider =
    providerInstanceId !== null
      ? providers.find((provider) => provider.instanceId === providerInstanceId)
      : undefined;
  const providerDisplayName =
    activeProvider?.displayName?.trim() ||
    (activeProvider ? providerClients.get(activeProvider.driver)?.label : undefined) ||
    "Provider";
  const quotaStatus =
    limits && limitsNotice(limits) === null ? deriveQuotaStatus(limits.windows) : null;

  const tpsText = formatTokensPerSecond(telemetry.tokensPerSecond);
  const cacheText = formatCacheHitRate(telemetry.cacheHitRate);
  const usedTokensText = formatContextWindowTokens(telemetry.usedTokens);
  const maxTokensText =
    telemetry.maxTokens !== null ? formatContextWindowTokens(telemetry.maxTokens) : null;
  const compactPercentText =
    telemetry.usedPercent !== null ? `${telemetry.usedPercent}%` : usedTokensText;
  const autoCompactThreshold = contextWindow.autoCompactThreshold ?? null;
  const thresholdPercent =
    telemetry.maxTokens !== null &&
    autoCompactThreshold !== null &&
    autoCompactThreshold > 0 &&
    autoCompactThreshold < telemetry.maxTokens
      ? (autoCompactThreshold / telemetry.maxTokens) * 100
      : 85;

  const ariaSummary = [
    telemetry.usedPercent !== null
      ? `Context window ${telemetry.usedPercent}% used`
      : `Context window ${usedTokensText} tokens used`,
    tpsText,
    cacheText ? `cache ${cacheText}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const activeSliceMeta = hoveredSlice >= 0 ? SLICE_META[hoveredSlice] : null;
  const activeSliceRatio = hoveredSlice >= 0 ? (telemetry.ratios[hoveredSlice] ?? 0) : 0;
  const activeSliceTokens =
    telemetry.maxTokens !== null
      ? Math.round(activeSliceRatio * telemetry.maxTokens)
      : telemetry.fill > 0
        ? Math.round((activeSliceRatio / telemetry.fill) * telemetry.usedTokens)
        : 0;

  const handleCompactClick = () => {
    if (compactDisabled) return;
    setOpen(false);
    onCompactContext();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setHoveredSlice(-1);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            data-composer-telemetry-trigger="true"
            aria-label={ariaSummary}
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-transparent px-1.5 text-xs tabular-nums text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground @md/composer-surface:px-2",
              telemetry.isCritical && "text-error-foreground",
              !telemetry.isCritical && telemetry.isWarning && "text-warning-foreground",
            )}
          />
        }
      >
        {tpsText ? (
          <span
            data-composer-telemetry-tps="true"
            className="hidden items-baseline gap-1 whitespace-nowrap @lg/composer-surface:inline-flex"
          >
            <span className="font-medium text-foreground/85">
              {telemetry.tokensPerSecond!.toFixed(1)}
            </span>
            <span className="text-2xs text-muted-foreground">tok/s</span>
          </span>
        ) : null}
        {tpsText && cacheText ? (
          <span
            aria-hidden="true"
            className="hidden text-muted-foreground/45 @xl/composer-surface:inline"
          >
            ·
          </span>
        ) : null}
        {cacheText ? (
          <span
            data-composer-telemetry-cache="true"
            className="hidden items-baseline gap-1 whitespace-nowrap @xl/composer-surface:inline-flex"
          >
            <span className="text-2xs text-muted-foreground">cache</span>
            <span className="font-medium text-foreground/85">{cacheText}</span>
          </span>
        ) : null}
        {tpsText || cacheText ? (
          <span
            aria-hidden="true"
            className={cn(
              "hidden text-muted-foreground/45",
              tpsText ? "@lg/composer-surface:inline" : "@xl/composer-surface:inline",
            )}
          >
            ·
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <ContextRing
            fill={telemetry.fill}
            isWarning={telemetry.isWarning}
            isCritical={telemetry.isCritical}
          />
          <span
            data-composer-telemetry-percent="true"
            className={cn(
              "hidden font-medium @md/composer-surface:inline",
              telemetry.isCritical
                ? "text-error-foreground"
                : telemetry.isWarning
                  ? "text-warning-foreground"
                  : "text-foreground/85",
            )}
          >
            {compactPercentText}
          </span>
        </span>
      </PopoverTrigger>

      <PopoverPopup
        side="top"
        align="end"
        sideOffset={8}
        width="md"
        padding="compact"
        {...composerFloatingLayerProps}
      >
        <div data-composer-telemetry-popover="true" className="flex flex-col gap-2.5 py-1">
          <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3">
            <div className="flex flex-col items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-1.5 py-2">
              <div className="flex w-full items-baseline justify-between px-0.5 text-2xs tabular-nums">
                <span className="font-medium tracking-wide text-muted-foreground">CTX</span>
                <span
                  className={cn(
                    "font-semibold",
                    telemetry.isCritical
                      ? "text-error-foreground"
                      : telemetry.isWarning
                        ? "text-warning-foreground"
                        : "text-foreground",
                  )}
                >
                  {compactPercentText}
                </span>
              </div>
              <OpticalContextVial
                fill={telemetry.fill}
                usedPercent={telemetry.usedPercent}
                isStreaming={isStreaming}
                isCritical={telemetry.isCritical}
                ratios={telemetry.ratios}
                hoveredSlice={hoveredSlice}
                camp={telemetry.camp}
                tickLabels={telemetry.tickLabels ?? undefined}
                className="h-36 w-20 shrink-0"
              />
              <span className="max-w-full truncate text-2xs text-muted-foreground tabular-nums">
                {tpsText ?? (isStreaming ? "Streaming" : "Idle")}
              </span>
            </div>

            <div className="flex min-w-0 flex-col justify-between gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">Context window</span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={compactDisabled}
                          onClick={handleCompactClick}
                        >
                          <Minimize2Icon className="size-3" aria-hidden="true" />
                          Compact
                        </Button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    {compactDisabled
                      ? "Compaction is unavailable right now"
                      : "Summarize conversation history (/compact)"}
                  </TooltipPopup>
                </Tooltip>
              </div>

              <div className="flex flex-col gap-0.5 tabular-nums">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-semibold text-foreground">
                    {telemetry.usedPercent !== null
                      ? `${telemetry.usedPercent}% used`
                      : `${usedTokensText} used`}
                  </span>
                  {telemetry.remainingPercent !== null ? (
                    <span className="text-xs text-muted-foreground">
                      · {telemetry.remainingPercent}% left
                    </span>
                  ) : null}
                </div>
                <span className="text-xs text-muted-foreground">
                  {maxTokensText
                    ? `${usedTokensText} / ${maxTokensText} tokens`
                    : `${usedTokensText} tokens`}
                </span>
                {autoCompactThreshold !== null && autoCompactThreshold > 0 ? (
                  <span className="text-2xs text-muted-foreground">
                    {formatContextWindowCompactionMessage(autoCompactThreshold)}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <div
                  role="group"
                  aria-label="Estimated context breakdown"
                  className="relative flex h-2 w-full overflow-hidden rounded-full bg-muted"
                >
                  {SLICE_META.map((slice, index) => {
                    const ratio = telemetry.ratios[index] ?? 0;
                    if (ratio <= 0.001) return null;
                    return (
                      <span
                        key={slice.label}
                        data-context-slice={index}
                        data-hovered={hoveredSlice === index ? "true" : undefined}
                        onPointerEnter={() => setHoveredSlice(index)}
                        onPointerLeave={() =>
                          setHoveredSlice((current) => (current === index ? -1 : current))
                        }
                        className={cn(
                          "h-full transition-opacity",
                          slice.colorClass,
                          hoveredSlice >= 0 && hoveredSlice !== index && "opacity-40",
                        )}
                        style={{ width: `${Math.min(100, ratio * 100)}%` }}
                      />
                    );
                  })}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 w-px bg-warning/80"
                    style={{ left: `${Math.min(98, Math.max(2, thresholdPercent))}%` }}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  {SLICE_META.map((slice, index) => {
                    const ratio = telemetry.ratios[index] ?? 0;
                    const isActive = hoveredSlice === index;
                    return (
                      <button
                        key={slice.label}
                        type="button"
                        data-context-slice-chip={index}
                        onPointerEnter={() => setHoveredSlice(index)}
                        onPointerLeave={() =>
                          setHoveredSlice((current) => (current === index ? -1 : current))
                        }
                        onFocus={() => setHoveredSlice(index)}
                        onBlur={() =>
                          setHoveredSlice((current) => (current === index ? -1 : current))
                        }
                        className={cn(
                          "inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-2xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                          isActive && "bg-accent text-foreground",
                          ratio <= 0.001 && "opacity-50",
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn("size-1.5 rounded-full", slice.colorClass)}
                        />
                        {slice.label}
                      </button>
                    );
                  })}
                </div>

                <div className="min-h-4 truncate text-2xs text-muted-foreground tabular-nums">
                  {activeSliceMeta ? (
                    <span>
                      {activeSliceMeta.fullLabel} · ~{formatContextWindowTokens(activeSliceTokens)}{" "}
                      ({(activeSliceRatio * 100).toFixed(1)}%)
                    </span>
                  ) : (
                    <span>
                      {[tpsText, cacheText ? `Cache ${cacheText}` : null]
                        .filter(Boolean)
                        .join(" · ") || "Estimated layer breakdown"}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-1.5 text-2xs">
                <span className="shrink-0 text-muted-foreground">Model</span>
                <span className="truncate font-medium text-foreground">{modelLabel}</span>
              </div>
            </div>
          </div>

          {limits ? (
            <div
              data-composer-telemetry-quotas="true"
              className="flex flex-col gap-1 border-t border-border/60 pt-2"
            >
              <div className="flex items-center justify-between gap-2 px-1.5">
                <span className="truncate text-xs font-medium text-foreground">
                  {providerDisplayName}
                </span>
                {quotaStatus ? (
                  <span
                    data-quota-status={quotaStatus.status}
                    className={cn(
                      "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-3xs font-medium leading-none",
                      QUOTA_BADGE_CLASS[quotaStatus.status],
                    )}
                  >
                    {quotaStatus.label}
                  </span>
                ) : null}
              </div>
              <ProviderUsageLimitRows
                limits={limits}
                now={now}
                showResetCountdown
                tooltipSide="top"
                compactPadding
              />
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
