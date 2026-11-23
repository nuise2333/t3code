import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import { getDisplayModelName } from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import type { ModelRowEffortDisplay } from "./ComposerModelEffort";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  slug: string;
  name: string;
  subProvider?: string | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  isFavorite: boolean;
  /** In Favorites every row is starred, so the star shows only on hover. */
  favoriteStarOnHover?: boolean;
  isSelected: boolean;
  /** Marks this instance apart from another of the same provider. */
  showInstanceBadge: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  effort?: ModelRowEffortDisplay | null;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: (instanceId: ProviderInstanceId, slug: string) => void;
}) {
  const model = {
    slug: props.slug,
    name: props.name,
    subProvider: props.subProvider,
  };

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.slug)}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      {/* One row shape in every tab: the logo names the provider, so Favorites needs no second line. */}
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        displayName={props.providerDisplayName}
        accentColor={props.providerAccentColor}
        acpRegistryAgentId={props.acpRegistryAgentId}
        acpRegistryIconUrl={props.acpRegistryIconUrl}
        showBadge={props.showInstanceBadge}
        className="size-4"
        iconClassName="size-4"
        indicatorBackground="var(--popover)"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
      />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <div
          className={cn(
            "min-w-0 truncate text-sm leading-snug",
            props.isSelected ? "font-medium" : "font-normal",
          )}
          // Names the row in full on hover only when it is cut off.
          onPointerEnter={(event) => {
            const name = event.currentTarget;
            name.title = name.scrollWidth > name.clientWidth ? getDisplayModelName(model) : "";
          }}
        >
          {getDisplayModelName(model)}
          {/* The logo is decorative, so name the provider for screen readers. */}
          <span className="sr-only">, {props.providerDisplayName}</span>
        </div>
        {props.effort ? (
          <span
            data-model-row-effort
            data-effort-tier={props.effort.tier}
            className="shrink-0 font-medium text-muted-foreground text-sm leading-snug"
          >
            {props.effort.label}
          </span>
        ) : null}
        {props.subProvider ? (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70">
            {props.subProvider}
          </span>
        ) : null}
        {props.showNewBadge ? (
          <span
            className="shrink-0 rounded-full border border-border/70 bg-muted/50 px-1.5 py-0.5 font-medium text-2xs text-muted-foreground leading-none"
            aria-label="New model"
          >
            New
          </span>
        ) : null}
        {props.unavailable ? (
          <Badge variant="outline" size="sm">
            Unavailable
          </Badge>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite(props.instanceId, props.slug);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-warning",
                    (!props.isFavorite || props.favoriteStarOnHover) &&
                      "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        {props.isSelected ? (
          <CheckIcon className="size-4 shrink-0 text-foreground" aria-hidden="true" />
        ) : null}
      </div>
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
