import type { TokenSaverLevel, TokenSaverPack, TokenSaverSettings } from "@t3tools/contracts";
import {
  activeTokenSaverPacks,
  TOKEN_SAVER_LEVELS,
  TOKEN_SAVER_PACKS,
  tokenSaverEstimate,
} from "@t3tools/shared/tokenSaver";
import { InfoIcon, LeafIcon } from "lucide-react";
import { memo, useId, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

export const EMPTY_TOKEN_SAVER: TokenSaverSettings = { packs: [], level: "full" };

function sameSaver(left: TokenSaverSettings | null, right: TokenSaverSettings | null): boolean {
  const packs = (saver: TokenSaverSettings | null) => [...(saver?.packs ?? [])].sort().join(",");
  return packs(left) === packs(right) && (left?.level ?? "full") === (right?.level ?? "full");
}

/**
 * The composer's token saver: a leaf that counts the packs on, and a panel of switches. Packs
 * reach the agent with the next message, and again every few messages.
 */
export const ComposerTokenSaverControl = memo(function ComposerTokenSaverControl(props: {
  readonly saver: TokenSaverSettings;
  /** What new threads start with, so the panel can say whether this thread matches it. */
  readonly defaultSaver: TokenSaverSettings | null;
  readonly rtk: boolean;
  readonly size?: "sm" | "xs";
  readonly onChange: (saver: TokenSaverSettings) => void;
  readonly onDefaultChange: (saver: TokenSaverSettings | null) => void;
}) {
  const size = props.size ?? "sm";
  const floatingProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const available = { rtk: props.rtk };
  const active = activeTokenSaverPacks(props.saver.packs, available);
  const estimate = tokenSaverEstimate(props.saver, available);
  const label =
    active.length > 0
      ? `Token saver: ${active.length} on, about ${estimate}% fewer tokens`
      : "Token saver: off";
  const isDefault = props.defaultSaver !== null && sameSaver(props.saver, props.defaultSaver);
  const levelId = useId();
  const toggle = (pack: TokenSaverPack, on: boolean) => {
    const packs = on
      ? [...props.saver.packs.filter((id) => id !== pack), pack]
      : props.saver.packs.filter((id) => id !== pack);
    props.onChange({ ...props.saver, packs });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <ComposerControl
                  size={size}
                  className="ps-1.5"
                  data-composer-token-saver={active.length > 0 ? "on" : "off"}
                  aria-pressed={active.length > 0}
                  aria-label={label}
                />
              }
            />
          }
        >
          <ComposerControlIcon
            icon={LeafIcon}
            size={size}
            {...(active.length > 0 ? { className: "text-success" } : {})}
          />
          {active.length > 0 ? (
            <span data-composer-control-label className="tabular-nums">
              {active.length}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="top"
        align="start"
        padding="compact"
        className="w-80"
        aria-label="Token saver"
        {...floatingProps}
      >
        <div className="grid gap-1" data-composer-token-saver-panel>
          <div className="flex items-baseline justify-between px-1 pb-1">
            <span className="font-medium text-sm">Token saver</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {active.length > 0 ? `~${estimate}% fewer tokens` : "Off"}
            </span>
          </div>
          {TOKEN_SAVER_PACKS.map((pack) => {
            const on = props.saver.packs.includes(pack.id);
            const missing = pack.needs === "rtk" && !props.rtk;
            return (
              <div key={pack.id} className="grid gap-1.5 rounded-md px-1 py-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{pack.title}</span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`About ${pack.title}`}
                          className="inline-flex text-muted-foreground"
                        />
                      }
                    >
                      <InfoIcon className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-64">
                      {pack.summary} Saves {pack.saves}.
                      {missing ? " Install rtk (brew install rtk), then restart T3 Code." : ""}
                    </TooltipPopup>
                  </Tooltip>
                  <Switch
                    className="ms-auto"
                    size="sm"
                    checked={on && !missing}
                    disabled={missing}
                    aria-label={pack.title}
                    onCheckedChange={(checked) => toggle(pack.id, checked)}
                  />
                </div>
                {pack.id === "caveman" && on ? (
                  <ToggleGroup
                    aria-labelledby={levelId}
                    className="w-full"
                    value={[props.saver.level]}
                    onValueChange={(value: ReadonlyArray<string>) => {
                      const level = value[0] as TokenSaverLevel | undefined;
                      if (level && level !== props.saver.level) {
                        props.onChange({ ...props.saver, level });
                      }
                    }}
                  >
                    <span id={levelId} className="sr-only">
                      Caveman level
                    </span>
                    {TOKEN_SAVER_LEVELS.map((level) => (
                      <ToggleGroupItem
                        key={level.id}
                        value={level.id}
                        className="flex-1"
                        aria-label={`${level.label}: ${level.hint}`}
                      >
                        {level.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                ) : null}
              </div>
            );
          })}
          <div className="mt-1 flex items-center gap-2 border-t px-1 pt-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-xs">
              <Checkbox
                checked={isDefault}
                onCheckedChange={(checked) => props.onDefaultChange(checked ? props.saver : null)}
              />
              <span className="truncate">Start new threads like this</span>
            </label>
            <Button
              size="xs"
              variant="ghost"
              disabled={props.saver.packs.length === 0}
              onClick={() => props.onChange({ ...props.saver, packs: [] })}
            >
              Turn all off
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
