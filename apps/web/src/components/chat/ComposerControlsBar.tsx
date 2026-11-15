import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon } from "lucide-react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl } from "./ComposerControl";
import {
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  autoEffortOffered,
  autoEffortSupported,
  routedEffortDisplay,
  pickerRoutingGroups,
  routedGroupDisplay,
} from "@t3tools/client-runtime/routing";
import {
  type EnvironmentId,
  type ModelSelection,
  type RouteDecision,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import { resolveComposerTraitsInput } from "./composerProviderState";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  ComposerEffortColumn,
  type ComposerEffortRouting,
  ComposerPickerFooter,
  ComposerRoutingGroupColumn,
  describeComposerEffort,
} from "./ComposerModelEffort";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useServerConfigs } from "../../state/entities";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

/**
 * The composer footer controls: the model picker (which also holds effort, speed and
 * permissions), mode controls and the overflow menu for blocks that do not fit. Rendered in the
 * expanded footer or the resting controls host.
 */
// Model and effort share one trigger; it stays filled while its popup is open.
const MODEL_TRIGGER_STATES = "data-popup-open:bg-accent data-popup-open:text-foreground";

export function ComposerControlsBar(props: {
  environmentId: EnvironmentId;
  workspaceCwd: string | null;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  effortDisplay: EffortDisplay;
  /** The strip under a new thread names the permissions, so the row does not repeat them. */
  permissionsShownInStrip: boolean;
  compatibleRuntimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode | undefined;
  compatibleRuntimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  composerControlsCollapsed: boolean;
  composerControlsHidden: boolean;
  restingHiddenBlockCount: number;
  iconOnlyBlockCount: number;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  selectedModelSelection: ModelSelection;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  activeThreadRouting: RouteDecision | null | undefined;
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
}) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    compatibleRuntimeMode,
    defaultRuntimeMode,
    compatibleRuntimeModeOptions,
    handleRuntimeModeChange,
    composerControlsCollapsed,
    composerControlsHidden,
    restingHiddenBlockCount: measuredHiddenBlockCount,
    iconOnlyBlockCount,
    showProviderUnavailable,
    providerSetupInstanceId,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    selectedModelSelection,
    onProviderModelSelect,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
  } = props;
  const accessMatchesDefault = compatibleRuntimeMode === defaultRuntimeMode;
  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: restingHiddenBlockCount,
    hiddenBlockIds: hiddenRestingBlockIds,
    overflowShowsPermissions,
    pickerOwnsModeShortcut,
  } = resolveComposerControlsOwnership({
    matchesDefault: accessMatchesDefault || props.permissionsShownInStrip,
    collapsed: composerControlsCollapsed,
    measuredHiddenBlockCount,
  });
  const controlSize = composerControlsCollapsed ? "xs" : "sm";
  const applyThreadModelPick = useApplyThreadModelPick();
  const applyRouteThreadModelPick = useStableCallback(() => applyThreadModelPick(routeThreadRef));
  const traitsInput = resolveComposerTraitsInput({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server"
      ? { threadRef: routeThreadRef, onDraftModelOptionsChange: applyRouteThreadModelPick }
      : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
  });
  const serverConfig = useServerConfigs().get(environmentId);
  const autoOffered = autoEffortOffered({
    capability: serverConfig?.environment.capabilities.autoRouting,
    settingEnabled: serverConfig?.settings.autoRoutingEnabled,
  });
  const draftEffortManual = useComposerDraftStore((store) =>
    draftId ? store.getComposerDraft(draftId)?.effortManual === true : false,
  );
  const setEffortManual = useComposerDraftStore((store) => store.setEffortManual);
  const setRoutingGroup = useComposerDraftStore((store) => store.setRoutingGroup);
  const draftRoutingGroupId = useComposerDraftStore((store) =>
    routeKind === "draft" && draftId
      ? (store.getComposerDraft(draftId)?.routingGroupId ?? null)
      : null,
  );
  const providerModels = providerInstanceEntries.map((entry) => ({
    instanceId: entry.instanceId,
    models: entry.snapshot.models,
  }));
  const routingGroups = pickerRoutingGroups({
    newThread: routeKind === "draft" && draftId !== null && draftId !== undefined,
    multiModel: multipleModelSelections !== null,
    capability: serverConfig?.environment.capabilities.routingGroups,
    groups: serverConfig?.settings.routingGroups,
    providers: providerModels,
  });
  const pickedGroup =
    draftRoutingGroupId === null
      ? null
      : (routingGroups.find((group) => group.id === draftRoutingGroupId) ?? {
          id: draftRoutingGroupId,
          name: "Missing group",
          summary: null,
        });
  const clearPickedGroup = () => {
    if (draftId && draftRoutingGroupId !== null) setRoutingGroup(draftId, null);
  };
  // Groups launch one model, so a second model leaves the group for a manual pick.
  const handleMultipleModelSelectionsChange = useStableCallback(
    (selections: ReadonlyArray<ModelSelection> | null) => {
      if (selections !== null) clearPickedGroup();
      onMultipleModelSelectionsChange(selections);
    },
  );
  // Re-picking the group's first member is still a manual pick of that model.
  const handleProviderModelSelect = useStableCallback(
    (...args: Parameters<typeof onProviderModelSelect>) => {
      clearPickedGroup();
      onProviderModelSelect(...args);
    },
  );
  const handleRoutingGroupSelect = useStableCallback((groupId: string) => {
    const group = routingGroups.find((candidate) => candidate.id === groupId);
    if (draftId && group)
      setRoutingGroup(draftId, { id: group.id, placeholder: group.placeholder });
  });
  const routedGroup =
    routeKind === "server"
      ? routedGroupDisplay({
          routing: props.activeThreadRouting,
          selection: selectedModelSelection,
          providers: providerModels,
        })
      : null;
  const selectedDescriptors = selectedProviderModels.find((model) => model.slug === selectedModel)
    ?.capabilities?.optionDescriptors;
  const routedDisplay =
    routeKind === "server"
      ? routedEffortDisplay({
          routing: props.activeThreadRouting,
          selection: selectedModelSelection,
          descriptors: selectedDescriptors,
        })
      : null;
  const effortRouting: ComposerEffortRouting =
    pickedGroup === null &&
    routeKind === "draft" &&
    draftId &&
    autoOffered &&
    multipleModelSelections === null &&
    autoEffortSupported({
      driver: selectedProvider,
      descriptors: selectedDescriptors,
      selection: selectedModelSelection,
      ultrathinkPrompt: promptUltrathink !== "none",
    })
      ? {
          kind: "draft",
          auto: !draftEffortManual,
          onPickAuto: () => setEffortManual(draftId, false),
        }
      : routedDisplay
        ? { kind: "routed", display: routedDisplay }
        : null;
  const traitsEffort = describeComposerEffort(
    traitsInput,
    props.effortDisplay,
    controlSize,
    effortRouting,
  );
  const effort = pickedGroup
    ? {
        suffix: null,
        detail: pickedGroup.summary
          ? `Routing group: first usable of ${pickedGroup.summary}`
          : "This routing group no longer exists",
      }
    : routedGroup
      ? {
          suffix: traitsEffort.suffix,
          detail: [routedGroup.label, routedGroup.skipped, traitsEffort.detail]
            .filter(Boolean)
            .join(" · "),
        }
      : traitsEffort;
  const restingBlockDefs = showModeBlock
    ? [
        {
          id: "mode",
          content: (
            <ComposerFooterModeControls
              runtimeMode={compatibleRuntimeMode}
              runtimeModeOptions={compatibleRuntimeModeOptions}
              size={controlSize}
              hidden={composerControlsHidden || restingHiddenBlockCount > 0}
              accessDisplay={accessDisplay}
              emphasized={!accessMatchesDefault}
              onRuntimeModeChange={handleRuntimeModeChange}
            />
          ),
        },
      ]
    : [];
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const composerModelPicker = (
    <ComposerModelPicker
      environmentId={environmentId}
      workspaceCwd={props.workspaceCwd}
      compact={false}
      isComposerOwned
      // The trigger grows away from this edge when its model or effort label changes.
      popupAlign={composerControlsCollapsed ? "start" : "end"}
      disabled={providerCatalogPending || isSendBusy}
      multipleModelsEnabled={multipleModelsEnabled}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={handleMultipleModelSelectionsChange}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={handleProviderModelSelect}
      activeInstanceId={
        providerCatalogPending
          ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
          : selectedInstanceId
      }
      model={
        providerCatalogPending
          ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
          : selectedModelForPickerWithCustomFallback
      }
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      instanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      size={controlSize}
      triggerClassName={cn(
        "group/model-trigger",
        MODEL_TRIGGER_STATES,
        composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13",
      )}
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      {...(pickedGroup ? { triggerLabel: pickedGroup.name } : {})}
      routingGroups={routingGroups}
      activeRoutingGroupId={draftRoutingGroupId}
      onRoutingGroupSelect={handleRoutingGroupSelect}
      triggerShortcuts={
        pickerOwnsModeShortcut ? "composer.effort composer.mode" : "composer.effort"
      }
      effortColumn={
        pickedGroup ? (
          <ComposerRoutingGroupColumn name={pickedGroup.name} summary={pickedGroup.summary} />
        ) : (
          <ComposerEffortColumn
            traits={traitsInput}
            routing={effortRouting}
            routedGroup={routedGroup}
          />
        )
      }
      footer={
        <ComposerPickerFooter
          traits={traitsInput}
          runtimeMode={compatibleRuntimeMode}
          runtimeModeOptions={compatibleRuntimeModeOptions}
          onRuntimeModeChange={handleRuntimeModeChange}
        />
      }
      terminalOpen={terminalOpen}
      open={modelPickerOpen}
      instanceIndicatorBackground={
        composerControlsCollapsed
          ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
          : "var(--contrast-input)"
      }
      {...(modelPickerIconClassName
        ? { activeProviderIconClassName: modelPickerIconClassName }
        : {})}
      onOpenChange={onModelPickerOpenChange}
      getModelDisabledReason={getModelDisabledReason}
      onOpenProviderSetup={onOpenProviderSetup}
    />
  );
  return showProviderUnavailable ? (
    <ComposerControl
      type="button"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="shrink-0"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? "Open provider settings" : "No provider available"}
    </ComposerControl>
  ) : (
    <>
      {composerModelPicker}

      <>
        {restingBlockDefs.map((def, index) => {
          const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex w-max min-w-max shrink-0 items-center gap-1",
                hidden && "pointer-events-none invisible absolute",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          data-resting-controls-overflow
          aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
          inert={hiddenRestingBlockIds.length === 0 || undefined}
          className={cn(
            "min-w-0 shrink-0",
            hiddenRestingBlockIds.length === 0 && "pointer-events-none invisible absolute",
          )}
        >
          <CompactComposerControlsMenu
            runtimeMode={compatibleRuntimeMode}
            runtimeModeOptions={compatibleRuntimeModeOptions}
            size={controlSize}
            hidden={composerControlsHidden || hiddenRestingBlockIds.length === 0}
            // Permissions join the overflow only when their normal home is in it.
            showPermissions={overflowShowsPermissions}
            onRuntimeModeChange={handleRuntimeModeChange}
          />
        </div>
      </>
    </>
  );
}
