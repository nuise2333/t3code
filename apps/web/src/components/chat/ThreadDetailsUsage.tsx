import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { deriveContextLayerRatios, deriveWindowQuotaStatus } from "./composerTelemetry.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { OpticalContextVial } from "../../optical/OpticalContextVial";
import { useOpticalConfig } from "../../optical/config";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly isStreaming?: boolean | undefined;
}

type UsageTone = "error" | "warning" | null;

/** Resolves usage limits for one provider instance without mixing in other accounts. */
export function resolveProviderInstanceLimits(input: {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly now: number;
}): ServerProviderUsageLimits | null {
  const { providerInstanceId, providers, sources, now } = input;
  if (providerInstanceId === null) return null;
  const report = collectProviderUsageLimits(providerInstanceId, providers, sources, now);
  return (
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits ??
    null
  );
}

/** Shared compact quota window rows reused by ThreadDetailsUsage and the composer vial popover. */
export function ProviderUsageLimitRows({
  limits,
  now,
  showResetCountdown = false,
  tooltipSide = "left",
  compactPadding = false,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly now: number;
  readonly showResetCountdown?: boolean;
  readonly tooltipSide?: "top" | "bottom" | "left" | "right";
  readonly compactPadding?: boolean;
}) {
  const notice = limitsNotice(limits);
  return (
    <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
      {notice ? (
        <UsageRow
          label="Limits"
          fill={null}
          tone={null}
          value="Unavailable"
          tooltipSide={tooltipSide}
          compactPadding={compactPadding}
          tooltip={<span className="text-foreground">{notice}</span>}
        />
      ) : (
        limits.windows.map((window) => (
          <LimitRow
            key={window.id}
            window={window}
            now={now}
            showResetCountdown={showResetCountdown}
            tooltipSide={tooltipSide}
            compactPadding={compactPadding}
          />
        ))
      )}
    </div>
  );
}

/** The selected provider's limit windows. Each row reads as room left. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const limits = resolveProviderInstanceLimits({ providerInstanceId, providers, sources, now });
  if (!limits) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage limits"
      showHeading={false}
    >
      <ProviderUsageLimitRows limits={limits} now={now} />
    </ThreadDetailsSection>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({
  usage,
  isStreaming = false,
}: {
  readonly usage: ContextWindowSnapshot;
  readonly isStreaming?: boolean | undefined;
}) {
  const opticalConfig = useOpticalConfig();
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  const showVial = opticalConfig.ambientIntensity > 0 && used !== null;
  const contextRow = (
    <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
      <UsageRow
        label="Context"
        fill={used}
        tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
        tick={tick}
        muted
        value={
          maxTokens !== null
            ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
            : usedTokens
        }
        ariaValue={used !== null ? `${used}% used` : `${usedTokens} tokens used`}
        tooltip={
          <>
            <span className="text-foreground">
              {used !== null ? `Context: ${used}% used` : `Context: ${usedTokens} tokens used`}
            </span>
            {maxTokens !== null ? (
              <span className="text-muted-foreground">
                {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")}{" "}
                tokens
              </span>
            ) : null}
            {threshold !== null && threshold > 0 ? (
              <span className="text-muted-foreground">
                {formatContextWindowCompactionMessage(threshold)}
              </span>
            ) : null}
          </>
        }
      />
    </div>
  );
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context window"
      showHeading={false}
    >
      {showVial ? (
        <div className="flex items-center gap-2 pl-2">
          <OpticalContextVial
            fill={used / 100}
            usedPercent={used}
            isStreaming={isStreaming}
            isCritical={used >= 85}
            ratios={deriveContextLayerRatios({
              usedFraction: used / 100,
              maxTokens,
              toolUses: usage.toolUses ?? null,
            })}
            className="h-14 w-8 shrink-0"
          />
          {contextRow}
        </div>
      ) : (
        contextRow
      )}
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
  showResetCountdown = false,
  tooltipSide = "left",
  compactPadding = false,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly showResetCountdown?: boolean;
  readonly tooltipSide?: "top" | "bottom" | "left" | "right";
  readonly compactPadding?: boolean;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const status = deriveWindowQuotaStatus(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const resetCountdown =
    showResetCountdown && window.resetsAt && resetsAt > now ? formatDuration(resetsAt - now) : null;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={status === "low" ? "error" : status === "tight" ? "warning" : null}
      value={resetCountdown ? `${left}% · ${resetCountdown}` : `${left}%`}
      ariaValue={`${left}% left`}
      tooltipSide={tooltipSide}
      compactPadding={compactPadding}
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              Resets in {formatDuration(resetsAt - now)} ·{" "}
              {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
  tooltipSide = "left",
  compactPadding = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
  readonly tooltipSide?: "top" | "bottom" | "left" | "right";
  readonly compactPadding?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className={cn(
              "col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
              compactPadding ? "px-1.5" : "px-2.5",
            )}
          />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground">{label}</span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                style={{ left: `${tick}%` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side={tooltipSide} sideOffset={tooltipSide === "left" ? 16 : 8}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
