import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon, UsersIcon } from "lucide-react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerTeamSetup } from "./ComposerTeamSetup";
import type { PickerTeams } from "./ModelPickerContent";
import type { ModelPickerTeamRow } from "./modelPickerKeys";
import { draftThreadAssistsAtom } from "./threadAssistsDraft";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useAtomValue } from "@effect/atom-react";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { ComposerThreadAssists, type ThreadAssistsState } from "./ComposerThreadAssists";
import { ComposerControl } from "./ComposerControl";
import {
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  autoEffortOffered,
  autoEffortSupported,
  autoRoutingNote,
  routedEffortDisplay,
  pickerRoutingGroups,
  agentTeamSummary,
  routingProviderSource,
  routedGroupDisplay,
  routedModelDisplay,
} from "@t3tools/client-runtime/routing";
import { threadAgentTeamRef } from "@t3tools/shared/agentTeam";
import {
  type EnvironmentId,
  type ModelSelection,
  type RouteDecision,
  type RoutingGroup,
  AUTO_TEAMS,
  type AutoTeamKind,
  type ThreadAgentTeam,
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
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  ComposerEffortColumn,
  type ComposerEffortRouting,
  ComposerPickerFooter,
  ComposerRoutingGroupColumn,
  describeComposerEffort,
  resolveModelRowEffort,
} from "./ComposerModelEffort";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

/**
 * The composer footer controls: the model picker (which also holds effort, speed and
 * permissions), mode controls and the overflow menu for blocks that do not fit. Rendered in the
 * expanded footer or the resting controls host.
 */
// Model and effort share one trigger; it stays filled while its popup is open.
const MODEL_TRIGGER_STATES = "data-popup-open:bg-accent data-popup-open:text-foreground";

