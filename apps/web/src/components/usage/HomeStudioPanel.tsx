import { useAtomValue } from "@effect/atom-react";
import type { UsageSummaryInput } from "@t3tools/contracts";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  makeWindow,
} from "@t3tools/shared/usageFormat";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  formatResetsIn,
  paceRemainingPercent,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { useRef, useState, type CSSProperties, type PointerEvent } from "react";

import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { mergeAnsweredUsage, useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { providerClients } from "../settings/providerDriverMeta";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  HOME_STUDIO_FOOTNOTE_CLASS,
  HOME_STUDIO_HEAT_SIZE_CLASS,
  HOME_STUDIO_OVERVIEW_CLASS,
  HOME_STUDIO_STAT_LIST_CLASS,
  HomeStudioPanelFrame,
  HomeStudioStatsSkeleton,
} from "./HomeStudioPanelFrame";
import {
  HOME_HEAT_WEEKS,
  HOME_HEAT_WINDOW_DAYS,
  HOME_MODEL_ROWS,
  HOME_RANGES,
  assignModelColors,
  axisLabelIndexes,
  axisMax,
  bookLine,
  buildHeatCells,
  chartDays,
  countActiveDays,
  heatTipPosition,
  quotaHealthLabel,
  quotaWarnLevel,
  type HeatCell,
  type HomeRangeId,
  type QuotaWarnLevel,
} from "./homeStudioPanel.logic";
import { cacheHitRate, sortModelsByTokens } from "./usageBreakdown";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { PaceIcon } from "./UsageLimits";

type HomeTab = "overview" | "models" | "quotas";

const TABS: ReadonlyArray<{ readonly id: HomeTab; readonly label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "quotas", label: "Quotas" },
];

const HEAT_LEVEL_CLASS = [
  "bg-muted-foreground/10",
  "bg-primary/22",
  "bg-primary/42",
  "bg-primary/64",
  "bg-primary/86",
  "bg-[color-mix(in_srgb,var(--primary)_86%,var(--foreground))]",
] as const;

const MODEL_COLOR_CLASS = [
  "bg-[#2563EB] dark:bg-[#4F8BFF]",
  "bg-[#0284C7] dark:bg-[#58C4F6]",
  "bg-[#059669] dark:bg-[#4CC39A]",
  "bg-[#7C3AED] dark:bg-[#8E84F5]",
  "bg-[#3B66A8] dark:bg-[#7AA2D4]",
  "bg-[#D97706] dark:bg-[#E2B354]",
  "bg-[#1D4ED8] dark:bg-[#3B9EE8]",
  "bg-[#4361EE] dark:bg-[#6B93D6]",
  "bg-[#0D9488] dark:bg-[#5BC4BE]",
  "bg-[#475569] dark:bg-[#8C99B0]",
] as const;
const OTHER_MODELS_CLASS = "bg-muted-foreground/35";
const CHART_SERIES = 9;

const QUOTA_BAR_CLASS: Record<QuotaWarnLevel, string> = {
  0: "bg-primary",
  1: "bg-warning",
  2: "bg-destructive",
};
const QUOTA_BADGE_VARIANT = { 0: "success", 1: "warning", 2: "error" } as const;

function modelKey(model: { readonly provider: string; readonly model: string }) {
  return `${model.provider}:${model.model}`;
}

function mergedOf(view: ReturnType<typeof useUsage>): MergedUsage | null {
  return view.shown?.merged ?? null;
}

