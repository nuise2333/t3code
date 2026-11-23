import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { ListOrderedIcon, StarIcon, UsersIcon } from "lucide-react";
import type { ModelPickerTab } from "./ProviderModelPicker.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";

function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  // An unavailable instance (a driver this build lacks or the policy leaves out) says why instead.
  if ((!entry.enabled && entry.isAvailable) || entry.status === "disabled") {
    return `${label}: Disabled in settings.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label}: ${kind}. ${msg}` : `${label}: ${kind}.`;
}

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ModelPickerTab;
  onSelectInstance: (instanceId: ModelPickerTab) => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  orientation?: "vertical" | "horizontal";
  showFavorites?: boolean;
  /** The Agent team tab, under Favorites. */
  showTeams?: boolean;
  showRoutingGroups?: boolean;
  /** "Routing groups", "Agent teams", or both, by what the tab lists. */
  routingGroupsLabel?: string;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
}) {
  const handleSelect = (instanceId: ModelPickerTab) => {
    props.onSelectInstance(instanceId);
  };
  const orientation = props.orientation ?? "vertical";
  const isHorizontal = orientation === "horizontal";
  const tooltipSide = isHorizontal ? ("top" as const) : PICKER_TOOLTIP_SIDE;
  const showFavorites = props.showFavorites ?? true;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorPos, setSelectedIndicatorPos] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected provider item's DOM offset to position the selection indicator
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorPos(null);
      return;
    }
    setSelectedIndicatorPos(
      isHorizontal
        ? selectedItem.offsetLeft + selectedItem.offsetWidth / 2 - 8
        : selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10,
    );
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Adding, removing or reordering providers moves the selected item, so the indicator re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    isHorizontal,
    showFavorites,
    props.showTeams,
    props.showRoutingGroups,
  ]);

  const tabButtonClassName = isHorizontal
    ? "relative isolate flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none"
    : "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none";
  const tabItemClassName = isHorizontal ? "relative shrink-0" : "relative w-full";
  const tabIconClassName = isHorizontal ? "size-4 shrink-0" : "size-5 shrink-0";

  return (
    <Toolbar.Root
      className={
        isHorizontal
          ? "w-full shrink-0 overflow-hidden border-b border-border/70 bg-muted/20"
          : "w-11 shrink-0 overflow-hidden bg-muted/30"
      }
      data-model-picker-sidebar="true"
      aria-label="Providers"
      orientation={orientation}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (
          (!isHorizontal && event.key === "ArrowRight") ||
          (isHorizontal && event.key === "ArrowDown")
        ) {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}
    >
      <div
        className={cn(
          "overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          isHorizontal ? "w-full overflow-x-auto" : "h-full overflow-y-auto",
        )}
      >
        <div
          ref={sidebarContentRef}
          className={
            isHorizontal
              ? "relative flex min-w-full flex-row items-center gap-1 px-2 py-1.5"
              : "relative flex min-h-full flex-col gap-1 p-1"
          }
        >
          {selectedIndicatorPos !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className={
                isHorizontal
                  ? "pointer-events-none absolute bottom-0.5 z-10 h-0.5 w-4 rounded-full bg-primary transition-[left] duration-200 ease-out"
                  : "pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-primary transition-[top] duration-200 ease-out"
              }
              style={isHorizontal ? { left: selectedIndicatorPos } : { top: selectedIndicatorPos }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <div className={tabItemClassName} data-model-picker-provider="favorites">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toolbar.Button
                        className={tabButtonClassName}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label="Favorites"
                        aria-pressed={props.selectedInstanceId === "favorites"}
                      >
                        <StarIcon className={cn(tabIconClassName, "fill-current")} aria-hidden />
                      </Toolbar.Button>
                    }
                  />
                  <TooltipPopup
                    side={tooltipSide}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    Favorites
                  </TooltipPopup>
                </Tooltip>
              </div>
              {props.showTeams ? (
                <div className={tabItemClassName} data-model-picker-provider="team">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Toolbar.Button
                          className={tabButtonClassName}
                          onClick={() => handleSelect("team")}
                          type="button"
                          aria-label="Agent team"
                          aria-pressed={props.selectedInstanceId === "team"}
                        >
                          <UsersIcon className={tabIconClassName} aria-hidden />
                        </Toolbar.Button>
                      }
                    />
                    <TooltipPopup
                      side={tooltipSide}
                      sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                      align="center"
                    >
                      Agent team
                    </TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
              {props.showRoutingGroups ? (
                <div className={tabItemClassName} data-model-picker-provider="groups">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Toolbar.Button
                          className={tabButtonClassName}
                          onClick={() => handleSelect("groups")}
                          type="button"
                          aria-label={props.routingGroupsLabel ?? "Routing groups"}
                          aria-pressed={props.selectedInstanceId === "groups"}
                        >
                          <ListOrderedIcon className={tabIconClassName} aria-hidden />
                        </Toolbar.Button>
                      }
                    />
                    <TooltipPopup
                      side={tooltipSide}
                      sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                      align="center"
                    >
                      {props.routingGroupsLabel ?? "Routing groups"}
                    </TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
              <div
                className={
                  isHorizontal
                    ? "mx-0.5 h-4 w-px shrink-0 bg-border/70"
                    : "border-b border-border/70"
                }
                aria-hidden="true"
              />
            </>
          ) : null}

          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const unavailableSelectionIsReachable =
              props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled =
              (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);

            const tooltip = isUnavailable
              ? describeUnavailableInstance(entry)
              : isContextDisabled
                ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                : entry.displayName;

            const button = (
              <Toolbar.Button
                className={cn(
                  tabButtonClassName,
                  isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
                )}
                data-provider-accent-color={entry.accentColor}
                onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
                onMouseLeave={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                onFocus={() => setHoveredInstanceId(entry.instanceId)}
                onBlur={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                disabled={isDisabled}
                focusableWhenDisabled={!isDisabled}
                aria-pressed={isSelected}
                type="button"
                aria-label={isUnavailable || isContextDisabled ? tooltip : entry.displayName}
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  acpRegistryAgentId={entry.acpRegistryAgentId}
                  acpRegistryIconUrl={entry.acpRegistryIconUrl}
                  showBadge={showInstanceBadge}
                  className={isHorizontal ? "size-4.5 z-30" : "size-6 z-30"}
                  iconClassName={isHorizontal ? "size-4" : "size-5"}
                  indicatorBackground={
                    isHovered && !isDisabled
                      ? "var(--muted)"
                      : isSelected
                        ? "var(--background)"
                        : "color-mix(in oklab, var(--muted) 30%, transparent)"
                  }
                  {...(entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
                />
              </Toolbar.Button>
            );

            const trigger = isDisabled ? (
              <span className={isHorizontal ? "relative block" : "relative block w-full"}>
                {button}
              </span>
            ) : (
              button
            );

            return (
              <div
                key={entry.instanceId}
                className={tabItemClassName}
                data-model-picker-provider={entry.instanceId}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={tooltipSide}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </Toolbar.Root>
  );
});
