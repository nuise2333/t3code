import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  isReasoningControl,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import type { RoutedEffortDisplay, RoutedGroupDisplay } from "@t3tools/client-runtime/routing";
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import { CheckIcon, ChevronRightIcon, GaugeIcon, WorkflowIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useOpticalConfig } from "~/optical/config";
import { OpticalEffortSlider } from "~/optical/OpticalEffortSlider";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { EffortGlyph, FastBolt, resolveEffortGlyph } from "./EffortGlyph";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
  ULTRATHINK_IN_BODY_NOTE,
  useTraitsSelection,
} from "./TraitsPicker";

export type EffortTier = "low" | "medium" | "high" | "xhigh" | "auto";

export interface ModelRowEffortDisplay {
  readonly label: string;
  readonly tier?: EffortTier | undefined;
}

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Service tiers, Claude's Fast mode, and Ultracode render as compact controls under the slider. */
function splitSpeed(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect = selects.find((descriptor) => descriptor.id === "serviceTier") ?? null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
  };
}

function resolveEffortTier(
  glyph: {
    readonly count: number;
    readonly filled: number;
    readonly special: string | null;
  } | null,
  autoDraft: boolean,
): EffortTier | undefined {
  if (autoDraft) return "auto";
  if (!glyph || glyph.filled <= 0) return undefined;
  if (glyph.filled >= glyph.count) return glyph.count >= 4 ? "xhigh" : "high";
  if (glyph.filled / glyph.count >= 0.7) return "high";
  if (glyph.filled / glyph.count > 0.34) return "medium";
  return "low";
}

/**
 * Auto effort in the picker: a new thread's draft can leave the level to the server, and a
 * launched thread names the level Auto picked until its user picks another.
 */
export type ComposerEffortRouting =
  | {
      readonly kind: "draft";
      readonly auto: boolean;
      /** What Auto may change, such as the model when switching is on. */
      readonly note: string;
      readonly onPickAuto: () => void;
    }
  | { readonly kind: "routed"; readonly display: RoutedEffortDisplay }
  | null;

const MANUAL_EFFORT_NOTE = "Pick a level to set it yourself.";

type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning levels under the header that names it. Other options,
 * such as an agent's session mode, sit below as one row each.
 */
