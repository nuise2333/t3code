import type { ModelSelection, ProviderInstanceId, RuntimeMode } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ComponentProps, memo, useId, useRef } from "react";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "~/lib/utils";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { runtimeModeConfig } from "./runtimeModeConfig";
import { useComposerMenuState } from "./useComposerMenuState";

export type RuntimeModeOption = {
  mode: RuntimeMode;
  disabledReason?: string;
} & (typeof runtimeModeConfig)[RuntimeMode];
const supervisedRuntimeModeOption: RuntimeModeOption = {
  mode: "approval-required" as const,
  ...runtimeModeConfig["approval-required"],
};
export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  runtimeMode: RuntimeMode;
  defaultRuntimeMode?: RuntimeMode | undefined;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  size?: "sm" | "xs";
  hidden?: boolean;
  /** Labelled on desktop, icon-only in compacted mobile rows. */
  accessDisplay?: "label" | "icon" | "hidden";
  /** Draw the icon in the label color, not muted (the mode differs from the user's default). */
  emphasized?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const size = props.size ?? "sm";
  const accessDisplay = props.accessDisplay ?? "label";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const permissionsChipRef = useRef<HTMLButtonElement>(null);
  const runtimeModeOption =
    props.runtimeModeOptions.find((option) => option.mode === props.runtimeMode) ??
    supervisedRuntimeModeOption;
  const RuntimeModeIcon = runtimeModeOption.icon;
  const permissionsTooltip = `Permissions: ${runtimeModeOption.label}. ${runtimeModeOption.description}`;
  const permissionsChip = (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) =>
        focusRequestedPermission(isOpen, permissionsChipRef.current)
      }
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  ref={permissionsChipRef}
                  data-composer-shortcut="composer.mode"
                  data-composer-permissions-trigger
                  size={size}
                  className="ps-1.5 data-popup-open:bg-accent data-popup-open:text-foreground"
                  aria-label={`Permissions: ${runtimeModeOption.label}`}
                />
              }
            />
          }
        >
          <ComposerControlIcon
            icon={RuntimeModeIcon}
            size={size}
            {...(props.emphasized ? { className: "text-current" } : {})}
          />
          <span
            data-composer-control-label
            className={accessDisplay === "icon" ? "sr-only" : undefined}
          >
            {runtimeModeOption.label}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            data-composer-control-chevron
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/75",
              accessDisplay === "icon" && "hidden",
            )}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{permissionsTooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="start" {...composerFloatingLayerProps}>
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          defaultRuntimeMode={props.defaultRuntimeMode}
          runtimeModeOptions={props.runtimeModeOptions}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      </MenuPopup>
    </Menu>
  );

  return accessDisplay === "hidden" ? null : permissionsChip;
});

/**
 * Permission modes as a vertical list of selectable rows with icon, label, one-line description,
 * Default pill on the default mode, and a check on the active mode.
 */