export function HomeStudioPanel() {
  const [tab, setTab] = useState<HomeTab>("overview");
  const [range, setRange] = useState<HomeRangeId>("all");
  const [windows] = useState(() => {
    const all = makeWindow(HOME_HEAT_WINDOW_DAYS);
    return {
      all,
      "30d": makeWindow(30),
      "7d": makeWindow(7),
    } satisfies Record<HomeRangeId, UsageSummaryInput>;
  });
  // One book per visit, like the original panel.
  const [bookPick] = useState(Math.random);
  // Countdowns advance on tab open and refresh only, so the panel never repaints on a timer.
  const [now, setNow] = useState(Date.now);
  const [refreshingLimits, setRefreshingLimits] = useState(false);
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const heatView = useUsage(windows.all);
  const rangeView = useUsage(windows[range]);

  const noUsageAccess =
    heatView.environments.length > 0 &&
    heatView.environments.every(
      (environment) => !environment.canReadDiagnostics && !environment.isPending,
    );
  if (noUsageAccess) return null;

  const refreshLimits = (automatic: boolean) => {
    if (refreshingLimits) return;
    setRefreshingLimits(true);
    void Promise.allSettled(
      Array.from(presentations, ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null
          ? refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            )
          : undefined,
      ),
    ).then(() => {
      setNow(Date.now());
      setRefreshingLimits(false);
    });
  };

  const selectTab = (next: HomeTab) => {
    setTab(next);
    if (next === "quotas") {
      setNow(Date.now());
      refreshLimits(true);
    }
  };

  return (
    <HomeStudioPanelFrame entrance>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <ToggleGroup
          aria-label="Usage view"
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            const value = TABS.find((entry) => entry.id === next[0]);
            if (value) selectTab(value.id);
          }}
        >
          {TABS.map((entry) => (
            <Toggle key={entry.id} value={entry.id}>
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
        {tab === "quotas" ? null : (
          <ToggleGroup
            aria-label="Usage range"
            variant="segmented"
            value={[range]}
            onValueChange={(next) => {
              const value = HOME_RANGES.find((entry) => entry.id === next[0]);
              if (value) setRange(value.id);
            }}
          >
            {HOME_RANGES.map((entry) => (
              <Tooltip key={entry.id}>
                <TooltipTrigger render={<Toggle value={entry.id} />}>{entry.label}</TooltipTrigger>
                <TooltipPopup side="top">{entry.title}</TooltipPopup>
              </Tooltip>
            ))}
          </ToggleGroup>
        )}
      </div>
      <div key={tab} data-home-studio-motion="swap" className="flex flex-col gap-2">
        {tab === "overview" ? (
          <OverviewTab
            untilDay={windows.all.untilDay}
            sinceDay={windows[range].sinceDay}
            rangeUsage={mergedOf(rangeView)}
            heatUsage={mergedOf(heatView)}
            bookPick={bookPick}
          />
        ) : tab === "models" ? (
          <ModelsTab
            range={range}
            untilDay={windows.all.untilDay}
            rangeUsage={mergedOf(rangeView)}
            chartEnvironments={heatView.shown ? heatView.selectedEnvironments : null}
          />
        ) : (
          <QuotasTab
            pools={collectLimitPools(collectLimitAccounts(presentations), now)}
            now={now}
            refreshing={refreshingLimits}
            onRefresh={() => refreshLimits(false)}
          />
        )}
      </div>
    </HomeStudioPanelFrame>
  );
}

function OverviewTab({
  untilDay,
  sinceDay,
  rangeUsage,
  heatUsage,
  bookPick,
}: {
  readonly untilDay: string;
  readonly sinceDay: string;
  readonly rangeUsage: MergedUsage | null;
  readonly heatUsage: MergedUsage | null;
  readonly bookPick: number;
}) {
  if (rangeUsage === null || heatUsage === null) return <HomeStudioStatsSkeleton />;
  const input =
    rangeUsage.uncachedInputTokens + rangeUsage.cachedInputTokens + rangeUsage.cacheCreationTokens;
  const topModel = sortModelsByTokens(rangeUsage.models)[0] ?? null;
  const activeDays = countActiveDays(rangeUsage.daily, sinceDay);
  const book = bookLine(rangeUsage.totalTokens, bookPick);
  // T3 does not split subagent usage from the main thread or record a per-workspace total, so
  // the original panel's swarm share and workspace filter are left out.
  const stats: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly title: string;
    readonly text?: boolean;
  }> = [
    {
      key: "sessions",
      label: "Sessions",
      value: formatCount(rangeUsage.sessions),
      title: `${formatCount(rangeUsage.sessions)} sessions`,
    },
    {
      // Usage records are one per model response, the closest T3 has to a message count.
      key: "messages",
      label: "Messages",
      value: formatCount(rangeUsage.records),
      title: `${formatCount(rangeUsage.records)} model responses`,
    },
    {
      key: "tokens",
      label: "Total tokens",
      value: formatTokens(rangeUsage.totalTokens),
      title: `${formatCount(rangeUsage.totalTokens)} tokens`,
    },
    {
      key: "days",
      label: "Active days",
      value: formatCount(activeDays),
      title: `${formatCount(activeDays)} days with usage`,
    },
    {
      key: "cache",
      label: "Cache hit rate",
      value: input > 0 ? formatPercent(rangeUsage.cachedInputTokens / input) : "None",
      title: `Cache reads: ${formatTokens(rangeUsage.cachedInputTokens)} / ${formatTokens(input)} input`,
    },
    {
      key: "model",
      label: "Top model",
      value: topModel?.model ?? "None",
      title: topModel
        ? `${topModel.model} · ${PROVIDER_PRESENTATION[topModel.provider].label}`
        : "No model usage yet",
      text: true,
    },
  ];
  return (
    <>
      <div className={HOME_STUDIO_OVERVIEW_CLASS}>
        <Heatmap cells={buildHeatCells(untilDay, heatUsage.daily)} />
        <dl className={HOME_STUDIO_STAT_LIST_CLASS}>
          {stats.map((stat, index) => (
            <div
              key={stat.key}
              data-home-studio-motion="rise"
              style={{ "--home-studio-index": index } as CSSProperties}
              className="flex min-w-0 items-baseline justify-between gap-2 text-2xs leading-3.5"
            >
              <dt className="flex-none text-muted-foreground">{stat.label}</dt>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <dd
                      className={cn(
                        "min-w-0 truncate text-foreground tabular-nums",
                        stat.text ? "font-medium" : "font-mono font-semibold tracking-tight",
                      )}
                    />
                  }
                >
                  {stat.value}
                </TooltipTrigger>
                <TooltipPopup side="top">{stat.title}</TooltipPopup>
              </Tooltip>
            </div>
          ))}
        </dl>
      </div>
      {/* Always rendered, so a book arriving with the data never moves the headline. */}
      <p
        className={cn(
          "truncate text-xs leading-4 text-muted-foreground",
          HOME_STUDIO_FOOTNOTE_CLASS,
        )}
      >
        {book}
      </p>
    </>
  );
}

