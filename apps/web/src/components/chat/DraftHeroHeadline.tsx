import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  CheckIcon,
  ChevronDownIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MonitorIcon,
  ScaleIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useProjectPin } from "~/hooks/useProjectGroupUpdate";
import { useScratchProject } from "~/hooks/useScratchProject";
import { isTriagePrompt } from "@t3tools/shared/triagePrompt";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  buildSidebarProjectPickerEntries,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useEnvironmentProviders,
} from "~/state/environments";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import { T3Wordmark } from "../T3Wordmark";
import { useSortedProjectGroups } from "../CommandPaletteLookups";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DraftProjectName } from "./DraftProjectName";
import { TriageDraftHero } from "./TriageDraftHero";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { HomeStudioPanelSkeleton } from "../usage/HomeStudioPanelFrame";

// Split out so the usage panel never delays the composer's first paint.
const HomeStudioPanel = lazy(() =>
  import("../usage/HomeStudioPanel").then((module) => ({ default: module.HomeStudioPanel })),
);

const ADD_PROJECT_VALUE = "add-project";
const NO_PROJECT_VALUE = "no-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  // A boolean, so typing in a draft does not re-render the hero.
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const { scratchWorkspaceRootFor } = useScratchProject();
  const showStudioPanel = useClientSettings((settings) => settings.homeStudioPanel);

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
  });
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));

  if (isScratchDraft && isTriageDraftPrompt) {
    const environment = environments.find(
      (entry) => entry.environmentId === activeProject.environmentId,
    );
    return (
      <TriageDraftHero
        machineLabel={environment?.label ?? null}
        serverVersion={environment?.serverConfig?.environment.serverVersion ?? null}
      />
    );
  }

  return (
    <div className="flex w-full flex-col items-start">
      <div className="flex w-full items-center gap-3 text-left">
        <T3Wordmark aria-hidden="true" className="h-6 w-auto shrink-0 text-primary sm:h-7" />
        <h1 className="min-w-0 truncate font-bold text-2xl text-foreground tracking-tight sm:text-3xl">
          {hasResolvedProject && !isScratchDraft ? (
            <>What should we build in {activeProjectTitle}?</>
          ) : isScratchDraft || canChooseProject ? (
            <>What should we work on?</>
          ) : (
            <>Add a project to start</>
          )}
        </h1>
      </div>
      {showStudioPanel ? (
        <Suspense fallback={<HomeStudioPanelSkeleton />}>
          <HomeStudioPanel />
        </Suspense>
      ) : null}
    </div>
  );
}

interface DraftHeroComposerBarProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  readonly environmentId: EnvironmentId;
  readonly availableEnvironments: readonly EnvironmentOption[];
  readonly autoEnvironmentLabel?: string | undefined;
  readonly onAutoEnvironment?: (() => void) | undefined;
  readonly envLocked?: boolean | undefined;
  readonly onEnvironmentChange?: ((environmentId: EnvironmentId) => void) | undefined;
}

