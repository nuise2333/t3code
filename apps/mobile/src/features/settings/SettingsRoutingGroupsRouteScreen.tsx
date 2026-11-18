import {
  AuthSettingsWriteScope,
  MAX_ROUTING_GROUP_MEMBERS,
  MAX_ROUTING_GROUPS,
  type ModelSelection,
  type RoutingGroup,
  type RoutingTaskClass,
  type ServerConfig,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  moveListItem,
  newRoutingGroupId,
  plainRoutingGroups,
  ROUTING_TASK_CLASS_LABELS,
  ROUTING_TASK_CLASSES,
  routingGroupProblems,
  routingMemberLabel,
  rulesUsingRoutingGroup,
  withRoutingGroupRule,
} from "@t3tools/client-runtime/routing";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { MenuAction } from "@react-native-menu/menu";
import { useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  routingGroupEditorAtom,
  startRoutingGroupEditor,
  updateRoutingGroupEditor,
} from "./routing-group-editor-state";
import { type SettingsTarget, useSettingsEnvironmentFilter } from "./settings-environment-filter";

const NO_GROUP = "__none__";
const RANK_LABELS = { order: "In order", quota: "Most quota left" } as const;

function useRoutingSettingsWriter() {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "routing groups update",
    reportFailure: true,
  });
  return (environmentId: SettingsTarget["environmentId"], patch: ServerSettingsPatch) =>
    updateSettings({ environmentId, input: { patch } });
}

function seedMember(config: ServerConfig): ModelSelection | null {
  return buildModelOptions(config, null, undefined, null)[0]?.selection ?? null;
}

/** A row that opens a native menu of its actions when tapped. */
function MenuRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly actions: MenuAction[];
  readonly disabled?: boolean;
  readonly onAction: (id: string) => void;
}) {
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[props.label, props.description, props.detail]
          .filter(Boolean)
          .join(", ")}
        disabled={props.disabled}
        className="bg-grouped-card"
      >
        <ListRowLayout
          label={props.label}
          {...(props.description ? { description: props.description } : {})}
          {...(props.detail ? { detail: props.detail } : {})}
          disabled={props.disabled}
        />
      </RowPressable>
    </Menu>
  );
}

