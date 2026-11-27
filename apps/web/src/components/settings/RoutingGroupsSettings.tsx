import {
  AGENT_TEAM_INSTRUCTIONS_MAX_LENGTH,
  AGENT_TEAM_LEAD_GUIDANCE_MAX_LENGTH,
  type AgentTeamRole,
  type EnvironmentId,
  MAX_ROUTING_GROUP_MEMBERS,
  MAX_ROUTING_GROUPS,
  type ModelSelection,
  type RoutingGroup,
  type RoutingTaskClass,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  moveListItem,
  newRoutingGroupId,
  ROUTING_TASK_CLASSES,
  routingGroupProblems,
  routingMemberLabel,
  rulesUsingRoutingGroup,
  withRoutingGroupRule,
} from "@t3tools/client-runtime/routing";
import {
  resolveRoutingGroupPreset,
  ROUTING_GROUP_PRESETS,
} from "@t3tools/client-runtime/routing-presets";
import { agentTeamMembersProblem, agentTeamRole } from "@t3tools/shared/agentTeam";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { msg, useGT, useMessages } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, MoreVertical, PlusIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance, selectsPlanAgent } from "../../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  AgentTeamHandsTo,
  AgentTeamRoleDetails,
  AgentTeamRoleName,
  EMPTY_TEAM_ROLE,
  namedTeamFlows,
  type TeamRowFlow,
  teamRowFlows,
  useTeamMembersProblemText,
} from "../chat/AgentTeamRoleFields";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuItemDetail, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { searchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

const NO_GROUP = "__none__";

type RoutingGroupRank = NonNullable<RoutingGroup["rank"]>;
const RANK_LABELS: Record<RoutingGroupRank, string> = {
  order: msg("In order"),
  quota: msg("Most quota left"),
};

// client-runtime's ROUTING_TASK_CLASS_LABELS, repeated so the catalog can pick them up.
const TASK_CLASS_LABELS: Record<RoutingTaskClass, string> = {
  readonly: msg("Questions"),
  quick_edit: msg("Small edits"),
  implement: msg("Implementation"),
  hard: msg("Large changes and plans"),
};

type Editing = {
  readonly index: number | null;
  readonly group: RoutingGroup;
  /** A preset's description and the members none of the providers offer. */
  readonly note?: string;
};

/**
 * Ordered model lists a new thread can launch through, and the task classes that use one when a
 * thread asks for Auto. Groups live with the environment because its provider instances do.
 *
 * Agent teams are groups with `team` set: the member a thread starts on leads and delegates to
 * the others. Each kind gets its own section; a save keeps the other kind's entries.
 */
export function RoutingGroupsSettings({
  environmentId,
  providers,
  readOnly,
  kind = "group",
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  readonly kind?: "group" | "team";
}) {
  const gt = useGT();
  const m = useMessages();
  const teams = kind === "team";
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const capabilities = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .capabilities;
  const supported =
    capabilities?.routingGroups === true && (!teams || capabilities.agentTeams === true);
  const quotaSupported = capabilities?.routingGroupQuota === true;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<RoutingGroup | null>(null);
  const guidanceEdited = useRef(false);
  // Read only while confirming, so the section holds no live subscription otherwise.
  const deletingTasks = useEnvironmentQuery(
    deleting !== null && capabilities?.scheduledTaskRoutingGroups === true
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  ).data?.tasks.filter((task) => task.routingGroupId === deleting?.id).length;
  if (!supported) return null;

  const allGroups = settings.routingGroups;
  const otherKind = allGroups.filter((group) => (group.team === true) !== teams);
  const groups = allGroups.filter((group) => (group.team === true) === teams);
  // Auto rules name plain groups only; a team is picked for a thread.
  const rules = teams ? {} : settings.routingGroupRules;
  const problems = routingGroupProblems({ groups, rules, providers });
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const firstReady = entries.find(isProviderInstancePickerReady);
  const seedMember: ModelSelection | null = firstReady
    ? createModelSelection(
        firstReady.instanceId,
        firstReady.models.find((model) => model.isDefault)?.slug ??
          firstReady.models[0]?.slug ??
          "",
      )
    : null;
  const presets = ROUTING_GROUP_PRESETS.map((preset) =>
    resolveRoutingGroupPreset(
      preset,
      entries.filter(isProviderInstancePickerReady).map((entry) => ({
        instanceId: entry.instanceId,
        driver: entry.driverKind,
        models: entry.models,
      })),
    ),
  );
  const saveGroups = (next: ReadonlyArray<RoutingGroup>) =>
    updateSettings({ routingGroups: teams ? [...otherKind, ...next] : [...next, ...otherKind] });
  const deletingRules = deleting ? rulesUsingRoutingGroup(rules, deleting.id) : [];
  // client-runtime's agentTeamSummary, in the UI language.
  const teamSummary = (group: RoutingGroup) => {
    const [lead, ...others] = group.members.map(
      (member, index) =>
        (index > 0 && agentTeamRole(group, index)?.name) || routingMemberLabel(member, providers),
    );
    if (lead === undefined) return "";
    return others.length === 0
      ? gt("{lead} leads", { lead })
      : gt("{lead} leads {members}", { lead, members: others.join(", ") });
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting(teams ? "agent-teams" : "routing-groups")}
        headerAction={
          !readOnly && seedMember && allGroups.length < MAX_ROUTING_GROUPS ? (
            <div className="flex items-center gap-2">
              {teams ? null : (
                <Menu>
                  <MenuTrigger render={<Button size="xs" variant="outline" />}>
                    {gt("Add from preset")}
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {presets.map(({ preset, group, skipped, disabledReason }) => (
                      <MenuItem
                        key={preset.id}
                        disabled={group === null}
                        title={preset.description}
                        onClick={() => {
                          if (group === null) return;
                          setEditing({
                            index: null,
                            group,
                            note:
                              skipped.length > 0
                                ? gt(
                                    "{description} Left out, as none of your ready providers offer it right now: {models}.",
                                    { description: preset.description, models: skipped.join(", ") },
                                  )
                                : preset.description,
                          });
                        }}
                      >
                        {preset.name}
                        {disabledReason ? (
                          <MenuItemDetail>{gt("No models set up")}</MenuItemDetail>
                        ) : null}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              )}
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  setEditing({
                    index: null,
                    group: {
                      id: "",
                      name: "",
                      strategy: "order",
                      members: [seedMember],
                      ...(teams ? { team: true as const } : {}),
                    },
                  })
                }
              >
                <PlusIcon className="size-3" aria-hidden />
                {teams ? gt("Add team") : gt("Add group")}
              </Button>
            </div>
          ) : null
        }
      >
        {groups.length === 0 ? (
          teams ? (
            <SettingsRow
              title={gt("No agent teams yet")}
              description={gt(
                "A lead model and the models it may hand tasks to. Pick the team in a new thread's model picker: the lead plans the work and delegates each task to a team member.",
              )}
            />
          ) : (
            <SettingsRow
              title={gt("No routing groups yet")}
              description={gt(
                "An ordered list of models. Pick it in a new thread's model picker and the thread starts on the first one that is set up, has usage left, and supports its permissions and plan mode.",
              )}
            />
          )
        ) : null}
        {groups.map((group, index) => {
          const missing = problems.missingMembers.get(group.id);
          return (
            <SettingsRow
              key={group.id}
              title={group.name}
              description={
                <span className="block truncate">
                  {teams && !missing
                    ? teamSummary(group)
                    : group.members
                        .map((member, memberIndex) =>
                          missing?.includes(memberIndex)
                            ? gt("{model} (provider removed)", { model: member.model })
                            : routingMemberLabel(member, providers),
                        )
                        .join(" → ")}
                </span>
              }
              control={
                readOnly ? null : (
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={gt("Move {name} up", { name: group.name })}
                      disabled={index === 0}
                      onClick={() => saveGroups(moveListItem(groups, index, -1))}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={gt("Move {name} down", { name: group.name })}
                      disabled={index === groups.length - 1}
                      onClick={() => saveGroups(moveListItem(groups, index, 1))}
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost-muted"
                            aria-label={gt("More actions for {name}", { name: group.name })}
                          />
                        }
                      >
                        <MoreVertical />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setEditing({ index, group })}>
                          {gt("Edit")}
                        </MenuItem>
                        <MenuItem variant="destructive" onClick={() => setDeleting(group)}>
                          {gt("Delete")}
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                )
              }
            />
          );
        })}
        {teams ? (
          <SettingsRow
            title={gt("Default lead guidance")}
            description={gt(
              "Added to the built-in team rules for the lead of every team without its own, from its next turn.",
            )}
          >
            <div className="mt-3 max-w-2xl pb-3.5">
              <Textarea
                key={settings.agentTeamLeadGuidance}
                aria-label={gt("Lead guidance")}
                rows={3}
                maxLength={AGENT_TEAM_LEAD_GUIDANCE_MAX_LENGTH}
                disabled={readOnly}
                defaultValue={settings.agentTeamLeadGuidance}
                placeholder={gt(
                  "Leave empty for the built-in rules. For example: you only lead; never edit files yourself.",
                )}
                onChange={() => {
                  guidanceEdited.current = true;
                }}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (guidanceEdited.current && value !== settings.agentTeamLeadGuidance)
                    updateSettings({ agentTeamLeadGuidance: value });
                  guidanceEdited.current = false;
                }}
              />
            </div>
          </SettingsRow>
        ) : null}
        {!teams && (groups.length > 0 || problems.missingRuleGroups.length > 0)
          ? ROUTING_TASK_CLASSES.map((taskClass) => {
              const groupId = rules[taskClass] ?? null;
              const isMissing = problems.missingRuleGroups.includes(taskClass);
              return (
                <SettingsRow
                  key={taskClass}
                  title={gt("Auto: {taskClass}", { taskClass: m(TASK_CLASS_LABELS[taskClass]) })}
                  description={
                    isMissing
                      ? gt(
                          "This group no longer exists, so a matching launch fails until you clear or change it.",
                        )
                      : taskClass === "hard" && problems.planlessHardRule
                        ? gt(
                            "Plan threads count as large changes, and no model in this group has plan mode, so a plan thread sent here fails to start. Add a member that has it.",
                          )
                        : gt(
                            "When a new thread asks for Auto effort and its first message is this kind of task, it starts through this group.",
                          )
                  }
                  control={
                    <div className="flex items-center gap-2">
                      <Select
                        value={groupId ?? NO_GROUP}
                        disabled={readOnly}
                        onValueChange={(value) => {
                          if (typeof value !== "string") return;
                          updateSettings({
                            routingGroupRules: withRoutingGroupRule(
                              rules,
                              taskClass,
                              value === NO_GROUP ? null : value,
                            ),
                          });
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={gt("Group for {taskClass}", {
                            taskClass: m(TASK_CLASS_LABELS[taskClass]),
                          })}
                        >
                          <SelectValue>
                            {(value: string) =>
                              value === NO_GROUP
                                ? gt("Auto effort only")
                                : (groups.find((group) => group.id === value)?.name ??
                                  gt("Missing group"))
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value={NO_GROUP}>{gt("Auto effort only")}</SelectItem>
                          {groups.map((group) => (
                            <SelectItem key={group.id} value={group.id}>
                              {group.name}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      {isMissing && !readOnly ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            updateSettings({
                              routingGroupRules: withRoutingGroupRule(rules, taskClass, null),
                            })
                          }
                        >
                          {gt("Clear")}
                        </Button>
                      ) : null}
                    </div>
                  }
                />
              );
            })
          : null}
      </SettingsSection>
      {editing !== null ? (
        <RoutingGroupDialog
          environmentId={environmentId}
          editing={editing}
          providers={providers}
          seedMember={seedMember}
          quotaSupported={quotaSupported && !teams}
          rolesSupported={teams && capabilities.agentTeamRoles === true}
          flowsSupported={teams && capabilities.agentTeamFlows === true}
          takenIds={[
            ...allGroups.map((group) => group.id),
            ...Object.values(settings.routingGroupRules),
          ]}
          onClose={() => setEditing(null)}
          onSave={(group) => {
            saveGroups(
              groups.some((current) => current.id === group.id)
                ? groups.map((current) => (current.id === group.id ? group : current))
                : [...groups, group],
            );
            setEditing(null);
          }}
        />
      ) : null}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gt("Delete {name}?", { name: deleting?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {teams
                ? gt(
                    "Threads that already started with it keep their model and stop leading a team.",
                  )
                : gt("Threads that already started through it keep their model.")}
              {deletingRules.length > 0
                ? gt(
                    "{count, plural, =1 { One Auto rule uses it; those launches fail until you change the rule.} other { # Auto rules use it; those launches fail until you change the rule.}}",
                    { count: deletingRules.length },
                  )
                : ""}
              {deletingTasks
                ? gt(
                    "{count, plural, =1 { One scheduled task runs through it; its runs fail until you pick another model or group.} other { # scheduled tasks run through it; their runs fail until you pick another model or group.}}",
                    { count: deletingTasks },
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {gt("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) saveGroups(groups.filter((group) => group.id !== deleting.id));
                setDeleting(null);
              }}
            >
              {gt("Delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function RoutingGroupDialog({
  environmentId,
  editing,
  providers,
  seedMember,
  quotaSupported,
  rolesSupported,
  flowsSupported,
  takenIds,
  onClose,
  onSave,
}: {
  readonly environmentId: EnvironmentId;
  readonly editing: Editing;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly seedMember: ModelSelection | null;
  /** An older server strips `rank`, so it gets neither the choice nor the key. */
  readonly quotaSupported: boolean;
  /** A team on a server that keeps member roles and team guidance. */
  readonly rolesSupported: boolean;
  readonly flowsSupported: boolean;
  readonly takenIds: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onSave: (group: RoutingGroup) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const problemText = useTeamMembersProblemText();
  const settings = useEnvironmentSettings(environmentId);
  const formId = useId();
  const [name, setName] = useState(editing.group.name);
  const [entriesDraft, setMembers] = useState<
    ReadonlyArray<{
      readonly key: number;
      readonly selection: ModelSelection;
      readonly role: AgentTeamRole;
    }>
  >(() =>
    editing.group.members.map((selection, index) => ({
      key: index,
      selection,
      role: editing.group.memberRoles?.[index] ?? EMPTY_TEAM_ROLE,
    })),
  );
  const nextKey = useRef(editing.group.members.length);
  const [flows, setFlows] = useState<ReadonlyArray<TeamRowFlow>>(() =>
    teamRowFlows(editing.group, [...editing.group.members.keys()]),
  );
  const members = entriesDraft.map((entry) => entry.selection);
  const memberRoles = entriesDraft.map((entry) => entry.role);
  const [leadGuidance, setLeadGuidance] = useState(editing.group.leadGuidance ?? "");
  const [sharedGuidance, setSharedGuidance] = useState(editing.group.sharedGuidance ?? "");
  const [maxParallel, setMaxParallel] = useState(editing.group.maxParallel ?? 0);
  const [rank, setRank] = useState<RoutingGroupRank>(editing.group.rank ?? "order");
  const team = editing.group.team === true;
  const membersProblem = team
    ? problemText(agentTeamMembersProblem({ members, ...(rolesSupported ? { memberRoles } : {}) }))
    : null;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const trimmedName = name.trim();
  const canSave =
    trimmedName.length > 0 &&
    trimmedName.length <= 64 &&
    members.length > 0 &&
    membersProblem === null &&
    members.every((member) => member.model.length > 0);
  const updateMember = (index: number, selection: ModelSelection) =>
    setMembers((current) =>
      current.map((entry, at) => (at === index ? { ...entry, selection } : entry)),
    );
  const updateRole = (index: number, role: AgentTeamRole) =>
    setMembers((current) =>
      current.map((entry, at) => (at === index ? { ...entry, role } : entry)),
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {team
              ? editing.index === null
                ? gt("Add agent team")
                : gt("Edit agent team")
              : editing.index === null
                ? gt("Add routing group")
                : gt("Edit routing group")}
          </DialogTitle>
          <DialogDescription>
            {team
              ? gt(
                  "A new thread picked with this team starts on the first model that can run it. That model leads: it plans the work and delegates tasks to the team's models, each with the options set here.",
                )
              : rank === "quota"
                ? gt(
                    "A new thread picked with this group starts on the model whose subscription has the most usage left to spend per hour before it resets. It decides once, when the thread starts.",
                  )
                : gt(
                    "A new thread picked with this group starts on the first model that can run it, top to bottom. It decides once, when the thread starts.",
                  )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {editing.note ? (
            <p className="mb-4 text-muted-foreground text-sm">{editing.note}</p>
          ) : null}
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSave) return;
              onSave({
                // The id stays fixed after creation, so renaming keeps rules and drafts pointing here.
                id: editing.group.id || newRoutingGroupId(trimmedName, takenIds),
                name: trimmedName,
                strategy: "order",
                ...(quotaSupported ? { rank } : {}),
                ...(team
                  ? { team: true as const, maxParallel, leadGuidance: leadGuidance.trim() }
                  : {}),
                ...(rolesSupported ? { memberRoles, sharedGuidance: sharedGuidance.trim() } : {}),
                ...(flowsSupported ? { memberFlows: namedTeamFlows(entriesDraft, flows) } : {}),
                members,
              });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-name`}>{gt("Name")}</Label>
              <Input
                id={`${formId}-name`}
                placeholder={
                  team
                    ? gt("Reviewers", { $context: "Example name for an agent team" })
                    : gt("Fast", { $context: "Example name for a routing group" })
                }
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            {quotaSupported ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-rank`}>{gt("Start on")}</Label>
                <Select
                  value={rank}
                  onValueChange={(value) => {
                    if (value === "order" || value === "quota") setRank(value);
                  }}
                >
                  <SelectTrigger id={`${formId}-rank`} size="sm">
                    <SelectValue>{m(RANK_LABELS[rank])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="order">{m(RANK_LABELS.order)}</SelectItem>
                    <SelectItem value="quota">{m(RANK_LABELS.quota)}</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label>
                {team
                  ? gt("Models; the first leads, the next leads if it can't run")
                  : rank === "quota"
                    ? gt("Models, ties in order")
                    : gt("Models, in order")}
              </Label>
              {entriesDraft.map(({ key, selection: member, role }, index) => {
                const entry = entries.find(
                  (candidate) => candidate.instanceId === member.instanceId,
                );
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2">
                    <span
                      className={`${team ? "w-9" : "w-5"} text-muted-foreground text-xs tabular-nums`}
                    >
                      {team && index === 0 ? gt("Lead") : `${index + 1}.`}
                    </span>
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={member.instanceId}
                      model={member.model}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={getCustomModelOptionsByInstance(
                        settings,
                        providers,
                        member.instanceId,
                        member.model,
                      )}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel={gt("Model {number}", { number: index + 1 })}
                      onInstanceModelChange={(instanceId, model) =>
                        updateMember(index, pickModelSelection(member, instanceId, model))
                      }
                    />
                    {entry ? (
                      <TraitsPicker
                        provider={entry.driverKind}
                        models={entry.models}
                        model={member.model}
                        modelOptions={member.options ?? []}
                        allowPromptInjectedEffort={false}
                        includePlanAgent={selectsPlanAgent(member.options)}
                        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                        onModelOptionsChange={(options) =>
                          updateMember(
                            index,
                            createModelSelection(member.instanceId, member.model, options),
                          )
                        }
                      />
                    ) : (
                      <span className="text-destructive text-xs">{gt("Provider removed")}</span>
                    )}
                    <div className="ms-auto flex items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={gt("Move model {number} up", { number: index + 1 })}
                        disabled={index === 0}
                        onClick={() => setMembers((current) => moveListItem(current, index, -1))}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={gt("Move model {number} down", { number: index + 1 })}
                        disabled={index === members.length - 1}
                        onClick={() => setMembers((current) => moveListItem(current, index, 1))}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-destructive"
                        aria-label={gt("Remove model {number}", { number: index + 1 })}
                        disabled={members.length === 1}
                        onClick={() =>
                          setMembers((current) => current.filter((_, at) => at !== index))
                        }
                      >
                        <XIcon />
                      </Button>
                    </div>
                    {rolesSupported ? (
                      <div className="grid w-full gap-1 ps-11">
                        <AgentTeamRoleName
                          label={gt("Member {number}", { number: index + 1 })}
                          placeholder={
                            index === 0
                              ? gt("Name as a worker, when another model leads")
                              : undefined
                          }
                          role={role}
                          onChange={(next) => updateRole(index, next)}
                        />
                        <AgentTeamRoleDetails
                          label={gt("Member {number}", { number: index + 1 })}
                          role={role}
                          onChange={(next) => updateRole(index, next)}
                        >
                          {flowsSupported ? (
                            <AgentTeamHandsTo
                              label={gt("Member {number}", { number: index + 1 })}
                              row={{ key, role }}
                              rows={entriesDraft}
                              flows={flows}
                              onChange={setFlows}
                            />
                          ) : null}
                        </AgentTeamRoleDetails>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {seedMember && members.length < MAX_ROUTING_GROUP_MEMBERS ? (
                <div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      setMembers((current) => [
                        ...current,
                        {
                          key: nextKey.current++,
                          selection: seedMember,
                          role: EMPTY_TEAM_ROLE,
                        },
                      ])
                    }
                  >
                    <PlusIcon className="size-3" aria-hidden />
                    {gt("Add model")}
                  </Button>
                </div>
              ) : null}
              {membersProblem ? (
                <p role="alert" className="text-destructive-foreground text-xs">
                  {membersProblem}
                </p>
              ) : null}
            </div>
            {rolesSupported ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-shared`}>{gt("Team guidance, for everyone")}</Label>
                <Textarea
                  id={`${formId}-shared`}
                  rows={2}
                  maxLength={AGENT_TEAM_INSTRUCTIONS_MAX_LENGTH}
                  placeholder={gt("Never push to main. Run the tests before you finish.")}
                  value={sharedGuidance}
                  onChange={(event) => setSharedGuidance(event.target.value)}
                />
              </div>
            ) : null}
            {team ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${formId}-lead`}>{gt("Lead guidance, for the lead only")}</Label>
                  <Textarea
                    id={`${formId}-lead`}
                    rows={3}
                    maxLength={AGENT_TEAM_LEAD_GUIDANCE_MAX_LENGTH}
                    placeholder={gt(
                      "Replaces the default lead guidance for this team. Leave empty to use that.",
                    )}
                    value={leadGuidance}
                    onChange={(event) => setLeadGuidance(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={`${formId}-parallel`}>{gt("Tasks at once")}</Label>
                  <div className="w-28">
                    <Input
                      id={`${formId}-parallel`}
                      type="number"
                      min={1}
                      max={32}
                      placeholder={gt("Unlimited")}
                      value={maxParallel === 0 ? "" : String(maxParallel)}
                      onChange={(event) =>
                        setMaxParallel(
                          Math.max(0, Math.min(32, Math.round(Number(event.target.value) || 0))),
                        )
                      }
                    />
                  </div>
                </div>
              </>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            {gt("Cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={!canSave}>
            {gt("Save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