export function DraftHeroComposerBar({
  draftId,
  activeProjectRef,
  activeProjectTitle,
  environmentId,
  availableEnvironments,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked = false,
  onEnvironmentChange,
}: DraftHeroComposerBarProps) {
  const navigate = useNavigate();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const isTriageDraftPrompt = useComposerDraftStore((store) =>
    draftId ? isTriagePrompt(store.getComposerDraft(draftId)?.prompt ?? "") : false,
  );
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = () => openCommandPalette({ open: "add-project" });
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const highlightedPickerValueRef = useRef<string | null>(null);
  const { canPinProjectGroup, toggleProjectGroupPin } = useProjectPin();

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const projectGroups = useSortedProjectGroups(environmentLabelById);
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const environmentMachineById = new Map(
    environments.map(
      (environment) =>
        [
          environment.environmentId,
          resolveEnvironmentMachineKind(environment.serverConfig),
        ] as const,
    ),
  );
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(projectGroups),
    preferredProjectRef: activeProjectRef,
  });
  const projectEntryByKey = new Map(
    projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const canChooseProject = projectPickerEntries.length > 0;
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(activeProjectRef?.environmentId ?? null);
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null &&
    isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId));

  // Pinning from a row keeps rows in place while the picker is open.
  const pickerItems: readonly PickerItem[] = useOrderWhileOpen(
    [
      ...menuEntries.map(({ group }) => ({ value: group.projectKey, label: group.displayName })),
      ...(scratchWorkspaceRoot !== null && !isScratchDraft
        ? [{ value: NO_PROJECT_VALUE, label: "No project" }]
        : []),
      { value: ADD_PROJECT_VALUE, label: "Add project" },
    ],
    (item) => item.value,
    pickerOpen,
  );
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter(
          (item) =>
            item.value !== ADD_PROJECT_VALUE &&
            item.value !== NO_PROJECT_VALUE &&
            pickerFilter.contains(item, pickerSearch, (candidate) => candidate.label),
        );
  const selectedPickerItem = pickerItems.find((item) => item.value === activeProjectKey) ?? null;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const pendingScratchRef = useRef<symbol | null>(null);
  const draftTargetKey = () => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    return session
      ? `${session.environmentId}:${session.projectId}:${session.logicalProjectKey}`
      : null;
  };
  // Retargeting an empty draft would overwrite the project's draft and strand browser tabs.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    pendingScratchRef.current = null;
    const currentDraft = getComposerDraft(draftId);
    if (!composerDraftHasUserContent(currentDraft)) {
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
      return;
    }
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentConfig = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig;
      const environmentSettings = environmentConfig?.settings;
      const defaultSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      const fallbackResolution = resolveNewThreadModelSelection({
        defaultSelection:
          defaultSelection ??
          (useComposerDraftStore.getState().stickyActiveProvider !== null || !environmentSettings
            ? null
            : resolveProjectDefaultProviderModelSelection(
                providersByEnvironment.get(project.environmentId) ?? [],
                environmentSettings,
                project.id,
              )),
        fallbackSelection: environmentSettings?.fallbackModelSelection ?? null,
        providers: providersByEnvironment.get(project.environmentId) ?? [],
        ...(environmentSettings ? { settings: environmentSettings } : {}),
        projectId: project.id,
        now: Date.now(),
      });
      const defaultModelSelection = fallbackResolution.fallback
        ? fallbackResolution.selection
        : defaultSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const request = Symbol("scratch");
    pendingScratchRef.current = request;
    const requestedTarget = draftTargetKey();
    const project = await openScratchProject(scratchTargetEnvironmentId);
    if (!project || pendingScratchRef.current !== request || draftTargetKey() !== requestedTarget) {
      return false;
    }
    pendingScratchRef.current = null;
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  if (isScratchDraft && isTriageDraftPrompt) {
    return null;
  }

  const projectChipClasses =
    "pointer-events-auto inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-card/85 px-3 text-xs font-medium text-foreground shadow-xs/5 backdrop-blur-sm transition-colors hover:bg-accent/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

  const projectSelector = canChooseProject ? (
    <Combobox
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onItemHighlighted={(item) => {
        highlightedPickerValueRef.current = item?.value ?? null;
      }}
      onOpenChange={(open) => {
        setPickerOpen(open);
        setPickerQuery("");
      }}
      value={selectedPickerItem}
      onValueChange={(item) => {
        if (!item) return;
        setPickerOpen(false);
        if (item.value === ADD_PROJECT_VALUE) {
          openAddProject();
          return;
        }
        if (item.value === NO_PROJECT_VALUE) {
          void startScratch().then((started) => {
            if (started) {
              document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
            }
          });
          return;
        }
        const entry = projectEntryByKey.get(item.value);
        if (!entry || item.value === activeProjectKey) {
          return;
        }
        selectProject(entry.targetProject, entry.group.projectKey);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={<button type="button" />}
              data-draft-project-trigger=""
              className={projectChipClasses}
            />
          }
        >
          <DraftProjectName
            value={isScratchDraft ? "No project" : (activeProjectTitle ?? "Choose a project")}
            singleLine
          />
          <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        </TooltipTrigger>
        {activeProjectTitle && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectTitle}</TooltipPopup>
        ) : null}
      </Tooltip>
      <ComboboxPopup align="start" side="top" className="w-72 overflow-hidden">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            const highlighted = highlightedPickerValueRef.current;
            const group = highlighted ? projectEntryByKey.get(highlighted)?.group : undefined;
            if (!group || !canPinProjectGroup(group) || !isProjectPinShortcut(event, keybindings)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            toggleProjectGroupPin(group);
          }}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            return (
              <ComboboxItem key={item.value} hideIndicator value={item}>
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : item.value === NO_PROJECT_VALUE ? (
                  <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                    <DraftProjectName value={item.label} />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{item.label}</TooltipPopup>
                </Tooltip>
                {entry && canPinProjectGroup(entry.group) ? (
                  <ProjectPinButton
                    name={entry.group.displayName}
                    pinned={entry.group.pinned}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                    onToggle={() => toggleProjectGroupPin(entry.group)}
                  />
                ) : null}
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  ) : (
    <button type="button" onClick={openAddProject} className={projectChipClasses}>
      <DraftProjectName value={activeProjectTitle ?? "Add a project"} singleLine />
    </button>
  );

  const activeEnvironmentOption =
    availableEnvironments.find((env) => env.environmentId === environmentId) ?? null;
  const fallbackEnvironment =
    environments.find((env) => env.environmentId === environmentId) ?? environments[0] ?? null;
  const activeEnvironmentLabel =
    autoEnvironmentLabel ??
    activeEnvironmentOption?.label ??
    fallbackEnvironment?.label ??
    "This device";
  const activeEnvironmentMachine =
    activeEnvironmentOption?.machine ??
    (fallbackEnvironment?.serverConfig
      ? resolveEnvironmentMachineKind(fallbackEnvironment.serverConfig)
      : null);
  const canPickEnvironment =
    availableEnvironments.length > 1 && !envLocked && onEnvironmentChange !== undefined;
  const hostShortcutLabel = shortcutLabelForCommand(keybindings, "composer.host");

  const envIconButtonClasses =
    "pointer-events-auto inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/70 bg-card/85 text-muted-foreground shadow-xs/5 backdrop-blur-sm transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

  const environmentIcon = autoEnvironmentLabel ? (
    <ScaleIcon aria-hidden="true" className="size-3.5" />
  ) : activeEnvironmentMachine ? (
    <EnvironmentMachineIcon kind={activeEnvironmentMachine} className="size-3.5" />
  ) : (
    <MonitorIcon aria-hidden="true" className="size-3.5" />
  );

  const environmentButton = canPickEnvironment ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<button type="button" />}
              aria-label={`Run on ${activeEnvironmentLabel}`}
              data-draft-environment-trigger=""
              className={envIconButtonClasses}
            />
          }
        >
          {environmentIcon}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {activeEnvironmentLabel}
          {hostShortcutLabel ? ` · ${hostShortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top">
        <MenuGroup>
          <MenuGroupLabel>Run on</MenuGroupLabel>
          {onAutoEnvironment ? (
            <MenuItem onClick={onAutoEnvironment}>
              <ScaleIcon aria-hidden="true" className="size-3.5" />
              <span className="flex-1">{autoEnvironmentLabel ?? "Auto balance"}</span>
              {autoEnvironmentLabel ? <CheckIcon aria-hidden="true" className="size-3.5" /> : null}
            </MenuItem>
          ) : null}
          {availableEnvironments.map((env) => {
            const selected = !autoEnvironmentLabel && env.environmentId === environmentId;
            return (
              <MenuItem
                key={env.environmentId}
                onClick={() => onEnvironmentChange(env.environmentId)}
              >
                <EnvironmentMachineIcon kind={env.machine} className="size-3.5" />
                <span className="flex-1">{env.label}</span>
                {selected ? <CheckIcon aria-hidden="true" className="size-3.5" /> : null}
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  ) : (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Environment: ${activeEnvironmentLabel}`}
            data-draft-environment-trigger=""
            onClick={() => void navigate({ to: "/settings/connections" })}
            className={envIconButtonClasses}
          />
        }
      >
        {environmentIcon}
      </TooltipTrigger>
      <TooltipPopup side="top">{activeEnvironmentLabel} · Connections</TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      data-draft-hero-composer-meta="true"
      className="pointer-events-none relative z-30 flex w-full items-center gap-2"
    >
      <div className="min-w-0 max-w-full">{projectSelector}</div>
      {environmentButton}
    </div>
  );
}