function columnControls(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort = controls.find((control) => isReasoningControl(control.descriptor)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/**
 * Resolves a model row's current reasoning level word and tier color where T3 knows it,
 * or null when the model has no reasoning control or no known level.
 */
export function resolveModelRowEffort(
  input:
    | TraitsSelectionInput
    | {
        readonly provider: ProviderDriverKind;
        readonly instanceId: ProviderInstanceId;
        readonly models: ReadonlyArray<ServerProviderModel>;
        readonly model: string;
        readonly modelOptions?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | null,
  routing: ComposerEffortRouting = null,
): ModelRowEffortDisplay | null {
  if (!input) return null;
  const visibility = getTraitsSectionVisibility(input);
  if (!visibility.hasAnyControls || visibility.modelIsUnavailable) return null;
  const reasoning =
    columnControls(visibility.selectDescriptors, visibility.booleanDescriptors).effort
      ?.descriptor ?? null;
  if (!reasoning) return null;
  const modelSelection =
    input.instanceId && input.model
      ? { instanceId: input.instanceId, model: input.model, options: input.modelOptions ?? [] }
      : null;
  const reportedModelSelection =
    "reportedModelSelection" in input ? input.reportedModelSelection : undefined;
  const primary = visibility.primarySelectDescriptor;
  const ultrathink = visibility.ultrathinkPromptControlled && reasoning === primary;
  const autoDraft = routing?.kind === "draft" && routing.auto && reasoning.type === "select";
  if (autoDraft) return { label: "Auto", tier: "auto" };
  if (reasoning.type === "boolean") {
    if (typeof reasoning.currentValue !== "boolean") return null;
    return {
      label: reasoning.currentValue ? "On" : "Off",
      tier: reasoning.currentValue ? "medium" : undefined,
    };
  }
  const currentValue = ultrathink
    ? "ultrathink"
    : getDescriptorStringValue(reasoning, modelSelection, reportedModelSelection);
  const glyph = resolveEffortGlyph(reasoning, currentValue);
  const label = ultrathink
    ? "Ultrathink"
    : (glyph?.special ??
      glyph?.label ??
      getProviderOptionCurrentLabel(reasoning, modelSelection, reportedModelSelection));
  if (!label) return null;
  return {
    label,
    tier: resolveEffortTier(glyph, false),
  };
}

/**
 * What the model trigger shows after the model name: the effort word (or bars, per the
 * Appearance setting), a bolt for Fast, a workflow icon for Ultracode, and other traits such as a
 * context window.
 */
export function describeComposerEffort(
  traits: TraitsSelectionInput | null,
  effortDisplay: EffortDisplay,
  size: ComposerControlSize,
  routing: ComposerEffortRouting = null,
): { suffix: ReactNode; detail: string | null } {
  if (!traits) return { suffix: null, detail: null };
  const visibility = getTraitsSectionVisibility(traits);
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const modelSelection =
    traits.instanceId && traits.model
      ? { instanceId: traits.instanceId, model: traits.model, options: traits.modelOptions ?? [] }
      : null;
  const primary = visibility.primarySelectDescriptor;
  const display = buildTraitsTriggerDisplay({
    descriptors: visibility.descriptors,
    primarySelectDescriptorId: primary?.id ?? null,
    ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
    modelSelection,
    reportedModelSelection: traits.reportedModelSelection,
  });
  // The same reasoning control the column lists, wherever the agent put it among its options.
  const reasoning =
    columnControls(visibility.selectDescriptors, visibility.booleanDescriptors).effort
      ?.descriptor ?? null;
  const ultrathink = visibility.ultrathinkPromptControlled && reasoning === primary;
  const glyph =
    reasoning?.type === "select"
      ? resolveEffortGlyph(
          reasoning,
          ultrathink
            ? "ultrathink"
            : getDescriptorStringValue(reasoning, modelSelection, traits.reportedModelSelection),
        )
      : null;
  const autoDraft = routing?.kind === "draft" && routing.auto && reasoning?.type === "select";
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const word = autoDraft
    ? "Auto"
    : glyph
      ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
      : !reasoning
        ? null
        : reasoning.type === "boolean"
          ? `${reasoning.label} ${reasoning.currentValue === true ? "On" : "Off"}`
          : ultrathink
            ? "Ultrathink"
            : (getProviderOptionCurrentLabel(
                reasoning,
                modelSelection,
                traits.reportedModelSelection,
              ) ?? (reasoning.id === "thinking" ? reasoning.label : null));
  const fast = display.speedLabel === "Fast" || display.speedLabel === "Ultrafast";
  // Agent options such as modes live in the picker; the trigger adds only the context window.
  const contextWindow =
    visibility.contextWindowDescriptor &&
    getProviderOptionCurrentLabel(
      visibility.contextWindowDescriptor,
      modelSelection,
      traits.reportedModelSelection,
    );
  const detail = autoDraft
    ? `Auto effort. ${routing.note}`
    : routing?.kind === "routed"
      ? [display.label, routing.display.summary].filter(Boolean).join(" · ")
      : display.label;
  if (!word && !glyph && !fast && !display.ultracode && !contextWindow)
    return { suffix: null, detail };
  const tier = resolveEffortTier(glyph, autoDraft);
  return {
    detail,
    suffix: (
      <span
        // Remounts per tier so the change pulse plays once.
        key={tier}
        data-optical-tier={tier}
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-muted-foreground group-hover/model-trigger:text-foreground group-data-pressed/model-trigger:text-foreground group-data-popup-open/model-trigger:text-foreground",
          // A word space after the model name: the regular trigger's gap is wider than one.
          size === "sm" && "-ms-0.5",
        )}
      >
        {word ? (
          <span
            data-composer-control-label
            data-effort-tier={tier}
            className="max-w-24 truncate font-medium"
          >
            {word}
          </span>
        ) : glyph ? (
          <EffortGlyph count={glyph.count} filled={glyph.filled} size={size} />
        ) : null}
        {fast ? <FastBolt ultra={display.speedLabel === "Ultrafast"} /> : null}
        {display.ultracode ? (
          <WorkflowIcon aria-hidden="true" data-composer-control-icon className="size-3" />
        ) : null}
        {contextWindow ? (
          <span
            // A label, so icon-only footers drop it; compacted rows drop it before the model.
            data-composer-control-label
            data-composer-secondary-trait
            className="max-w-24 truncate text-xs"
          >
            {contextWindow}
          </span>
        ) : null}
      </span>
    ),
  };
}

const COLUMN_ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";
const COLUMN_LABEL = "px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs";

function ColumnRow(props: {
  label: string;
  /** Shown on hover; the column is too narrow to print it under the label. */
  description?: string | undefined;
  selected: boolean;
  /** The column's one tab stop: the selected level, else the first when none shows as selected. */
  tabStop: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  onPick: () => void;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-effort-row": true,
    // Focus lands on a level after a model pick.
    "data-effort-level": true,
    // Up and Down move between rows.
    tabIndex: props.tabStop ? 0 : -1,
    className: COLUMN_ROW,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.selected ? (
        <>
          {props.isDefault ? <span className="sr-only">Default</span> : null}
          <CheckIcon aria-hidden="true" className="size-3.5" />
        </>
      ) : props.isDefault ? (
        <span className="text-muted-foreground/70 text-xs">Default</span>
      ) : null}
    </>
  );
  if (!props.description) return <button {...rowProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="right" className="max-w-56">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  // An option's side menu is a React child here, but it moves through its own items.
  if (!event.currentTarget.contains(event.target as Node)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-effort-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  // Up from the top row lets the popup return focus to the model list above.
  if (event.key === "ArrowUp" && index <= 0) return;
  const next =
    rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
  if (!next || next === document.activeElement) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

function EffortSectionHeading(props: {
  label: string;
  valueLabel?: string | null;
  tier?: EffortTier | undefined;
}) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1">
      <span className="min-w-0 flex-1 truncate font-medium text-foreground text-xs">
        {props.label}
      </span>
      {props.valueLabel ? (
        <span
          data-effort-tier={props.tier}
          className="shrink-0 font-semibold text-muted-foreground text-xs"
        >
          {props.valueLabel}
        </span>
      ) : null}
    </div>
  );
}

function EffortLevels(props: { traits: TraitsSelectionInput; routing: ComposerEffortRouting }) {
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle, ultracodeToggle } = splitSpeed(
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  const { effort, others } = columnControls(traits.selectDescriptors, traits.booleanDescriptors);
  const hasSpeedOrUltracode =
    !traits.modelIsUnavailable &&
    (speedSelect !== null || fastToggle !== null || ultracodeToggle !== null);
  if (traits.modelIsUnavailable) {
    return (
      <>
        {traits.descriptors.map((descriptor) => {
          const value = traits.currentLabel(descriptor);
          return value ? (
            <div key={descriptor.id}>
              <div className={COLUMN_LABEL}>{descriptor.label}</div>
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
            </div>
          ) : null;
        })}
      </>
    );
  }
  if (!effort && others.length === 0 && !hasSpeedOrUltracode) return <NoEffortRow />;
  // Ultrathink in the prompt locks the levels; the first option then holds the tab stop.
  const locked =
    effort?.descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
  return (
    <>
      {effort ? (
        <EffortRows control={effort} traits={traits} locked={locked} routing={props.routing} />
      ) : null}
      {hasSpeedOrUltracode ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 px-1",
            effort && "mt-1.5 border-t border-border/60 pt-2",
          )}
        >
          <SpeedControl traits={props.traits} />
          <UltracodeControl traits={props.traits} />
        </div>
      ) : null}
      {others.length > 0 ? (
        <div
          className={cn(
            "flex flex-col gap-0.5",
            (effort || hasSpeedOrUltracode) && "mt-1.5 border-t border-border/60 pt-1.5",
          )}
        >
          {others.map((control, index) =>
            control.kind === "boolean" ? (
              <OptionSwitchRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && !hasSpeedOrUltracode && index === 0}
              />
            ) : (
              <OptionMenuRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && !hasSpeedOrUltracode && index === 0}
              />
            ),
          )}
        </div>
      ) : null}
    </>
  );
}

