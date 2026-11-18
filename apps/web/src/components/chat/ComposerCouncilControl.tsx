import {
  COUNCIL_MAX_ROUNDS,
  COUNCIL_REVIEWER_COUNTS,
  COUNCIL_TARGETS,
  type CouncilSettings,
} from "@t3tools/contracts";
import { formatCouncilScore } from "@t3tools/shared/council";
import { ScaleIcon } from "lucide-react";
import { memo, useId, useState, type ReactNode } from "react";

import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

function Segments<Value extends string | number>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  readonly onChange: (value: Value) => void;
}) {
  const labelId = useId();
  return (
    <div className="grid gap-1.5">
      <span id={labelId} className="font-medium text-muted-foreground text-xs">
        {props.label}
      </span>
      <ToggleGroup
        aria-labelledby={labelId}
        className="w-full"
        value={[String(props.value)]}
        onValueChange={(next: ReadonlyArray<string>) => {
          const picked = props.options.find((option) => String(option.value) === next[0]);
          if (picked && picked.value !== props.value) props.onChange(picked.value);
        }}
      >
        {props.options.map((option) => (
          <ToggleGroupItem
            key={String(option.value)}
            value={String(option.value)}
            className="flex-1"
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * The composer's Council control: a balance glyph, and a panel that turns Council on and sets its
 * target, round limit and reviewers. Settings become the user's defaults.
 */
export const ComposerCouncilControl = memo(function ComposerCouncilControl(props: {
  readonly on: boolean;
  readonly settings: CouncilSettings;
  readonly newThreadsOn: boolean;
  readonly size?: "sm" | "xs";
  /** Shown instead of the switch's description when Council cannot run here. */
  readonly note?: ReactNode;
  readonly onToggle: (on: boolean) => void;
  readonly onSettingsChange: (settings: CouncilSettings) => void;
  readonly onNewThreadsChange: (on: boolean) => void;
}) {
  const size = props.size ?? "sm";
  const floatingProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const { settings } = props;
  const label = props.on
    ? `Council: on, every reviewer must reach ${formatCouncilScore(settings.target)}`
    : "Council: off";
  const change = (patch: Partial<CouncilSettings>) =>
    props.onSettingsChange({ ...settings, ...patch });
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
                  data-composer-council={props.on ? "on" : "off"}
                  aria-pressed={props.on}
                  aria-label={label}
                />
              }
            />
          }
        >
          <ComposerControlIcon
            icon={ScaleIcon}
            size={size}
            {...(props.on ? { className: "text-foreground" } : {})}
          />
          {props.on ? (
            <span data-composer-control-label className="tabular-nums">
              {formatCouncilScore(settings.target)}
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
        aria-label="Council"
        {...floatingProps}
      >
        <div className="grid gap-3 px-1" data-composer-council-panel>
          <div className="grid gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">Council</span>
              <Switch checked={props.on} aria-label="Council" onCheckedChange={props.onToggle} />
            </div>
            <p className="text-muted-foreground text-xs">
              {props.note ??
                "Reviewers score the work until all reach your target. The lead convenes them and fixes what they find; these become your defaults."}
            </p>
          </div>
          <Segments
            label="Target score"
            value={settings.target}
            options={COUNCIL_TARGETS.map((target) => ({
              value: target,
              label: formatCouncilScore(target),
            }))}
            onChange={(target) => change({ target })}
          />
          <Segments
            label="Max rounds"
            value={settings.maxRounds}
            options={COUNCIL_MAX_ROUNDS.map((rounds) => ({
              value: rounds,
              label: String(rounds),
            }))}
            onChange={(maxRounds) => change({ maxRounds })}
          />
          <Segments<"auto" | number>
            label="Reviewers"
            value={settings.reviewers}
            options={[
              { value: "auto", label: "Auto" },
              ...COUNCIL_REVIEWER_COUNTS.map((count) => ({ value: count, label: String(count) })),
            ]}
            onChange={(reviewers) => change({ reviewers })}
          />
          <label className="flex items-center gap-2 border-t pt-2 text-muted-foreground text-xs">
            <Checkbox
              checked={props.newThreadsOn}
              onCheckedChange={(checked) => props.onNewThreadsChange(checked === true)}
            />
            Start new threads with Council on
          </label>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