/** Each machine's routing groups and Auto rules; groups belong to the machine that runs them. */
export function SettingsRoutingGroupsRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const supported = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.routingGroups === true,
  );
  const writable = useEnvironmentsWithScope(supported, AuthSettingsWriteScope);
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="Routing groups" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm text-foreground-muted">
          A group is an ordered list of models. Pick it in a new thread's model picker, and the
          thread starts on the first model that can run it: set up, with usage left, and able to use
          the thread's permissions and plan mode. A group set to start on the most quota left picks
          by usage instead. It decides once, when the thread starts.
        </Text>
        {supported.length === 0 ? (
          <Text className="px-2 text-foreground-muted">
            Connect an environment that supports routing groups.
          </Text>
        ) : (
          supported.map((target) => (
            <EnvironmentRoutingGroups
              key={target.environmentId}
              target={target}
              canWrite={writable.has(target.environmentId)}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentRoutingGroups(props: {
  readonly target: SettingsTarget;
  readonly canWrite: boolean;
}) {
  const navigation = useNavigation();
  const write = useRoutingSettingsWriter();
  const config = useEnvironmentServerConfig(props.target.environmentId);
  if (!config) return null;
  const { target, canWrite } = props;
  const settings = config.settings;
  const providers = config.providers;
  // Agent teams are edited in web and desktop Settings; this list keeps them as they are.
  const groups = plainRoutingGroups(settings.routingGroups);
  const teams = settings.routingGroups.filter((group) => group.team === true);
  const rules = settings.routingGroupRules;
  const problems = routingGroupProblems({ groups, rules, providers });
  const seed = seedMember(config);
  const saveGroups = (next: ReadonlyArray<RoutingGroup>) =>
    void write(target.environmentId, { routingGroups: [...next, ...teams] });
  const setRule = (taskClass: RoutingTaskClass, groupId: string | null) =>
    void write(target.environmentId, {
      routingGroupRules: withRoutingGroupRule(rules, taskClass, groupId),
    });

  const addGroup = () => {
    if (!seed) return;
    Dialog.prompt({
      title: "New routing group",
      placeholder: "Fast",
      initialValue: "",
      confirmText: "Next",
      onConfirm: (value) => {
        const name = value.trim().slice(0, 64);
        if (!name) return;
        startRoutingGroupEditor({
          environmentId: target.environmentId,
          index: null,
          memberIndex: 0,
          group: {
            id: newRoutingGroupId(name, [
              ...settings.routingGroups.map((group) => group.id),
              ...Object.values(rules),
            ]),
            name,
            strategy: "order",
            members: [seed],
          },
        });
        navigation.navigate("SettingsRoutingGroupEdit");
      },
    });
  };

  const deleteGroup = (group: RoutingGroup) => {
    const usedBy = rulesUsingRoutingGroup(rules, group.id).length;
    Dialog.confirm({
      title: `Delete ${group.name}?`,
      message: `Threads that already started through it keep their model.${
        usedBy > 0
          ? ` ${usedBy === 1 ? "One Auto rule uses" : `${usedBy} Auto rules use`} it; those launches fail until you change the rule.`
          : ""
      }`,
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => saveGroups(groups.filter((entry) => entry.id !== group.id)),
    });
  };

  return (
    <View className="gap-6">
      <SettingsSection title={target.label}>
        {groups.map((group, index) => {
          const missing = problems.missingMembers.get(group.id);
          return (
            <MenuRow
              key={group.id}
              label={group.name}
              description={group.members
                .map((member, memberIndex) =>
                  missing?.includes(memberIndex)
                    ? `${member.model} (provider removed)`
                    : routingMemberLabel(member, providers),
                )
                .join(" → ")}
              disabled={!canWrite}
              actions={[
                { id: "edit", title: "Edit" },
                { id: "up", title: "Move up", attributes: { disabled: index === 0 } },
                {
                  id: "down",
                  title: "Move down",
                  attributes: { disabled: index === groups.length - 1 },
                },
                { id: "delete", title: "Delete", attributes: { destructive: true } },
              ]}
              onAction={(action) => {
                if (action === "edit") {
                  startRoutingGroupEditor({
                    environmentId: target.environmentId,
                    index,
                    memberIndex: 0,
                    group,
                  });
                  navigation.navigate("SettingsRoutingGroupEdit");
                } else if (action === "up") saveGroups(moveListItem(groups, index, -1));
                else if (action === "down") saveGroups(moveListItem(groups, index, 1));
                else if (action === "delete") deleteGroup(group);
              }}
            />
          );
        })}
        {canWrite && seed && groups.length < MAX_ROUTING_GROUPS ? (
          <ListActionRow icon="plus" label="Add group" onPress={addGroup} />
        ) : null}
      </SettingsSection>
      {groups.length > 0 || problems.missingRuleGroups.length > 0 ? (
        <SettingsSection
          title="Auto rules"
          footer="When a new thread asks for Auto effort and its first message is this kind of task, it starts through the chosen group. A rule naming a deleted group makes those launches fail until you change it."
        >
          {ROUTING_TASK_CLASSES.map((taskClass) => {
            const groupId = rules[taskClass] ?? null;
            const missing = problems.missingRuleGroups.includes(taskClass);
            return (
              <MenuRow
                key={taskClass}
                label={ROUTING_TASK_CLASS_LABELS[taskClass]}
                detail={
                  groupId === null
                    ? "Auto effort only"
                    : missing
                      ? "Missing group"
                      : (groups.find((group) => group.id === groupId)?.name ?? groupId)
                }
                disabled={!canWrite}
                actions={[
                  {
                    id: NO_GROUP,
                    title: missing ? "Clear" : "Auto effort only",
                    ...(groupId === null ? { state: "on" as const } : {}),
                  },
                  ...groups.map((group) => ({
                    id: group.id,
                    title: group.name,
                    ...(group.id === groupId ? { state: "on" as const } : {}),
                  })),
                ]}
                onAction={(id) => setRule(taskClass, id === NO_GROUP ? null : id)}
              />
            );
          })}
        </SettingsSection>
      ) : null}
    </View>
  );
}

export function SettingsRoutingGroupEditRouteScreen() {
  const navigation = useNavigation();
  const editor = useAtomValue(routingGroupEditorAtom);
  const config = useEnvironmentServerConfig(editor?.environmentId ?? null);
  const write = useRoutingSettingsWriter();
  const insets = useSafeAreaInsets();
  if (!editor || !config) {
    return (
      <SettingsScreen title="Routing group">
        <Text className="p-5 text-base text-foreground-muted">Open a routing group first.</Text>
      </SettingsScreen>
    );
  }
  const { group } = editor;
  const providers = config.providers;
  const groups = config.settings.routingGroups;
  const seed = seedMember(config);
  // An older server strips `rank`, so it gets neither the choice nor the key.
  const quotaSupported = config.environment.capabilities.routingGroupQuota === true;
  const rank = group.rank ?? "order";
  const setMembers = (members: ReadonlyArray<ModelSelection>) =>
    updateRoutingGroupEditor((current) => ({ ...current, group: { ...current.group, members } }));
  const save = async () => {
    const saved: RoutingGroup = quotaSupported ? { ...group, rank } : group;
    const next = groups.some((entry) => entry.id === group.id)
      ? groups.map((entry) => (entry.id === group.id ? saved : entry))
      : [...groups, saved];
    const result = await write(editor.environmentId, { routingGroups: next });
    if (result._tag === "Success") navigation.goBack();
  };

  return (
    <SettingsScreen title={editor.index === null ? "New routing group" : "Edit routing group"}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Name">
          <ListActionRow
            label={group.name}
            description="Rename"
            onPress={() =>
              Dialog.prompt({
                title: "Rename group",
                initialValue: group.name,
                confirmText: "Rename",
                onConfirm: (value) => {
                  const name = value.trim().slice(0, 64);
                  if (name)
                    updateRoutingGroupEditor((current) => ({
                      ...current,
                      group: { ...current.group, name },
                    }));
                },
              })
            }
          />
        </SettingsSection>
        {quotaSupported ? (
          <SettingsSection
            title="Start on"
            footer={
              rank === "quota"
                ? "The model whose subscription has the most usage left to spend per hour before it resets."
                : "The first model that can run the thread, top to bottom."
            }
          >
            <MenuRow
              label={RANK_LABELS[rank]}
              actions={(["order", "quota"] as const).map((id) => ({
                id,
                title: RANK_LABELS[id],
                ...(id === rank ? { state: "on" as const } : {}),
              }))}
              onAction={(id) => {
                if (id === "order" || id === "quota")
                  updateRoutingGroupEditor((current) => ({
                    ...current,
                    group: { ...current.group, rank: id },
                  }));
              }}
            />
          </SettingsSection>
        ) : null}
        <SettingsSection
          title={rank === "quota" ? "Models, ties in order" : "Models, in order"}
          footer="Each model keeps the options you set for it here."
        >
          {group.members.map((member, index) => (
            <MenuRow
              // oxlint-disable-next-line react/no-array-index-key -- members repeat freely and move only by these actions
              key={index}
              label={`${index + 1}. ${routingMemberLabel(member, providers)}`}
              {...(providers.some((provider) => provider.instanceId === member.instanceId)
                ? {}
                : { description: "Provider removed" })}
              actions={[
                { id: "model", title: "Change model or options" },
                { id: "up", title: "Move up", attributes: { disabled: index === 0 } },
                {
                  id: "down",
                  title: "Move down",
                  attributes: { disabled: index === group.members.length - 1 },
                },
                {
                  id: "remove",
                  title: "Remove",
                  attributes: { destructive: true, disabled: group.members.length === 1 },
                },
              ]}
              onAction={(action) => {
                if (action === "model") {
                  updateRoutingGroupEditor((current) => ({ ...current, memberIndex: index }));
                  navigation.navigate("SettingsRoutingGroupMember");
                } else if (action === "up") setMembers(moveListItem(group.members, index, -1));
                else if (action === "down") setMembers(moveListItem(group.members, index, 1));
                else if (action === "remove")
                  setMembers(group.members.filter((_, at) => at !== index));
              }}
            />
          ))}
          {seed && group.members.length < MAX_ROUTING_GROUP_MEMBERS ? (
            <ListActionRow
              icon="plus"
              label="Add model"
              onPress={() => setMembers([...group.members, seed])}
            />
          ) : null}
        </SettingsSection>
        <SettingsSection>
          <ListActionRow label="Save" onPress={() => void save()} />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function SettingsRoutingGroupMemberRouteScreen() {
  const navigation = useNavigation();
  const editor = useAtomValue(routingGroupEditorAtom);
  const config = useEnvironmentServerConfig(editor?.environmentId ?? null);
  const member = editor?.group.members[editor.memberIndex] ?? null;
  const models = useMemo(
    () => buildModelOptions(config, member, undefined, null),
    [config, member],
  );
  if (!editor || !member) {
    return (
      <SettingsScreen title="Model">
        <Text className="p-5 text-base text-foreground-muted">Open a routing group first.</Text>
      </SettingsScreen>
    );
  }
  const selectedOption = models.find(
    (option) =>
      option.selection.instanceId === member.instanceId && option.selection.model === member.model,
  );
  const setMember = (next: ModelSelection) =>
    updateRoutingGroupEditor((current) => ({
      ...current,
      group: {
        ...current.group,
        members: current.group.members.map((entry, index) =>
          index === current.memberIndex ? next : entry,
        ),
      },
    }));

  return (
    <ThreadSettingsPickerScreen
      environmentId={editor.environmentId}
      projectId={null}
      cwd={null}
      providerGroups={groupByProvider(models)}
      selectedModel={member}
      prompt=""
      onPromptChange={() => undefined}
      onSelectModel={(option) => setMember(option.selection)}
      optionDescriptors={resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: member.options,
      })}
      onUpdateOptionSelections={(options) => setMember({ ...member, options })}
      runtimeMode="full-access"
      onClose={() => navigation.goBack()}
    />
  );
}