interface HoverTipState {
  frame: number;
  pending: HTMLElement | null;
  shown: HTMLElement | null;
}

/**
 * One tooltip for a dense grid of `data-tip` children. Hover writes it straight to the DOM at most
 * once per frame, so moving across cells never re-renders them.
 */
function useHoverTip() {
  const containerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const state = useRef<HoverTipState>({ frame: 0, pending: null, shown: null });

  const flush = () => {
    const current = state.current;
    current.frame = 0;
    const target = current.pending;
    const container = containerRef.current;
    const element = tipRef.current;
    if (!target || !container || !element || !target.isConnected) return;
    const text = target.dataset.tip ?? "";
    current.shown = target;
    const { left, top } = heatTipPosition({
      gridWidth: container.clientWidth,
      gridHeight: container.clientHeight,
      cellLeft: target.offsetLeft,
      cellTop: target.offsetTop,
      cellWidth: target.offsetWidth,
      cellHeight: target.offsetHeight,
      textLength: text.length,
    });
    if (element.textContent !== text) element.textContent = text;
    element.style.transform = `translate3d(${left}px,${top}px,0)`;
    element.dataset.shown = "true";
  };
  const cancel = () => {
    if (state.current.frame !== 0) cancelAnimationFrame(state.current.frame);
    state.current.frame = 0;
  };
  return {
    containerRef: (element: HTMLElement | null) => {
      containerRef.current = element;
      return cancel;
    },
    onPointerOver: (event: PointerEvent<HTMLElement>) => {
      const target = (event.target as Element).closest<HTMLElement>("[data-tip]");
      const current = state.current;
      if (!target || target === current.shown) return;
      current.pending = target;
      if (current.frame === 0) current.frame = requestAnimationFrame(flush);
    },
    onPointerLeave: () => {
      cancel();
      state.current.pending = null;
      state.current.shown = null;
      if (tipRef.current) delete tipRef.current.dataset.shown;
    },
    tip: (
      <span
        ref={tipRef}
        aria-hidden
        data-home-studio-tip
        className="pointer-events-none absolute top-0 left-0 z-10 rounded-full border bg-popover px-2 py-0.75 text-2xs leading-4 font-medium whitespace-nowrap text-popover-foreground tabular-nums opacity-0 shadow-md data-shown:opacity-100"
      />
    ),
  };
}

