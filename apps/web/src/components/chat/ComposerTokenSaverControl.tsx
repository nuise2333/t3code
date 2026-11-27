import type { TokenSaverLevel, TokenSaverPack, TokenSaverSettings } from "@t3tools/contracts";
import {
  activeTokenSaverPacks,
  TOKEN_SAVER_LEVELS,
  TOKEN_SAVER_PACKS,
  tokenSaverEstimate,
} from "@t3tools/shared/tokenSaver";
import { useGT } from "gt-react";
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
  const gt = useGT();
  const size = props.size ?? "sm";
  const floatingProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const available = { rtk: props.rtk };
  const active = activeTokenSaverPacks(props.saver.packs, available);
  const estimate = tokenSaverEstimate(props.saver, available);
  const label =
    active.length > 0
      ? gt("Token saver: {count} on, about {estimate}% fewer tokens", {
          count: active.length,
          estimate,
        })
      : gt("Token saver: off");
  const packCopy: Record<TokenSaverPack, { readonly title: string; readonly about: string }> = {
    caveman: {
      title: gt("Caveman"),
      about: gt(
        "Terse replies: answer first, no filler, every technical fact kept. Saves 15–65% of replies.",
      ),
    },
    "lean-code": {
      title: gt("Lean code"),
      about: gt(
        "Least code that works: reuse what exists, no speculative extras, diffs not whole files. Saves ~20–40% of code output (est.).",
      ),
    },
    "quiet-tools": {
      title: gt("Quiet tools"),
      about: gt(
        "Targeted searches, line ranges, quiet flags, no re-reading files. Saves ~20–50% of tool input (est.).",
      ),
    },
    rtk: {
      title: gt("RTK compression"),
      about: gt(
        "Runs commands through rtk, which compresses their output before the agent reads it. Saves 60–90% of command output.",
      ),
    },
    economizer: {
      title: gt("TokenEconomizer"),
      about: gt(
        "Learns from past sessions: keeps confirmed one-line repo notes, loads only tools it needs, and changes approach instead of repeating a failure. Saves ~18–31% per task (SWE-Bench).",
      ),
    },
  };
  const levelCopy: Record<TokenSaverLevel, { readonly label: string; readonly hint: string }> = {
    lite: { label: gt("Lite"), hint: gt("Brief, normal grammar") },
    full: { label: gt("Full"), hint: gt("Caveman voice") },
    ultra: { label: gt("Ultra"), hint: gt("Telegraphic") },
  };
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
        aria-label={gt("Token saver")}
        {...floatingProps}
      >
        <div className="grid gap-1" data-composer-token-saver-panel>
          <div className="flex items-baseline justify-between px-1 pb-1">
            <span className="font-medium text-sm">{gt("Token saver")}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {active.length > 0 ? gt("~{estimate}% fewer tokens", { estimate }) : gt("Off")}
            </span>
          </div>
          {TOKEN_SAVER_PACKS.map((pack) => {
            const on = props.saver.packs.includes(pack.id);
            const missing = pack.needs === "rtk" && !props.rtk;
            const { title, about } = packCopy[pack.id];
            return (
              <div key={pack.id} className="grid gap-1.5 rounded-md px-1 py-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{title}</span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={gt("About {title}", { title })}
                          className="inline-flex text-muted-foreground"
                        />
                      }
                    >
                      <InfoIcon className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-64">
                      {about}
                      {missing
                        ? ` ${gt("Install rtk (brew install rtk), then restart T3 Code.")}`
                        : ""}
                    </TooltipPopup>
                  </Tooltip>
                  <Switch
                    className="ms-auto"
                    size="sm"
                    checked={on && !missing}
                    disabled={missing}
                    aria-label={title}
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
                      {gt("Caveman level")}
                    </span>
                    {TOKEN_SAVER_LEVELS.map(({ id }) => (
                      <ToggleGroupItem
                        key={id}
                        value={id}
                        className="flex-1"
                        aria-label={`${levelCopy[id].label}: ${levelCopy[id].hint}`}
                      >
                        {levelCopy[id].label}
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
              <span className="truncate">{gt("Start new threads like this")}</span>
            </label>
            <Button
              size="xs"
              variant="ghost"
              disabled={props.saver.packs.length === 0}
              onClick={() => props.onChange({ ...props.saver, packs: [] })}
            >
              {gt("Turn all off")}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