export function ComposerPermissionsSection(props: {
  runtimeMode: RuntimeMode;
  defaultRuntimeMode?: RuntimeMode | undefined;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const descriptionId = useId();
  return (
    <div data-composer-permissions className="flex w-72 flex-col gap-1 py-1 sm:w-80">
      <div className="px-2.5 pt-1 pb-0.5 font-medium text-muted-foreground text-xs">
        Permissions
      </div>
      <MenuPrimitive.RadioGroup
        aria-label="Permissions"
        value={props.runtimeMode}
        onValueChange={(value: RuntimeMode) => {
          if (value !== props.runtimeMode) props.onRuntimeModeChange(value);
        }}
        className="flex flex-col gap-0.5 px-1"
      >
        {props.runtimeModeOptions.map((option) => {
          const OptionIcon = option.icon;
          const isDefault = props.defaultRuntimeMode === option.mode;
          return (
            <MenuPrimitive.RadioItem
              key={option.mode}
              value={option.mode}
              disabled={option.disabledReason !== undefined}
              label={option.label}
              aria-label={option.label}
              aria-describedby={`${descriptionId}-${option.mode}`}
              closeOnClick
              className="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors data-disabled:cursor-not-allowed data-disabled:opacity-50 data-checked:bg-foreground/8 data-checked:ring-1 data-checked:ring-inset data-checked:ring-border/70 data-highlighted:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <OptionIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground group-data-checked:text-foreground"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground text-sm">
                    {option.label}
                  </span>
                  {isDefault ? (
                    <span className="inline-flex shrink-0 items-center rounded-full border border-border/70 bg-muted/50 px-2 py-0.5 font-medium text-2xs text-muted-foreground leading-none">
                      Default
                    </span>
                  ) : null}
                </span>
                <span
                  id={`${descriptionId}-${option.mode}`}
                  className="text-muted-foreground text-xs leading-snug"
                >
                  {option.disabledReason ?? option.description}
                </span>
              </span>
              <MenuPrimitive.RadioItemIndicator className="flex shrink-0 text-foreground">
                <CheckIcon aria-hidden="true" className="size-4" />
              </MenuPrimitive.RadioItemIndicator>
            </MenuPrimitive.RadioItem>
          );
        })}
      </MenuPrimitive.RadioGroup>
    </div>
  );
}

export const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  children?: React.ReactNode;
  compact: boolean;
  canOperateThread: boolean;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  canInterrupt: boolean;
  runId: string | null;
  followUpBehavior: "queue" | "steer";
  canSteer: boolean;
  alternateShortcutLabel: string | null;
  voiceInputActive?: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  canResume: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage: boolean;
  onSubmitMessage: React.MouseEventHandler<HTMLButtonElement>;
  onResume: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  compactBeforeSendTokens: number | null;
  hideCompactToggle: boolean;
  keepFullHistory: boolean;
  onToggleKeepFullHistory: () => void;
}) {
  return (
    <>
      <ComposerPrimaryActions
        compact={props.compact}
        canOperateThread={props.canOperateThread}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        canInterrupt={props.canInterrupt}
        runId={props.runId}
        followUpBehavior={props.followUpBehavior}
        canSteer={props.canSteer}
        alternateShortcutLabel={props.alternateShortcutLabel}
        voiceInputActive={props.voiceInputActive ?? false}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        canResume={props.canResume}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        isEditingQueuedMessage={props.isEditingQueuedMessage}
        onSubmitMessage={props.onSubmitMessage}
        onResume={props.onResume}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        compactBeforeSendTokens={props.compactBeforeSendTokens}
        hideCompactToggle={props.hideCompactToggle}
        keepFullHistory={props.keepFullHistory}
        onToggleKeepFullHistory={props.onToggleKeepFullHistory}
      >
        {props.children}
      </ComposerPrimaryActions>
    </>
  );
});

/**
 * The composer's model picker. It owns the single- and multi-model selection
 * handlers so they are cached against the selection state, not rebuilt on
 * every ChatComposer render.
 */
export function ComposerModelPicker({
  multipleModelsEnabled,
  multipleModelSelections,
  onMultipleModelSelectionsChange,
  selectedModelSelection,
  onProviderModelSelect,
  ...pickerProps
}: Omit<
  ComponentProps<typeof ProviderModelPicker>,
  "selectedModels" | "onToggleModel" | "onInstanceModelChange"
> & {
  readonly multipleModelsEnabled: boolean;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly onMultipleModelSelectionsChange: (
    selections: ReadonlyArray<ModelSelection> | null,
  ) => void;
  readonly selectedModelSelection: ModelSelection;
  readonly onProviderModelSelect: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => void;
}) {
  const { instanceEntries, modelOptionsByInstance } = pickerProps;
  const toggleModel = (instanceId: ProviderInstanceId, model: string) => {
    const current = multipleModelSelections ?? [selectedModelSelection];
    const matchesModel = (selection: ModelSelection) => {
      if (selection.instanceId !== instanceId) return false;
      const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
      const resolvedModel = resolveModelPickerSelectedModel({
        driverKind: entry?.driverKind,
        model: selection.model,
        options: modelOptionsByInstance?.get(selection.instanceId) ?? [],
      });
      return (resolvedModel?.slug ?? selection.model) === model;
    };
    const exists = current.some(matchesModel);
    const next = exists
      ? current.filter((selection) => !matchesModel(selection))
      : [...current, createModelSelection(instanceId, model)];
    if (next.length > 1) {
      onMultipleModelSelectionsChange(next);
    } else {
      onMultipleModelSelectionsChange(null);
      const remaining = next[0] ?? selectedModelSelection;
      onProviderModelSelect(remaining.instanceId, remaining.model, {
        focusComposer: false,
      });
    }
  };
  return (
    <ProviderModelPicker
      {...pickerProps}
      {...(multipleModelsEnabled
        ? {
            ...(multipleModelSelections !== null
              ? { selectedModels: multipleModelSelections }
              : {}),
            onToggleModel: toggleModel,
          }
        : {})}
      onInstanceModelChange={(instanceId, model) => {
        onMultipleModelSelectionsChange(null);
        onProviderModelSelect(instanceId, model);
      }}
    />
  );
}