function Heatmap({ cells }: { readonly cells: readonly HeatCell[] }) {
  const { containerRef, tip, ...hover } = useHoverTip();
  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`Daily token usage over the last ${HOME_HEAT_WEEKS} weeks`}
      data-home-studio-motion="fade"
      {...hover}
      className={cn(
        "relative grid auto-cols-fr grid-flow-col grid-rows-7 content-start gap-0.5 [contain:layout_style]",
        HOME_STUDIO_HEAT_SIZE_CLASS,
      )}
    >
      {cells.map((cell) => (
        <span
          key={cell.day}
          data-tip={`${formatDayShort(cell.day)}: ${formatTokens(cell.tokens)} tokens`}
          className={cn("aspect-square rounded-xs", HEAT_LEVEL_CLASS[cell.level])}
        />
      ))}
      {tip}
    </div>
  );
}

function ModelsTab({
  range,
  untilDay,
  rangeUsage,
  chartEnvironments,
}: {
  readonly range: HomeRangeId;
  readonly untilDay: string;
  readonly rangeUsage: MergedUsage | null;
  readonly chartEnvironments: readonly EnvironmentUsageStatus[] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { containerRef, tip, ...hover } = useHoverTip();
  if (rangeUsage === null || chartEnvironments === null) return <HomeStudioStatsSkeleton />;
  const models = sortModelsByTokens(rangeUsage.models).filter((model) => model.totalTokens > 0);
  if (models.length === 0) {
    return <p className="py-4.5 text-center text-xs text-muted-foreground">No model usage yet</p>;
  }

  const days = chartDays(range, untilDay);
  const chartSince = days[0] ?? untilDay;
  const chartUsage = mergeAnsweredUsage(chartEnvironments, (bucket) => bucket.day >= chartSince);
  const series = sortModelsByTokens(chartUsage.models)
    .filter((model) => model.totalTokens > 0)
    .slice(0, CHART_SERIES)
    .map((model) => {
      // Merging per model keeps duplicate-source handling identical to the totals.
      const daily = mergeAnsweredUsage(
        chartEnvironments,
        (bucket) =>
          bucket.day >= chartSince &&
          bucket.provider === model.provider &&
          bucket.model === model.model,
      ).daily;
      return {
        key: modelKey(model),
        tokensByDay: new Map(daily.map((entry) => [entry.day, entry.totalTokens])),
      };
    });
  const totalByDay = new Map(chartUsage.daily.map((entry) => [entry.day, entry.totalTokens]));
  const colors = assignModelColors([
    ...series.map((entry) => entry.key),
    ...models.map((model) => modelKey(model)),
  ]);
  const columns = days.map((day) => {
    const total = totalByDay.get(day) ?? 0;
    const segments = series
      .map((entry) => ({ key: entry.key, tokens: entry.tokensByDay.get(day) ?? 0 }))
      .filter((segment) => segment.tokens > 0)
      .toSorted((left, right) => right.tokens - left.tokens || left.key.localeCompare(right.key));
    const other = total - segments.reduce((sum, segment) => sum + segment.tokens, 0);
    return { day, total, segments, other: Math.max(0, other) };
  });
  const top = axisMax(Math.max(0, ...columns.map((column) => column.total)));
  const labelIndexes = axisLabelIndexes(days.length);
  const shownModels = expanded ? models : models.slice(0, HOME_MODEL_ROWS);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="relative ml-9 h-38 border-b">
          {[1, 0.75, 0.5, 0.25, 0].map((at) => (
            <span
              key={at}
              style={{ bottom: `${at * 100}%` }}
              className="absolute -left-9 w-7.5 translate-y-1/2 text-right text-2xs leading-3.5 text-muted-foreground tabular-nums"
            >
              {top > 0 ? formatTokens(top * at) : ""}
            </span>
          ))}
          <div ref={containerRef} {...hover} className="absolute inset-0 flex items-end gap-0.5">
            {columns.map((column) => (
              <span
                key={column.day}
                data-tip={`${formatDayShort(column.day)}: ${formatTokens(column.total)} tokens`}
                data-home-studio-motion="grow"
                style={{ height: `${top > 0 ? (column.total / top) * 100 : 0}%` }}
                className="flex min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-t-xs"
              >
                {column.segments.map((segment) => (
                  <span
                    key={segment.key}
                    style={{ height: `${(segment.tokens / column.total) * 100}%` }}
                    className={cn("block w-full", MODEL_COLOR_CLASS[colors.get(segment.key) ?? 0])}
                  />
                ))}
                {column.other > 0 ? (
                  <span
                    style={{ height: `${(column.other / column.total) * 100}%` }}
                    className={cn("block w-full", OTHER_MODELS_CLASS)}
                  />
                ) : null}
              </span>
            ))}
            {tip}
          </div>
        </div>
        <div className="relative ml-9 h-3.5">
          {labelIndexes.map((index) => {
            const last = index === days.length - 1;
            return (
              <span
                key={index}
                style={last ? undefined : { left: `${((index + 0.5) / days.length) * 100}%` }}
                className={cn(
                  "absolute top-0 text-2xs leading-3.5 whitespace-nowrap text-muted-foreground tabular-nums",
                  last ? "right-0" : "-translate-x-1/2",
                )}
              >
                {formatDayShort(days[index]!)}
              </span>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-1.75">
        {shownModels.map((model) => {
          const key = modelKey(model);
          const input =
            model.tokens.uncachedInputTokens +
            model.tokens.cachedInputTokens +
            model.tokens.cacheCreationTokens;
          const hitRate = cacheHitRate(model);
          return (
            <Tooltip key={key}>
              <TooltipTrigger render={<div className="flex min-w-0 items-center gap-2" />}>
                <span
                  aria-hidden
                  className={cn(
                    "size-2 flex-none rounded-xs",
                    MODEL_COLOR_CLASS[colors.get(key) ?? 0],
                  )}
                />
                <span className="min-w-0 truncate text-xs leading-4.5 text-foreground">
                  {model.model}
                </span>
                <span className="ml-auto text-2xs leading-4.5 whitespace-nowrap text-muted-foreground tabular-nums">
                  {formatTokens(input)} in · {formatTokens(model.tokens.outputTokens)} out
                  {hitRate === null ? "" : ` · ${Math.round(hitRate * 100)}% cache`}
                </span>
                <span className="w-11 flex-none text-right text-xs leading-4.5 text-foreground tabular-nums">
                  {formatPercent(model.tokenShare)}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${model.model} · ${PROVIDER_PRESENTATION[model.provider].label} · ${formatCount(model.records)} responses`}
              </TooltipPopup>
            </Tooltip>
          );
        })}
        {models.length > HOME_MODEL_ROWS ? (
          <div className="text-xs">
            <InlineButton tone="muted" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Show less" : `Show ${models.length - HOME_MODEL_ROWS} more`}
            </InlineButton>
          </div>
        ) : null}
      </div>
    </>
  );
}

function QuotasTab({
  pools,
  now,
  refreshing,
  onRefresh,
}: {
  readonly pools: readonly LimitPool[];
  readonly now: number;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-1.5 text-2xs text-muted-foreground">
        <span>Quota pools remaining</span>
        <Button variant="ghost-muted" size="xs" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {pools.length === 0 ? (
        <p className="py-4.5 text-center text-xs text-muted-foreground">
          {refreshing ? "Loading…" : "No provider reports subscription limits."}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-2.5">
          {pools.map((pool) => (
            <QuotaCard key={pool.driver} pool={pool} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function quotaWindows(pool: LimitPool): readonly LimitPoolWindow[] {
  const windows = displayLimitWindows(pool);
  const timed = windows.filter((window) => window.kind === "session" || window.kind === "weekly");
  return timed.length > 0 ? timed : windows;
}

function paceMarkPercent(window: LimitPoolWindow, now: number): number | null {
  const marks = window.members.flatMap((member) => {
    const value = paceRemainingPercent(member.window, now);
    return value === null ? [] : [value];
  });
  return marks.length === 0 ? null : marks.reduce((sum, value) => sum + value, 0) / marks.length;
}

function QuotaCard({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const windows = quotaWindows(pool);
  const lowest = Math.min(...windows.map((window) => window.remainingPercent));
  const health = quotaWarnLevel(lowest);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-foreground/3 px-3 py-2.75 tabular-nums">
      <div className="flex items-center justify-between gap-1.5">
        <span className="truncate text-xs font-semibold text-foreground">
          {providerClients.get(pool.driver)?.label ?? String(pool.driver)}
        </span>
        {windows.length > 0 ? (
          <Badge variant={QUOTA_BADGE_VARIANT[health]} size="sm">
            {quotaHealthLabel(health)}
          </Badge>
        ) : null}
      </div>
      {windows.map((window) => {
        const level = quotaWarnLevel(window.remainingPercent);
        const nextReset = window.resets[0];
        const resetsIn = nextReset ? formatResetsIn(nextReset.member.window, now) : null;
        const pace = paceMarkPercent(window, now);
        return (
          <div key={`${window.kind}:${window.id}`} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-1.5 text-2xs">
              <span className="truncate text-3xs text-muted-foreground">{window.label}</span>
              <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap text-foreground">
                {window.remainingPercent}%{resetsIn ? ` · ${resetsIn}` : ""}
                {window.pace ? <PaceIcon pace={window.pace} /> : null}
              </span>
            </div>
            <div
              role="img"
              aria-label={`${window.label}: ${window.remainingPercent}% left${resetsIn ? `, ${resetsIn}` : ""}`}
              className="relative h-1.5 overflow-hidden rounded-full bg-muted-foreground/18"
            >
              <span
                style={{ width: `${window.remainingPercent}%` }}
                className={cn("absolute inset-y-0 left-0 rounded-full", QUOTA_BAR_CLASS[level])}
              />
              {pace === null ? null : (
                <span
                  aria-hidden
                  style={{ left: `clamp(1px, ${pace}%, calc(100% - 1px))` }}
                  className="absolute inset-y-0 w-px -translate-x-1/2 bg-foreground/70"
                />
              )}
            </div>
          </div>
        );
      })}
      {pool.accounts.length > 1 ? (
        <span className="text-3xs text-muted-foreground">
          {pool.accounts.length} accounts pooled
        </span>
      ) : null}
    </div>
  );
}
