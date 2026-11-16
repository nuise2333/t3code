import {
  type EnvironmentId,
  MAX_ROUTING_GROUP_MEMBERS,
  MAX_ROUTING_GROUPS,
  type ModelSelection,
  type RoutingGroup,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  moveListItem,
  newRoutingGroupId,
  ROUTING_TASK_CLASS_LABELS,
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
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { ArrowDownIcon, ArrowUpIcon, MoreVertical, PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance, selectsPlanAgent } from "../../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
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
import { searchableSetting } from "./settingsSearch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

const NO_GROUP = "__none__";

type RoutingGroupRank = NonNullable<RoutingGroup["rank"]>;
const RANK_LABELS: Record<RoutingGroupRank, string> = {
  order: "In order",
  quota: "Most quota left",
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
 */
export function RoutingGroupsSettings({
  environmentId,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const capabilities = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .capabilities;
  const supported = capabilities?.routingGroups === true;
  const quotaSupported = capabilities?.routingGroupQuota === true;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<RoutingGroup | null>(null);
  if (!supported) return null;

  const groups = settings.routingGroups;
  const rules = settings.routingGroupRules;
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
  const saveGroups = (next: ReadonlyArray<RoutingGroup>) => updateSettings({ routingGroups: next });
  const deletingRules = deleting ? rulesUsingRoutingGroup(rules, deleting.id) : [];

  return (
    <>
      <SettingsSection
        {...searchableSetting("routing-groups")}
        headerAction={
          !readOnly && seedMember && groups.length < MAX_ROUTING_GROUPS ? (
            <div className="flex items-center gap-2">
              <Menu>
                <MenuTrigger render={<Button size="xs" variant="outline" />}>
                  Add from preset
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
                              ? `${preset.description} Left out, as none of your ready providers offer it right now: ${skipped.join(", ")}.`
                              : preset.description,
                        });
                      }}
                    >
                      {preset.name}
                      {disabledReason ? <MenuItemDetail>No models set up</MenuItemDetail> : null}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  setEditing({
                    index: null,
                    group: { id: "", name: "", strategy: "order", members: [seedMember] },
                  })
                }
              >
                <PlusIcon className="size-3" aria-hidden />
                Add group
              </Button>
            </div>
          ) : null
        }
      >
        {groups.length === 0 ? (
          <SettingsRow
            title="No routing groups yet"
            description="An ordered list of models. Pick it in a new thread's model picker and the thread starts on the first one that is set up, has usage left, and supports its permissions and plan mode."
          />
        ) : null}
        {groups.map((group, index) => {
          const missing = problems.missingMembers.get(group.id);
          return (
            <SettingsRow
              key={group.id}
              title={group.name}
              description={
                <span className="block truncate">
                  {group.members
                    .map((member, memberIndex) =>
                      missing?.includes(memberIndex)
                        ? `${member.model} (provider removed)`
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
                      aria-label={`Move ${group.name} up`}
                      disabled={index === 0}
                      onClick={() => saveGroups(moveListItem(groups, index, -1))}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={`Move ${group.name} down`}
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
                            aria-label={`More actions for ${group.name}`}
                          />
                        }
                      >
                        <MoreVertical />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => setEditing({ index, group })}>Edit</MenuItem>
                        <MenuItem variant="destructive" onClick={() => setDeleting(group)}>
                          Delete
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                )
              }
            />
          );
        })}
        {groups.length > 0 || problems.missingRuleGroups.length > 0
          ? ROUTING_TASK_CLASSES.map((taskClass) => {
              const groupId = rules[taskClass] ?? null;
              const isMissing = problems.missingRuleGroups.includes(taskClass);
              return (
                <SettingsRow
                  key={taskClass}
                  title={`Auto: ${ROUTING_TASK_CLASS_LABELS[taskClass]}`}
                  description={
                    isMissing
                      ? "This group no longer exists, so a matching launch fails until you clear or change it."
                      : "When a new thread asks for Auto effort and its first message is this kind of task, it starts through this group."
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
                          aria-label={`Group for ${ROUTING_TASK_CLASS_LABELS[taskClass]}`}
                        >
                          <SelectValue>
                            {(value: string) =>
                              value === NO_GROUP
                                ? "Auto effort only"
                                : (groups.find((group) => group.id === value)?.name ??
                                  "Missing group")
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value={NO_GROUP}>Auto effort only</SelectItem>
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
                          Clear
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
          quotaSupported={quotaSupported}
          takenIds={[...groups.map((group) => group.id), ...Object.values(rules)]}
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
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Threads that already started through it keep their model.
              {deletingRules.length > 0
                ? ` ${deletingRules.length === 1 ? "One Auto rule uses" : `${deletingRules.length} Auto rules use`} it; those launches fail until you change the rule.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) saveGroups(groups.filter((group) => group.id !== deleting.id));
                setDeleting(null);
              }}
            >
              Delete
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
  readonly takenIds: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onSave: (group: RoutingGroup) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const formId = useId();
  const [name, setName] = useState(editing.group.name);
  const [members, setMembers] = useState<ReadonlyArray<ModelSelection>>(editing.group.members);
  const [rank, setRank] = useState<RoutingGroupRank>(editing.group.rank ?? "order");
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const trimmedName = name.trim();
  const canSave =
    trimmedName.length > 0 &&
    trimmedName.length <= 64 &&
    members.length > 0 &&
    members.every((member) => member.model.length > 0);
  const updateMember = (index: number, member: ModelSelection) =>
    setMembers((current) => current.map((entry, at) => (at === index ? member : entry)));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing.index === null ? "Add routing group" : "Edit routing group"}
          </DialogTitle>
          <DialogDescription>
            {rank === "quota"
              ? "A new thread picked with this group starts on the model whose subscription has the most usage left to spend per hour before it resets. It decides once, when the thread starts."
              : "A new thread picked with this group starts on the first model that can run it, top to bottom. It decides once, when the thread starts."}
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
                members,
              });
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-name`}>Name</Label>
              <Input
                id={`${formId}-name`}
                placeholder="Fast"
                maxLength={64}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            {quotaSupported ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`${formId}-rank`}>Start on</Label>
                <Select
                  value={rank}
                  onValueChange={(value) => {
                    if (value === "order" || value === "quota") setRank(value);
                  }}
                >
                  <SelectTrigger id={`${formId}-rank`} size="sm">
                    <SelectValue>{RANK_LABELS[rank]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="order">{RANK_LABELS.order}</SelectItem>
                    <SelectItem value="quota">{RANK_LABELS.quota}</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label>{rank === "quota" ? "Models, ties in order" : "Models, in order"}</Label>
              {members.map((member, index) => {
                const entry = entries.find(
                  (candidate) => candidate.instanceId === member.instanceId,
                );
                return (
                  <div
                    // oxlint-disable-next-line react/no-array-index-key -- members repeat freely and only move by these buttons
                    key={index}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="w-5 text-muted-foreground text-xs tabular-nums">
                      {index + 1}.
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
                      triggerAriaLabel={`Model ${index + 1}`}
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
                      <span className="text-destructive text-xs">Provider removed</span>
                    )}
                    <div className="ms-auto flex items-center gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Move model ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() => setMembers((current) => moveListItem(current, index, -1))}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Move model ${index + 1} down`}
                        disabled={index === members.length - 1}
                        onClick={() => setMembers((current) => moveListItem(current, index, 1))}
                      >
                        <ArrowDownIcon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-destructive"
                        aria-label={`Remove model ${index + 1}`}
                        disabled={members.length === 1}
                        onClick={() =>
                          setMembers((current) => current.filter((_, at) => at !== index))
                        }
                      >
                        <XIcon />
                      </Button>
                    </div>
                  </div>
                );
              })}
              {seedMember && members.length < MAX_ROUTING_GROUP_MEMBERS ? (
                <div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setMembers((current) => [...current, seedMember])}
                  >
                    <PlusIcon className="size-3" aria-hidden />
                    Add model
                  </Button>
                </div>
              ) : null}
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