type TraitsSelection = ReturnType<typeof useTraitsSelection>;

function EffortRows(props: {
  control: ColumnControl;
  traits: TraitsSelection;
  locked: boolean;
  routing: ComposerEffortRouting;
}) {
  const { control, traits } = props;
  const { descriptor } = control;
  if (control.kind === "boolean") {
    const on = control.descriptor.currentValue === true;
    return (
      <div className="flex flex-col gap-0.5">
        <EffortSectionHeading
          label={descriptor.label}
          valueLabel={on ? "On" : "Off"}
          tier={on ? "medium" : undefined}
        />
        <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
          {([true, false] as const).map((value) => (
            <ColumnRow
              key={String(value)}
              label={value ? "On" : "Off"}
              selected={on === value}
              tabStop={on === value}
              onPick={() => traits.changeBoolean(descriptor.id, value)}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <EffortSelectRows
      descriptor={control.descriptor}
      traits={traits}
      locked={props.locked}
      routing={props.routing}
    />
  );
}

function EffortSelectRows(props: {
  descriptor: SelectDescriptor;
  traits: TraitsSelection;
  locked: boolean;
  routing: ComposerEffortRouting;
}) {
  const { descriptor, traits, locked, routing } = props;
  const optical = useOpticalConfig();
  const draftRouting = routing?.kind === "draft" && !locked ? routing : null;
  const auto = draftRouting?.auto === true;
  const value = auto ? null : traits.selectValue(descriptor);
  const choices = selectableProviderOptionChoices(descriptor);
  // An "Ultrathink:" prefix selects a level the column does not offer.
  const shown = choices.some((option) => option.id === value);
  const note = draftRouting?.auto
    ? `${draftRouting.note} ${MANUAL_EFFORT_NOTE}`
    : routing?.kind === "routed"
      ? `${routing.display.summary}. ${MANUAL_EFFORT_NOTE}`
      : null;
  const noteRow = note ? (
    <div className="px-1 pt-1 pb-0.5 text-muted-foreground/80 text-xs">{note}</div>
  ) : null;
  const lockedRow = locked ? (
    <div className="px-1 pb-1.5 text-muted-foreground/80 text-xs">{ULTRATHINK_IN_BODY_NOTE}</div>
  ) : null;
  // With optical motion off the levels stay a plain list.
  if (optical.motionLevel !== "off" && choices.length > 1) {
    return (
      <div className="flex flex-col gap-0.5">
        {lockedRow}
        <OpticalEffortSlider
          title={descriptor.label}
          showTitle
          levels={choices}
          value={shown ? value : null}
          auto={draftRouting ? { active: auto, onPick: draftRouting.onPickAuto } : null}
          disabled={locked}
          onPick={(id) => traits.changeSelect(descriptor, id)}
        />
        {noteRow}
      </div>
    );
  }
  const currentGlyph = resolveEffortGlyph(descriptor, value);
  const currentLabel = auto
    ? "Auto"
    : (choices.find((option) => option.id === value)?.label ?? currentGlyph?.label ?? null);
  const currentTier = resolveEffortTier(currentGlyph, auto);
  return (
    <div className="flex flex-col gap-0.5">
      <EffortSectionHeading label={descriptor.label} valueLabel={currentLabel} tier={currentTier} />
      <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
        {lockedRow}
        {draftRouting ? (
          <ColumnRow
            label="Auto"
            selected={auto}
            tabStop={!shown}
            onPick={draftRouting.onPickAuto}
          />
        ) : null}
        {choices.map((option, index) => (
          <ColumnRow
            key={option.id}
            label={option.label}
            selected={option.id === value}
            tabStop={shown ? option.id === value : !draftRouting && index === 0}
            description={option.description}
            isDefault={option.isDefault}
            disabled={locked}
            onPick={() => traits.changeSelect(descriptor, option.id)}
          />
        ))}
        {noteRow}
      </div>
    </div>
  );
}

const OPTION_ROW = cn(COLUMN_ROW, "h-auto py-1");

/** An option's name over its current value. */
function OptionRowText(props: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-muted-foreground text-xs">{props.label}</span>
      <span className="truncate">{props.value}</span>
    </span>
  );
}

/**
 * One select besides reasoning, such as an agent's session mode. It names the current choice and
 * opens the rest beside the column, so any number of options leaves the levels in place.
 */
function OptionMenuRow(props: {
  descriptor: SelectDescriptor;
  traits: TraitsSelection;
  /** Holds the column's tab stop when the model has no levels. */
  tabStop: boolean;
}) {
  const { descriptor, traits } = props;
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const choices = selectableProviderOptionChoices(descriptor);
  const value = traits.selectValue(descriptor);
  const current = choices.find((choice) => choice.id === value)?.label ?? "";
  return (
    <Menu
      open={open}
      // A modal menu would cover the picker, so the next click there would only close it.
      modal={false}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) return;
        const checked = popupRef.current?.querySelector<HTMLElement>(
          '[role="menuitemradio"][aria-checked="true"]',
        );
        checked?.focus({ preventScroll: true });
        checked?.scrollIntoView({ block: "nearest" });
      }}
    >
      {/* No hover opening: an opened menu takes focus, which would steal typing from search. */}
      <MenuTrigger
        render={
          <button
            type="button"
            data-effort-row
            tabIndex={props.tabStop ? 0 : -1}
            aria-label={`${descriptor.label}: ${current}`}
            className={cn(OPTION_ROW, "data-popup-open:bg-foreground/[0.09]")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
          />
        }
      >
        <OptionRowText label={descriptor.label} value={current} />
        <ChevronRightIcon
          aria-hidden="true"
          className="-me-1 size-3.5 shrink-0 text-muted-foreground"
        />
      </MenuTrigger>
      <MenuPopup
        ref={popupRef}
        side="right"
        align="start"
        sideOffset={6}
        // A full-width column on phones leaves no room beside it, so fall below or above.
        collisionAvoidance={{ fallbackAxisSide: "end" }}
        className="max-w-72"
        data-model-picker-option-menu
        {...composerFloatingLayerProps}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <MenuRadioGroup
          aria-label={descriptor.label}
          value={value}
          onValueChange={(next: string) => {
            if (next !== value) traits.changeSelect(descriptor, next);
          }}
        >
          {choices.map((choice) => (
            <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
              <span className="flex items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{choice.label}</span>
                  {choice.description ? (
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  ) : null}
                </span>
                {choice.isDefault ? (
                  <span className="text-muted-foreground/70 text-xs">Default</span>
                ) : null}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** A two-state option toggles in place; a menu would add a click for nothing. */
function OptionSwitchRow(props: {
  descriptor: BooleanDescriptor;
  traits: TraitsSelection;
  tabStop: boolean;
}) {
  const { descriptor, traits } = props;
  const checked = descriptor.currentValue === true;
  return (
    <label className={cn(OPTION_ROW, "has-focus-visible:bg-foreground/[0.09]")}>
      <OptionRowText label={descriptor.label} value={checked ? "On" : "Off"} />
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={(next) => traits.changeBoolean(descriptor.id, next)}
        aria-label={descriptor.label}
        data-effort-row
        tabIndex={props.tabStop ? 0 : -1}
      />
    </label>
  );
}

function NoEffortRow() {
  return (
    <div className="flex h-8 items-center px-2 text-muted-foreground text-sm">No effort levels</div>
  );
}

/** The model picker's effort section: reasoning slider/levels and other model options. */
export function ComposerEffortColumn(props: {
  traits: TraitsSelectionInput | null;
  routing?: ComposerEffortRouting;
  /** The group a launched thread started through, with skipped members in a tooltip. */
  routedGroup?: RoutedGroupDisplay | null;
}) {
  return (
    <div
      className="flex flex-col gap-0.5 px-2.5 py-2"
      // Capture, so Up and Down on an option row move rows instead of opening its menu.
      onKeyDownCapture={moveBetweenRows}
    >
      {props.traits ? (
        <EffortLevels traits={props.traits} routing={props.routing ?? null} />
      ) : (
        <NoEffortRow />
      )}
      {props.routedGroup ? <RoutedGroupNote display={props.routedGroup} /> : null}
    </div>
  );
}

function RoutedGroupNote(props: { display: RoutedGroupDisplay }) {
  const text = <span className="block truncate">Routing group: {props.display.label}</span>;
  return (
    <div className="mt-1 border-t border-border/60 px-1 pt-1.5 pb-0.5 text-muted-foreground/80 text-xs">
      {props.display.skipped ? (
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} className="block outline-none" />}>
            {text}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.display.skipped}</TooltipPopup>
        </Tooltip>
      ) : (
        text
      )}
    </div>
  );
}

/** Stands in for the effort section while a routing group is picked: the group sets each member. */
export function ComposerRoutingGroupColumn(props: {
  name: string;
  summary: string | null;
  team: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2.5 text-muted-foreground text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground text-xs">
          {props.team ? "Agent team" : "Routing group"}
        </span>
        <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">{props.name}</span>
      </div>
      {props.summary === null ? (
        <p>This group no longer exists. Pick a model or another group.</p>
      ) : props.team ? (
        <>
          <p>The lead plans the work and delegates tasks to the team's models:</p>
          <p className="text-foreground">{props.summary}</p>
          <p>Each model keeps the options set in Settings. Pick a model to leave the team.</p>
        </>
      ) : (
        <>
          <p>Starts on a usable member, ranked as the group is set in Settings:</p>
          <p className="text-foreground">{props.summary}</p>
          <p>Each member keeps the options set in Settings. Pick a model to choose it yourself.</p>
        </>
      )}
    </div>
  );
}

const FOOTER_SEGMENT =
  "flex h-6 cursor-pointer items-center justify-center gap-1 px-2 text-muted-foreground text-xs outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground data-checked:bg-input/72 data-checked:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function SpeedSegment(props: {
  checked: boolean;
  label: string;
  description?: string | undefined;
  onPick: () => void;
}) {
  const buttonProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.checked,
    "data-checked": props.checked || undefined,
    "data-effort-row": true,
    className: FOOTER_SEGMENT,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      {props.label === "Fast" || props.label === "Ultrafast" ? (
        <FastBolt ultra={props.label === "Ultrafast"} />
      ) : null}
      {props.label}
    </>
  );
  if (!props.description) return <button {...buttonProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="top">{props.description}</TooltipPopup>
    </Tooltip>
  );
}

function SpeedControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { speedSelect, fastToggle } = splitSpeed(
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (traits.modelIsUnavailable || (!speedSelect && !fastToggle)) return null;
  return (
    <div
      role="radiogroup"
      aria-label={speedSelect?.label ?? fastToggle?.label}
      className="flex rounded-lg bg-input/40 p-0.5"
    >
      {speedSelect
        ? selectableProviderOptionChoices(speedSelect).map((option) => (
            <SpeedSegment
              key={option.id}
              checked={option.id === traits.selectValue(speedSelect)}
              label={option.label}
              description={option.description}
              onPick={() => traits.changeSelect(speedSelect, option.id)}
            />
          ))
        : fastToggle
          ? ([false, true] as const).map((value) => (
              <SpeedSegment
                key={String(value)}
                checked={(fastToggle.currentValue === true) === value}
                label={value ? "Fast" : "Standard"}
                onPick={() => traits.changeBoolean(fastToggle.id, value)}
              />
            ))
          : null}
    </div>
  );
}

function UltracodeControl(props: { traits: TraitsSelectionInput }) {
  const traits = useTraitsSelection(props.traits);
  const { ultracodeToggle } = splitSpeed(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable || !ultracodeToggle) return null;
  const on = ultracodeToggle.currentValue === true;
  return (
    <div className="flex rounded-lg bg-input/40 p-0.5">
      <button
        type="button"
        aria-pressed={on}
        data-checked={on || undefined}
        data-effort-row
        className={FOOTER_SEGMENT}
        onClick={() => traits.changeBoolean(ultracodeToggle.id, !on)}
      >
        <WorkflowIcon aria-hidden="true" className="size-3" />
        {ultracodeToggle.label}
      </button>
    </div>
  );
}

/** The model picker's bottom action row: jumps straight to the Usage view. */
export function ComposerPickerFooter(props: { onViewUsage?: () => void }) {
  if (!props.onViewUsage) return null;
  return (
    <div className="shrink-0 border-t border-border/70">
      <button
        type="button"
        data-model-picker-view-usage
        className="flex h-10 w-full cursor-pointer items-center gap-2.5 px-3 text-left text-foreground/90 text-sm outline-none transition-colors hover:bg-foreground/8 focus-visible:bg-foreground/8"
        onClick={props.onViewUsage}
      >
        <GaugeIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">View Usage</span>
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/75" />
      </button>
    </div>
  );
}
