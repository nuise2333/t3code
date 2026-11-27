import { newRoutingGroupId } from "@t3tools/client-runtime/routing";
import {
  AGENT_TEAM_INSTRUCTIONS_MAX_LENGTH,
  AGENT_TEAM_LEAD_GUIDANCE_MAX_LENGTH,
  type AgentTeamRole,
  type AutoTeamKind,
  autoTeamKind,
  MAX_ROUTING_GROUP_MEMBERS,
  MAX_ROUTING_GROUPS,
  type ModelSelection,
  type RoutingGroup,
} from "@t3tools/contracts";
import type { AgentTeamLeads } from "@t3tools/contracts/settings";
import { useGT, useMessages } from "gt-react";
import { InfoIcon, MoreHorizontalIcon, PlusIcon, XIcon } from "lucide-react";
import { Fragment, memo, useId, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { rankModelPickerSearch } from "@t3tools/client-runtime/model-search";
import { agentTeamMembersProblem, agentTeamRole } from "@t3tools/shared/agentTeam";
import { createModelSelection } from "@t3tools/shared/model";
import { selectsPlanAgent } from "../../modelSelection";
import {
  AgentTeamHandsTo,
  AgentTeamRoleDetails,
  AgentTeamRoleName,
  EMPTY_TEAM_ROLE,
  namedTeamFlows,
  type TeamRowFlow,
  teamRowFlows,
  useTeamMembersProblemText,
} from "./AgentTeamRoleFields";
import { AUTO_TEAM_TEXT, teamDisplayName } from "./agentTeamPick.logic";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { TraitsPicker } from "./TraitsPicker";

/** The setup kept when no named profile is picked; it is a team like any other. */
const CUSTOM_TEAM_ID = "custom-setup";
// Saved with the team, so it stays English as data; only its label follows the UI language.
const CUSTOM_TEAM_NAME = "Custom setup";

interface SetupWorker {
  /** Keeps a row's own state with it when another is removed. */
  readonly key: number;
  readonly selection: ModelSelection | null;
  readonly role: AgentTeamRole;
}

const ARCHITECT_KEY = -1;
let nextWorkerKey = 0;
const newWorker = (
  selection: ModelSelection | null = null,
  role: AgentTeamRole = EMPTY_TEAM_ROLE,
): SetupWorker => ({ key: nextWorkerKey++, selection, role });

interface Setup {
  readonly architect: ModelSelection | null;
  readonly architectRole: AgentTeamRole;
  readonly flows: ReadonlyArray<TeamRowFlow>;
  readonly workers: ReadonlyArray<SetupWorker>;
  readonly guidance: string;
  readonly sharedGuidance: string;
  readonly unlimited: boolean;
  readonly parallel: number;
}

const keyOf = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `${selection.instanceId}\u0000${selection.model}`;

function setupOf(team: RoutingGroup | undefined, fallbackLead: ModelSelection | null): Setup {
  const [architect, ...workers] = team?.members ?? [];
  const rows = team
    ? workers.map((selection, index) => newWorker(selection, team.memberRoles?.[index + 1]))
    : [newWorker()];
  return {
    architect: architect ?? fallbackLead,
    architectRole: team?.memberRoles?.[0] ?? EMPTY_TEAM_ROLE,
    workers: rows,
    flows: team ? teamRowFlows(team, [ARCHITECT_KEY, ...rows.map((row) => row.key)]) : [],
    guidance: team?.leadGuidance ?? "",
    sharedGuidance: team?.sharedGuidance ?? "",
    unlimited: (team?.maxParallel ?? 0) === 0,
    parallel: team?.maxParallel || 3,
  };
}

function InfoMark(props: { readonly label: string; readonly text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <InfoIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {props.text}
      </TooltipPopup>
    </Tooltip>
  );
}

function ModelField(props: {
  readonly label: string;
  readonly value: ModelSelection | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <ModelSelect {...props} />
      </div>
      <MemberEffort {...props} />
    </div>
  );
}

/** The member's reasoning effort and other options, kept with it in the saved team. */
function MemberEffort(props: {
  readonly label: string;
  readonly value: ModelSelection | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const value = props.value;
  const entry = value
    ? props.entries.find((candidate) => candidate.instanceId === value.instanceId)
    : null;
  if (!value || !entry) return null;
  return (
    <div data-team-member-effort className="shrink-0">
      <TraitsPicker
        provider={entry.driverKind}
        instanceId={value.instanceId}
        models={entry.models}
        model={value.model}
        modelOptions={value.options ?? []}
        allowPromptInjectedEffort={false}
        includePlanAgent={selectsPlanAgent(value.options)}
        triggerClassName="min-w-0 max-w-28 overflow-hidden"
        onModelOptionsChange={(options) =>
          props.onChange(createModelSelection(value.instanceId, value.model, options))
        }
      />
    </div>
  );
}

function ModelSelect(props: {
  readonly label: string;
  readonly value: ModelSelection | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = props.entries.filter((entry) => entry.enabled && entry.models.length > 0);
  const value = props.value;
  const entry = value
    ? options.find((candidate) => candidate.instanceId === value.instanceId)
    : null;
  const modelName = value
    ? (entry?.models.find((model) => model.slug === value.model)?.name ?? value.model)
    : null;

  const choices = open
    ? options.flatMap((option) =>
        option.models.map((model) => ({
          key: keyOf({ instanceId: option.instanceId, model: model.slug }),
          entry: option,
          model,
        })),
      )
    : [];
  const searching = query.trim().length > 0;
  const visible = searching
    ? rankModelPickerSearch(choices, query, (choice) => ({
        name: choice.model.name,
        ...(choice.model.shortName ? { shortName: choice.model.shortName } : {}),
        ...(choice.model.subProvider ? { subProvider: choice.model.subProvider } : {}),
        driverKind: choice.entry.driverKind,
        providerDisplayName: choice.entry.displayName,
      }))
    : choices;
  const keys = visible.map((choice) => choice.key);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  return (
    <Combobox
      items={keys}
      filteredItems={keys}
      filter={null}
      autoHighlight
      open={open}
      onOpenChange={handleOpenChange}
      value={value ? keyOf(value) : null}
      onValueChange={(next) => {
        handleOpenChange(false);
        if (typeof next !== "string" || next === "") return;
        // Re-picking the current model keeps its saved options, such as effort.
        if (value && keyOf(value) === next) return;
        const picked = visible.find((choice) => choice.key === next);
        if (picked)
          props.onChange({ instanceId: picked.entry.instanceId, model: picked.model.slug });
      }}
    >
      <ComboboxTrigger aria-label={props.label} render={<SelectButton className="w-full" />}>
        {value ? (
          <span className="flex min-w-0 items-center gap-2">
            {entry ? <EntryIcon entry={entry} /> : null}
            <span className="truncate">{modelName}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{gt("Choose a model")}</span>
        )}
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-72">
        <ComboboxSearchInput
          aria-label={gt("Search models")}
          placeholder={gt("Search models...")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>{gt("No models found.")}</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {visible.map((choice, index) => {
            const groupStart =
              !searching && visible[index - 1]?.entry.instanceId !== choice.entry.instanceId;
            return (
              <Fragment key={choice.key}>
                {groupStart ? (
                  <div className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs first:pt-1">
                    {choice.entry.displayName}
                  </div>
                ) : null}
                <ComboboxItem index={index} value={choice.key}>
                  {searching ? <EntryIcon entry={choice.entry} /> : null}
                  <span className="min-w-0 flex-1 truncate">{choice.model.name}</span>
                  {searching ? (
                    <span className="shrink-0 truncate text-muted-foreground text-xs">
                      {choice.entry.displayName}
                    </span>
                  ) : null}
                </ComboboxItem>
              </Fragment>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function EntryIcon(props: { readonly entry: ProviderInstanceEntry }) {
  return (
    <ProviderInstanceIcon
      driverKind={props.entry.driverKind}
      displayName={props.entry.displayName}
      accentColor={props.entry.accentColor}
      acpRegistryAgentId={props.entry.acpRegistryAgentId}
      acpRegistryIconUrl={props.entry.acpRegistryIconUrl}
      size="compact"
    />
  );
}

/**
 * Architect & workers, beside the model picker's Agent team tab: the architect leads this thread
 * and delegates to the workers; Save setup keeps it as a team and turns it on here. An automatic
 * team picks its own workers, so it shows only its architect. Keyed by the team in use, so it
 * starts from that team each time.
 */
export const ComposerTeamSetup = memo(function ComposerTeamSetup(props: {
  readonly teams: ReadonlyArray<RoutingGroup>;
  /** The team this thread leads or the draft picked; its name stays even if it was deleted. */
  readonly active: { readonly id: string; readonly name: string } | null;
  readonly newThread: boolean;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  /** The thread's model, which a new setup starts from as its architect. */
  readonly currentSelection: ModelSelection;
  readonly sharedGuidance: string;
  /** The server keeps member roles and team guidance. */
  readonly rolesSupported: boolean;
  /** The server keeps which members may hand work on. */
  readonly flowsSupported: boolean;
  /** Every saved team and routing group, which share one limit. */
  readonly groupIds: ReadonlyArray<string>;
  /** After Apply, such as closing the picker. */
  readonly onDone: () => void;
  readonly disabledReason?: string | null;
  readonly onSaveTeams: (teams: ReadonlyArray<RoutingGroup>) => void;
  readonly onApply: (team: RoutingGroup) => void;
  /** The architect set for each automatic team; one without keeps the thread's model. */
  readonly autoLeads: AgentTeamLeads | undefined;
  readonly onAutoLeadChange: (kind: AutoTeamKind, lead: ModelSelection) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const problemText = useTeamMembersProblemText();
  const teamLabel = (name: string) => (name === CUSTOM_TEAM_NAME ? gt("Custom setup") : name);
  const active = props.active;
  const initialProfile =
    active && props.teams.some((team) => team.id === active.id) ? active.id : CUSTOM_TEAM_ID;
  const [profileId, setProfileId] = useState<string>(initialProfile);
  const [setup, setSetup] = useState<Setup>(() =>
    setupOf(
      props.teams.find((team) => team.id === initialProfile),
      props.currentSelection,
    ),
  );
  const [naming, setNaming] = useState<{
    readonly kind: "new" | "rename";
    readonly value: string;
  } | null>(null);
  const guidanceId = useId();
  const parallelId = useId();
  const profile = props.teams.find((team) => team.id === profileId);
  const named = props.teams.filter((team) => team.id !== CUSTOM_TEAM_ID);

  const load = (id: string) => {
    const team = props.teams.find((candidate) => candidate.id === id);
    setProfileId(id);
    setNaming((current) => (current?.kind === "rename" ? null : current));
    setSetup(setupOf(team, props.currentSelection));
  };

  const rolesSupported = props.rolesSupported;
  const workers = setup.workers.flatMap(({ selection, role }) =>
    selection === null ? [] : [{ selection, role }],
  );
  const members = [
    ...(setup.architect === null
      ? []
      : [{ selection: setup.architect, role: setup.architectRole }]),
    ...workers,
  ];
  const roleRows = [
    { key: ARCHITECT_KEY, role: setup.architectRole },
    ...setup.workers.filter((worker) => worker.selection !== null),
  ];
  const handsTo = (label: string, row: (typeof roleRows)[number]) =>
    props.flowsSupported ? (
      <AgentTeamHandsTo
        label={label}
        row={row}
        rows={roleRows}
        flows={setup.flows}
        onChange={(flows) => setSetup((current) => ({ ...current, flows }))}
      />
    ) : null;
  const setWorker = (index: number, patch: Partial<SetupWorker>) =>
    setSetup((current) => ({
      ...current,
      workers: current.workers.map((worker, at) =>
        at === index ? { ...worker, ...patch } : worker,
      ),
    }));
  const teamFrom = (id: string, name: string): RoutingGroup => ({
    id,
    name,
    strategy: "order",
    team: true,
    members: members.map((member) => member.selection),
    ...(rolesSupported
      ? {
          memberRoles: members.map((member) => member.role),
          sharedGuidance: setup.sharedGuidance.trim(),
        }
      : {}),
    ...(props.flowsSupported ? { memberFlows: namedTeamFlows(roleRows, setup.flows) } : {}),
    maxParallel: setup.unlimited ? 0 : Math.max(1, Math.min(32, Math.round(setup.parallel))),
    leadGuidance: setup.guidance.trim(),
  });
  const problem =
    setup.architect === null
      ? gt("Choose an architect.")
      : workers.length === 0
        ? gt("Add a worker.")
        : members.length > MAX_ROUTING_GROUP_MEMBERS
          ? gt("A team takes at most {count} models.", { count: MAX_ROUTING_GROUP_MEMBERS })
          : problemText(
              agentTeamMembersProblem({
                members: members.map((member) => member.selection),
                ...(rolesSupported ? { memberRoles: members.map((member) => member.role) } : {}),
              }),
            );
  const full = props.groupIds.length >= MAX_ROUTING_GROUPS;
  const fullReason = gt("You can save at most {count} teams and routing groups.", {
    count: MAX_ROUTING_GROUPS,
  });
  // Custom setup is saved the first time it is applied, so it needs a free place then.
  const saveProblem = problem ?? (profile === undefined && full ? fullReason : null);

  const upsert = (team: RoutingGroup) =>
    props.teams.some((existing) => existing.id === team.id)
      ? props.teams.map((existing) => (existing.id === team.id ? team : existing))
      : [...props.teams, team];
  const save = () => {
    if (saveProblem !== null) return;
    const team = teamFrom(profile?.id ?? CUSTOM_TEAM_ID, profile?.name ?? CUSTOM_TEAM_NAME);
    props.onSaveTeams(upsert(team));
    props.onApply(team);
    props.onDone();
  };
  const saveAs = () => {
    const name = naming?.value.trim();
    if (!name || problem !== null || full) return;
    const team = teamFrom(newRoutingGroupId(name, props.groupIds), name);
    props.onSaveTeams(upsert(team));
    setProfileId(team.id);
    setNaming(null);
  };
  const rename = () => {
    const name = naming?.value.trim();
    if (!name || !profile || profile.id === CUSTOM_TEAM_ID) return;
    props.onSaveTeams(
      props.teams.map((team) => (team.id === profile.id ? { ...team, name } : team)),
    );
    setNaming(null);
  };
  const submitName = () => (naming?.kind === "rename" ? rename() : saveAs());
  const remove = () => {
    if (!profile || profile.id === CUSTOM_TEAM_ID) return;
    props.onSaveTeams(props.teams.filter((team) => team.id !== profile.id));
    load(CUSTOM_TEAM_ID);
  };

  // Matches the effort column's header, so one rule runs across the top of the popup.
  const header = (
    <div className="shrink-0 px-3 pt-2.5">
      <div className="flex h-8.25 -translate-y-px items-center gap-2 border-b border-border/70 pb-1.5 text-sm">
        <h2 className="text-muted-foreground">{gt("Architect & workers")}</h2>
        <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">
          {active ? teamLabel(teamDisplayName(active, m)) : gt("No team")}
        </span>
      </div>
    </div>
  );
  const autoKind = active ? autoTeamKind(active.id) : null;
  if (autoKind !== null) {
    return (
      <>
        {header}
        <div
          data-composer-team-setup
          role="group"
          aria-label={gt("Architect & workers")}
          className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain px-3 pt-2.5 pb-3"
        >
          <section className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <span className="font-medium text-sm">{gt("Architect")}</span>
              <span className="text-muted-foreground text-xs">{gt("Plans & reviews")}</span>
            </div>
            <ModelField
              label={gt("Architect model")}
              value={props.autoLeads?.[autoKind] ?? null}
              entries={props.entries}
              onChange={(lead) => props.onAutoLeadChange(autoKind, lead)}
            />
            <p className="text-muted-foreground text-xs">
              {gt(
                "Threads that work as this team run on this model. With none chosen, a thread keeps its own.",
              )}
            </p>
          </section>
          <section className="grid gap-1">
            <span className="font-medium text-sm">{gt("Workers")}</span>
            <p className="grid gap-1 text-muted-foreground text-xs">
              <span>{m(AUTO_TEAM_TEXT[autoKind].description)}</span>
              <span>{gt("The team picks a worker for each task.")}</span>
            </p>
          </section>
          {props.disabledReason ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {props.disabledReason}
            </p>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <form
        data-composer-team-setup
        aria-label={gt("Architect & workers")}
        className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain px-3 pt-2.5 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <section className="grid gap-1.5">
          <span className="text-muted-foreground text-xs">{gt("Team profile")}</span>
          <div className="flex items-center gap-1.5">
            <Select
              value={profileId}
              onValueChange={(next) => {
                if (typeof next === "string") load(next);
              }}
            >
              <SelectTrigger aria-label={gt("Team profile")} className="min-w-0 flex-1">
                <SelectValue>{teamLabel(profile?.name ?? CUSTOM_TEAM_NAME)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={CUSTOM_TEAM_ID}>{gt("Custom setup")}</SelectItem>
                {named.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="button"
                    aria-label={gt("Manage team profile")}
                    disabled={!profile || profile.id === CUSTOM_TEAM_ID}
                  />
                }
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => setNaming({ kind: "rename", value: profile?.name ?? "" })}>
                  {gt("Rename profile")}
                </MenuItem>
                <MenuItem variant="destructive" onClick={remove}>
                  {gt("Delete profile")}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
          {naming === null ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="justify-self-start"
              disabled={full}
              onClick={() => setNaming({ kind: "new", value: "" })}
            >
              <PlusIcon />
              {gt("Save as…")}
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                aria-label={gt("Profile name")}
                placeholder={gt("Profile name")}
                maxLength={64}
                value={naming.value}
                onChange={(event) => setNaming({ ...naming, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submitName();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setNaming(null);
                  }
                }}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(null)}>
                {gt("Cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!naming.value.trim() || (naming.kind === "new" && problem !== null)}
                onClick={submitName}
              >
                {naming.kind === "rename" ? gt("Rename") : gt("Save profile")}
              </Button>
            </div>
          )}
        </section>

        <section className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-sm">{gt("Architect")}</span>
            <span className="text-muted-foreground text-xs">{gt("Plans & reviews")}</span>
          </div>
          <ModelField
            label={gt("Architect model")}
            value={setup.architect}
            entries={props.entries}
            onChange={(architect) =>
              setSetup((current) => ({
                ...current,
                architect,
                // The role was the earlier model's; a new effort keeps it.
                architectRole:
                  current.architect && keyOf(current.architect) === keyOf(architect)
                    ? current.architectRole
                    : EMPTY_TEAM_ROLE,
              }))
            }
          />
          {rolesSupported && profile && agentTeamRole(profile, 0) ? (
            <>
              <AgentTeamRoleName
                label={gt("Architect")}
                placeholder={gt("Name as a worker, when another model leads")}
                role={setup.architectRole}
                onChange={(architectRole) => setSetup((current) => ({ ...current, architectRole }))}
              />
              <AgentTeamRoleDetails
                label={gt("Architect")}
                role={setup.architectRole}
                onChange={(architectRole) => setSetup((current) => ({ ...current, architectRole }))}
              >
                {handsTo(gt("Architect"), { key: ARCHITECT_KEY, role: setup.architectRole })}
              </AgentTeamRoleDetails>
            </>
          ) : null}
          <div className="flex items-center gap-1.5">
            <label htmlFor={guidanceId} className="text-muted-foreground text-xs">
              {gt("Lead guidance")}
            </label>
            <InfoMark
              label={gt("About lead guidance")}
              text={gt(
                "Extra instructions for the architect only, sent with the built-in team rules. They replace the default lead guidance in Settings → Providers → Agent teams; leave it empty to use that.",
              )}
            />
          </div>
          <Textarea
            id={guidanceId}
            rows={3}
            maxLength={AGENT_TEAM_LEAD_GUIDANCE_MAX_LENGTH}
            placeholder={
              props.sharedGuidance.trim() ||
              gt("Extra instructions for the lead, on top of the built-in team rules.")
            }
            value={setup.guidance}
            onChange={(event) =>
              setSetup((current) => ({ ...current, guidance: event.target.value }))
            }
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={setup.guidance === ""}
            onClick={() => setSetup((current) => ({ ...current, guidance: "" }))}
          >
            {gt("Reset to default")}
          </Button>
        </section>

        <section className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">{gt("Workers")}</span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label={gt("Add worker")}
              disabled={setup.workers.length + 1 >= MAX_ROUTING_GROUP_MEMBERS}
              onClick={() =>
                setSetup((current) => ({ ...current, workers: [...current.workers, newWorker()] }))
              }
            >
              <PlusIcon />
              {gt("Add")}
            </Button>
          </div>
          {setup.workers.map((worker, index) => (
            <div key={worker.key} className="grid gap-1">
              <div className="flex items-center justify-between gap-1.5 text-sm">
                <span className="text-muted-foreground tabular-nums">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  {rolesSupported ? (
                    <AgentTeamRoleName
                      label={gt("Worker {number}", { number: index + 1 })}
                      role={worker.role}
                      onChange={(role) => setWorker(index, { role })}
                    />
                  ) : (
                    gt("Worker {number}", { number: index + 1 })
                  )}
                </div>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={gt("Remove worker {number}", { number: index + 1 })}
                  onClick={() =>
                    setSetup((current) => ({
                      ...current,
                      workers: current.workers.filter((_, at) => at !== index),
                    }))
                  }
                >
                  <XIcon />
                </Button>
              </div>
              <ModelField
                label={gt("Worker {number} model", { number: index + 1 })}
                value={worker.selection}
                entries={props.entries}
                onChange={(selection) => setWorker(index, { selection })}
              />
              {rolesSupported ? (
                <AgentTeamRoleDetails
                  label={gt("Worker {number}", { number: index + 1 })}
                  role={worker.role}
                  onChange={(role) => setWorker(index, { role })}
                >
                  {handsTo(gt("Worker {number}", { number: index + 1 }), worker)}
                </AgentTeamRoleDetails>
              ) : null}
            </div>
          ))}
        </section>

        {rolesSupported ? (
          <section className="grid gap-1.5">
            <div className="flex items-center gap-1.5">
              <label htmlFor={`${guidanceId}-team`} className="font-medium text-sm">
                {gt("Team guidance, for everyone")}
              </label>
              <InfoMark
                label={gt("About team guidance")}
                text={gt(
                  "Rules for everyone: the architect gets them each turn, and every worker with each task.",
                )}
              />
            </div>
            <Textarea
              id={`${guidanceId}-team`}
              rows={2}
              maxLength={AGENT_TEAM_INSTRUCTIONS_MAX_LENGTH}
              placeholder={gt("Never push to main. Run the tests before you finish.")}
              value={setup.sharedGuidance}
              onChange={(event) =>
                setSetup((current) => ({ ...current, sharedGuidance: event.target.value }))
              }
            />
          </section>
        ) : null}

        <section className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <label htmlFor={parallelId} className="text-sm">
              {gt("At once")}
            </label>
            <InfoMark
              label={gt("How parallel workers run")}
              text={gt(
                "Most tasks the architect keeps out at once. Independent work runs in parallel; a task over the limit waits for a result.",
              )}
            />
          </div>
          <div className="flex items-center gap-2">
            {setup.unlimited ? null : (
              <Input
                id={parallelId}
                type="number"
                min={1}
                max={32}
                className="w-16"
                aria-label={gt("Workers at once")}
                value={String(setup.parallel)}
                onChange={(event) =>
                  setSetup((current) => ({
                    ...current,
                    parallel: Number(event.target.value) || 1,
                  }))
                }
              />
            )}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={setup.unlimited}
                aria-label={gt("Unlimited workers")}
                onCheckedChange={(checked) =>
                  setSetup((current) => ({ ...current, unlimited: checked === true }))
                }
              />
              {gt("Unlimited")}
            </label>
          </div>
        </section>

        <p className="grid gap-1 text-muted-foreground text-xs">
          <span>{gt("Workers run as delegated tasks in this thread's checkout.")}</span>
          <span>
            {gt("They keep this thread's permissions; their results come back to the architect.")}
          </span>
        </p>

        {saveProblem !== null || props.disabledReason ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {props.disabledReason ?? saveProblem}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-muted-foreground text-xs">
            {props.newThread
              ? gt("Starts this thread as a team")
              : gt("Applies from your next message")}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={saveProblem !== null || Boolean(props.disabledReason)}
          >
            {active ? gt("Apply setup") : gt("Save setup")}
          </Button>
        </div>
      </form>
    </>
  );
});