/** The model's name as the picker lists it, for naming a team's lead. */
function triggerModelName(
  selection: ModelSelection,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): string {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  return entry?.models.find((model) => model.slug === selection.model)?.name ?? selection.model;
}

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
  /** The team the user turned on (or off, null) after launch. */
  activeThreadAgentTeam: ThreadAgentTeam | null | undefined;
  /** The running thread's token saver and Council. */
  activeThreadAssists: ThreadAssistsState | undefined;
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
  /** Sits on the right, before permissions, like Antigravity's usage pill. */
  trailingSlot?: ReactNode;
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
    trailingSlot,
  } = props;
  const accessMatchesDefault = compatibleRuntimeMode === defaultRuntimeMode;
  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: restingHiddenBlockCount,
    hiddenBlockIds: hiddenRestingBlockIds,
    overflowShowsPermissions,
  } = resolveComposerControlsOwnership({
    collapsed: composerControlsCollapsed,
    measuredHiddenBlockCount,
  });
  const navigate = useNavigate();
  const stickyOptionsByModelByProvider = useComposerDraftStore(
    (store) => store.stickyOptionsByModelByProvider,
  );
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
    settingEnabled: serverConfig?.settings.autoRouting?.enabled,
  });
  const draftEffortManual = useComposerDraftStore((store) =>
    draftId ? store.getComposerDraft(draftId)?.effortManual === true : false,
  );
  const draftModelExplicit = useComposerDraftStore((store) =>
    draftId ? store.getComposerDraft(draftId)?.modelSelectionExplicit === true : false,
  );
  const setEffortManual = useComposerDraftStore((store) => store.setEffortManual);
  const setRoutingGroup = useComposerDraftStore((store) => store.setRoutingGroup);
  const draftRoutingGroupId = useComposerDraftStore((store) =>
    routeKind === "draft" && draftId
      ? (store.getComposerDraft(draftId)?.routingGroupId ?? null)
      : null,
  );
  const nowMs = Date.parse(useNowMinute());
  const providerModels = providerInstanceEntries.map((entry) =>
    routingProviderSource(entry.snapshot, nowMs),
  );
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
          team: false,
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
          agentTeam: props.activeThreadAgentTeam,
          selection: selectedModelSelection,
          providers: providerModels,
        })
      : null;
  const routedModel =
    routeKind === "server"
      ? routedModelDisplay({
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
          note: autoRoutingNote({
            capability: serverConfig?.environment.capabilities.autoModelRouting,
            settings: serverConfig?.settings.autoRouting,
            modelExplicit: draftModelExplicit,
          }),
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
          ? pickedGroup.team
            ? `Agent team: ${pickedGroup.summary}`
            : `Routing group: a usable member of ${pickedGroup.summary}`
          : "This routing group no longer exists",
      }
    : routedGroup
      ? {
          suffix: traitsEffort.suffix,
          detail: [routedGroup.label, routedGroup.skipped, traitsEffort.detail]
            .filter(Boolean)
            .join(" · "),
        }
      : routedModel
        ? {
            suffix: traitsEffort.suffix,
            detail: [routedModel, traitsEffort.detail].filter(Boolean).join(" · "),
          }
        : traitsEffort;
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "agent team change",
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const teamsCapability =
    serverConfig?.environment.capabilities.agentTeams === true &&
    serverConfig.environment.capabilities.routingGroups === true;
  const serverThreadId = routeKind === "server" ? routeThreadRef?.threadId : undefined;
  const savedGroups = serverConfig?.settings.routingGroups ?? [];
  const savedTeams = savedGroups.filter((group) => group.team === true);
  // A draft's automatic team (or none) waits on the draft; a saved team is its routing group.
  const draftAssistsAtom = draftThreadAssistsAtom(routeKind === "draft" && draftId ? draftId : "");
  const draftAssists = useAtomValue(draftAssistsAtom);
  const defaultAutoTeam =
    AUTO_TEAMS.find((team) => team.kind === serverConfig?.settings.agentTeamDefault) ?? null;
  const activeTeam =
    routeKind === "server"
      ? teamsCapability
        ? threadAgentTeamRef({
            routing: props.activeThreadRouting,
            agentTeam: props.activeThreadAgentTeam,
            modelSelection: selectedModelSelection,
          })
        : null
      : pickedGroup?.team
        ? { id: pickedGroup.id, name: pickedGroup.name }
        : draftAssists.agentTeam !== undefined
          ? draftAssists.agentTeam
          : defaultAutoTeam && { id: defaultAutoTeam.id, name: defaultAutoTeam.name };
  const setDraftTeam = (agentTeam: ThreadAgentTeam | null) =>
    appAtomRegistry.set(draftAssistsAtom, { ...appAtomRegistry.get(draftAssistsAtom), agentTeam });
  const setThreadTeam = (agentTeam: ThreadAgentTeam | null) => {
    if (serverThreadId === undefined) return;
    void updateThreadMetadata({
      environmentId,
      input: { threadId: serverThreadId, agentTeam },
    });
  };
  const teamChoices = savedTeams.map((team) => ({
    id: team.id,
    name: team.name,
    summary: agentTeamSummary(team, team.members[0], providerModels),
  }));
  // An automatic kind is remembered for new threads; No team forgets it.
  const selectAutoTeam = useStableCallback((kind: AutoTeamKind) => {
    const team = AUTO_TEAMS.find((candidate) => candidate.kind === kind);
    if (!team) return;
    const ref = { id: team.id, name: team.name };
    updateSettings({ agentTeamDefault: kind });
    if (routeKind !== "server") {
      if (pickedGroup?.team) clearPickedGroup();
      setDraftTeam(ref);
      return;
    }
    setThreadTeam(ref);
  });
  const selectNoTeam = useStableCallback(() => {
    updateSettings({ agentTeamDefault: null });
    if (routeKind !== "server") {
      if (pickedGroup?.team) clearPickedGroup();
      setDraftTeam(null);
      return;
    }
    setThreadTeam(null);
  });
  // A saved team picked here keeps the thread's model as its lead; the setup can change it.
  const selectSavedTeam = useStableCallback((teamId: string) => {
    const team = savedTeams.find((candidate) => candidate.id === teamId);
    if (!team) return;
    if (routeKind !== "server") {
      handleRoutingGroupSelect(team.id);
      setDraftTeam({ id: team.id, name: team.name });
      return;
    }
    setThreadTeam({ id: team.id, name: team.name });
  });
  const teamDisabledReason =
    multipleModelSelections !== null ? "Pick one model to work as a team." : null;
  // The setup saves teams in place, keeping every plain routing group as it was.
  const saveTeams = useStableCallback((teams: ReadonlyArray<RoutingGroup>) => {
    updateSettings({
      routingGroups: [...savedGroups.filter((group) => group.team !== true), ...teams],
    });
  });
  const applyTeam = useStableCallback((team: RoutingGroup) => {
    const architect = team.members[0];
    if (!architect) return;
    if (routeKind !== "server") {
      if (draftId) setRoutingGroup(draftId, { id: team.id, placeholder: architect });
      setDraftTeam({ id: team.id, name: team.name });
      return;
    }
    if (serverThreadId === undefined) return;
    // The architect leads: the thread switches to it, then leads the team from its next message.
    if (
      architect.instanceId !== selectedModelSelection.instanceId ||
      architect.model !== selectedModelSelection.model
    ) {
      onProviderModelSelect(architect.instanceId, architect.model);
    }
    void updateThreadMetadata({
      environmentId,
      input: { threadId: serverThreadId, agentTeam: { id: team.id, name: team.name } },
    });
  });
  const disableTeam = selectNoTeam;
  const showTeamControl =
    teamsCapability && (routeKind === "server" ? serverThreadId !== undefined : Boolean(draftId));
  // Teams are picked in the model picker's Team tab, with their setup beside the list.
  const selectPickerTeam = useStableCallback((row: ModelPickerTeamRow) => {
    switch (row.kind) {
      case "none":
        selectNoTeam();
        return;
      case "auto":
        selectAutoTeam(row.auto);
        return;
      case "saved":
        selectSavedTeam(row.id);
        return;
    }
  });
  const closeModelPicker = useStableCallback(() => onModelPickerOpenChange(false));
  const handleViewUsage = useStableCallback(() => {
    onModelPickerOpenChange(false);
    void navigate({ to: "/usage" });
  });
  const getModelEffort = useStableCallback((instanceId: ProviderInstanceId, slug: string) => {
    if (
      instanceId === selectedInstanceId &&
      (slug === selectedModel || slug === selectedModelForPickerWithCustomFallback)
    ) {
      return resolveModelRowEffort(traitsInput, effortRouting);
    }
    const entry = providerInstanceEntries.find((candidate) => candidate.instanceId === instanceId);
    if (!entry) return null;
    return resolveModelRowEffort({
      provider: entry.driverKind,
      instanceId,
      models: entry.models,
      model: slug,
      modelOptions: stickyOptionsByModelByProvider[instanceId]?.[slug],
    });
  });
  const pickerTeams: PickerTeams | undefined = showTeamControl
    ? {
        activeId: activeTeam?.id ?? null,
        saved: teamChoices,
        disabledReason: teamDisabledReason,
        onSelect: selectPickerTeam,
        setupColumn: (
          <ComposerTeamSetup
            // Starts again from the team in use whenever another team is picked.
            key={activeTeam?.id ?? "none"}
            teams={savedTeams}
            active={activeTeam}
            newThread={routeKind !== "server"}
            entries={providerInstanceEntries}
            currentSelection={selectedModelSelection}
            sharedGuidance={serverConfig?.settings.agentTeamLeadGuidance ?? ""}
            disabledReason={teamDisabledReason}
            onDone={closeModelPicker}
            onSaveTeams={saveTeams}
            onApply={applyTeam}
            onDisable={disableTeam}
          />
        ),
      }
    : undefined;
  // A thread working as a team shows the team's name on the model trigger.
  const teamTriggerDetail = activeTeam
    ? `Agent team ${activeTeam.name}, led by ${triggerModelName(selectedModelSelection, providerInstanceEntries)}`
    : null;
  const restingBlockDefs = showModeBlock
    ? [
        {
          id: "mode",
          content: (
            <ComposerFooterModeControls
              runtimeMode={compatibleRuntimeMode}
              defaultRuntimeMode={defaultRuntimeMode}
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
      popupAlign="start"
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
      triggerDetail={
        teamTriggerDetail && !pickedGroup?.team && !effort.detail?.includes(activeTeam?.name ?? "")
          ? [teamTriggerDetail, effort.detail].filter(Boolean).join(" · ")
          : effort.detail
      }
      {...(activeTeam
        ? {
            triggerLabel: activeTeam.name,
            triggerIcon: (
              <UsersIcon
                data-composer-agent-team="on"
                className="size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
            ),
          }
        : pickedGroup
          ? { triggerLabel: pickedGroup.name }
          : {})}
      // Teams live in the Team tab, so the groups tab keeps only plain routing groups.
      routingGroups={
        pickerTeams ? routingGroups.filter((group) => group.team !== true) : routingGroups
      }
      activeRoutingGroupId={draftRoutingGroupId}
      {...(pickerTeams ? { teams: pickerTeams } : {})}
      onRoutingGroupSelect={handleRoutingGroupSelect}
      triggerShortcuts="composer.effort"
      getModelEffort={getModelEffort}
      effortColumn={
        pickedGroup ? (
          <ComposerRoutingGroupColumn
            name={pickedGroup.name}
            summary={pickedGroup.summary}
            team={pickedGroup.team}
          />
        ) : (
          <ComposerEffortColumn
            traits={traitsInput}
            routing={effortRouting}
            routedGroup={routedGroup}
          />
        )
      }
      footer={<ComposerPickerFooter onViewUsage={handleViewUsage} />}
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
      <div data-resting-fixed className="flex shrink-0 items-center gap-1 empty:hidden">
        <ComposerThreadAssists
          environmentId={environmentId}
          serverThreadId={serverThreadId}
          draftId={routeKind === "draft" ? draftId : null}
          thread={props.activeThreadAssists}
          size={controlSize}
        />
      </div>
      {/* Two spacers center the usage pill between the left and right groups. The measurement
          counts their minimum, so a tight row sheds controls before the gaps close. */}
      <div
        data-resting-controls-spacer
        aria-hidden="true"
        className={cn("flex-1", trailingSlot ? "min-w-8" : "min-w-0")}
      />
      {trailingSlot ? (
        <div data-resting-fixed className="flex shrink-0 items-center empty:hidden">
          {trailingSlot}
        </div>
      ) : null}
      {trailingSlot ? (
        <div data-resting-controls-spacer aria-hidden="true" className="min-w-8 flex-1" />
      ) : null}
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
            defaultRuntimeMode={defaultRuntimeMode}
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
