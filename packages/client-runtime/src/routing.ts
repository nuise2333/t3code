import {
  type AutoRoutingSettings,
  isProviderAvailable,
  type LaunchRoutingRequest,
  type MessageId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type RouteDecision,
  type ThreadAgentTeam,
  type ThreadId,
  type RoutingGroup,
  type RoutingGroupRules,
  type RoutingReason,
  type RoutingSkipReason,
  type RoutingTaskClass,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { isClaudeUltrathinkPrompt, isReasoningSelect } from "@t3tools/shared/model";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  effortSetOutsidePicker,
  type HigherEffort,
  nextHigherEffort,
} from "@t3tools/shared/routing";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";

type ReasonCode = RoutingReason | NonNullable<NonNullable<RouteDecision["model"]>["kept"]>;

const REASON_LABELS: Partial<Record<ReasonCode, string>> = {
  plan_mode: "Plan mode",
  many_paths: "Mentions 3+ files",
  hard_keyword: "Large change",
  debug_keyword: "Debugging",
  question: "Question, no edits",
  quick_keyword: "Small edit",
  default_class: "No clear signal",
  model_row: "Tuned for this model",
  nearest_level: "Closest level this model offers",
  security_prompt: "Security prompt, model kept",
};

const AUTO_REQUEST: LaunchRoutingRequest = { mode: "auto" };
const AUTO_MODEL_REQUEST: LaunchRoutingRequest = { mode: "auto", model: "auto" };

/** Auto effort needs a server that honors the request and the server's setting turned on. */
export function autoEffortOffered(input: {
  readonly capability: boolean | undefined;
  readonly settingEnabled: boolean | undefined;
}): boolean {
  return input.capability === true && input.settingEnabled === true;
}

const ROUTED_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/**
 * Whether Auto can set this model's reasoning control. The server leaves any other control, and a
 * level Ultrathink or Ultracode already set, unchanged.
 */
export function autoEffortSupported(input: {
  readonly driver: string | undefined;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly ultrathinkPrompt: boolean;
}): boolean {
  const descriptor = input.descriptors?.find(isReasoningSelect);
  if (input.driver === "acpRegistry" || descriptor === undefined) return false;
  if (effortSetOutsidePicker(input)) return false;
  return descriptor.options.some(
    (option) =>
      ROUTED_LEVELS.has(option.id) && !descriptor.promptInjectedValues?.includes(option.id),
  );
}

/**
 * A draft that picked a routing group asks for that group; otherwise it is Auto until its user
 * picks a level. Multi-model sends keep their own selections.
 */
export function launchRoutingRequest(input: {
  readonly offered: boolean;
  readonly effortManual: boolean;
  readonly multiModel: boolean;
  /** The draft's user picked its model, so Auto keeps it. */
  readonly modelExplicit: boolean;
  readonly routingGroupId?: string | null | undefined;
}): LaunchRoutingRequest | undefined {
  if (input.multiModel) return undefined;
  if (input.routingGroupId) return { mode: "group", groupId: input.routingGroupId };
  if (!input.offered || input.effortManual) return undefined;
  return input.modelExplicit ? AUTO_REQUEST : AUTO_MODEL_REQUEST;
}

const AUTO_EFFORT_NOTE = "Picks a level up to High from your first message.";

/** The Auto option's help text, naming the switches its server will honor. */
export function autoRoutingNote(input: {
  readonly capability: boolean | undefined;
  readonly settings: Partial<AutoRoutingSettings> | undefined;
  readonly modelExplicit: boolean;
}): string {
  const model = input.capability === true && input.settings?.allowModelSwitch === true;
  const provider = input.capability === true && input.settings?.allowProviderSwitch === true;
  if (!model && !provider) return AUTO_EFFORT_NOTE;
  if (input.modelExplicit) return `${AUTO_EFFORT_NOTE} Keeps the model you picked.`;
  const change =
    model && provider
      ? "model or provider"
      : model
        ? "to a cheaper or stronger model on this provider"
        : "to a model on another of your providers";
  return `Picks a level up to High, and may switch ${change}, from your first message.`;
}

export function describeRoutingReasons(reasons: ReadonlyArray<ReasonCode>): string {
  return reasons.flatMap((reason) => REASON_LABELS[reason] ?? []).join(", ");
}

/** The decision's reasons, with the security keep that rides on `model.kept` for older clients. */
const routingReasons = (routing: RouteDecision): ReadonlyArray<ReasonCode> => {
  const kept = routing.model?.kept;
  return kept === undefined ? routing.reasons : [...routing.reasons, kept];
};

export interface RoutedEffortDisplay {
  readonly levelLabel: string;
  readonly reason: string;
  /** One line for a tooltip or a menu footer, such as "Auto picked High: Plan mode". */
  readonly summary: string;
}

/**
 * The routed level while the selection still holds it. Picking another level makes the thread
 * manual, so this turns null without any extra state.
 */
export function routedEffortDisplay(input: {
  readonly routing: RouteDecision | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly descriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
}): RoutedEffortDisplay | null {
  const { routing, selection } = input;
  if (!routing?.applied || routing.effort === null || routing.optionId === undefined) return null;
  const current = selection?.options?.find((option) => option.id === routing.optionId)?.value;
  if (current !== routing.effort) return null;
  const descriptor = input.descriptors?.find((candidate) => candidate.id === routing.optionId);
  const levelLabel =
    (descriptor?.type === "select"
      ? descriptor.options.find((option) => option.id === routing.effort)?.label
      : undefined) ?? routing.effort.charAt(0).toUpperCase() + routing.effort.slice(1);
  const reason = describeRoutingReasons(routingReasons(routing));
  return {
    levelLabel,
    reason,
    summary: reason ? `Auto picked ${levelLabel}: ${reason}` : `Auto picked ${levelLabel}`,
  };
}

type CommandTurnItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
type RetryScanTurnItem =
  | Pick<
      CommandTurnItem,
      "type" | "runId" | "nodeId" | "ordinal" | "input" | "exitCode" | "outputIndicatesFailure"
    >
  | { readonly type: Exclude<OrchestrationV2TurnItem["type"], "command_execution"> };
type RetryScanRun = Pick<
  OrchestrationV2Run,
  | "id"
  | "ordinal"
  | "status"
  | "startedAt"
  | "completedAt"
  | "rootNodeId"
  | "userMessageId"
  | "modelSelection"
>;
type RetryScanNode = Pick<OrchestrationV2ExecutionNode, "id" | "parentNodeId" | "kind">;

export interface HigherEffortRetry {
  /** The newer run, so dismissing the offer lasts until another run repeats the failure. */
  readonly key: string;
  /** The older run's message, which the retry rewinds to. */
  readonly messageId: MessageId;
  /** Null when no higher level is offered; the failure can still go to another vendor. */
  readonly effort: HigherEffort | null;
  /** The commands that failed at the end of both runs. */
  readonly commands: ReadonlyArray<string>;
}

/** The run's own work: its root and nodes below it, but nothing a subagent ran. */
function inRunOwnWork(
  nodeId: NodeId,
  rootNodeId: NodeId,
  nodesById: ReadonlyMap<NodeId, RetryScanNode>,
): boolean {
  const seen = new Set<NodeId>();
  let current: NodeId | null = nodeId;
  while (current !== null && !seen.has(current)) {
    if (current === rootNodeId) return true;
    seen.add(current);
    const node = nodesById.get(current);
    if (node === undefined || node.kind === "subagent") return false;
    current = node.parentNodeId;
  }
  return false;
}

/** Whether each command's last run in the run's own work failed, by trimmed command text. */
function lastOwnFailures(
  run: RetryScanRun,
  turnItems: ReadonlyArray<RetryScanTurnItem>,
  nodesById: ReadonlyMap<NodeId, RetryScanNode>,
): Map<string, boolean> {
  const latest = new Map<
    string,
    Pick<CommandTurnItem, "ordinal" | "exitCode" | "outputIndicatesFailure">
  >();
  const rootNodeId = run.rootNodeId;
  if (rootNodeId === null) return new Map();
  for (const item of turnItems) {
    if (item.type !== "command_execution" || item.runId !== run.id) continue;
    if (item.nodeId === null || !inRunOwnWork(item.nodeId, rootNodeId, nodesById)) continue;
    const command = item.input.trim();
    const previous = latest.get(command);
    if (command.length > 0 && (previous === undefined || item.ordinal >= previous.ordinal)) {
      latest.set(command, item);
    }
  }
  // The exit code outranks the server's output check, which covers providers that report none.
  return new Map(
    [...latest].map(([command, item]) => [
      command,
      item.exitCode === undefined ? item.outputIndicatesFailure === true : item.exitCode !== 0,
    ]),
  );
}

const sameModel = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId && left.model === right.model;

/**
 * Finds a command that failed at the end of both of the last two completed runs on the composer's
 * model, with a retry one level above its current one when there is one. Auto never acts on this.
 */
export function higherEffortRetry(input: {
  readonly runs: ReadonlyArray<RetryScanRun>;
  readonly turnItems: ReadonlyArray<RetryScanTurnItem>;
  readonly nodes: ReadonlyArray<RetryScanNode>;
  readonly messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "text">>;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
  /** What the composer would send next. */
  readonly selection: ModelSelection;
}): HigherEffortRetry | null {
  const executed = input.runs
    .filter(
      (run) => run.status !== "queued" && run.status !== "rolled_back" && run.startedAt !== null,
    )
    .sort((left, right) => (runRanAfter(left, right) ? 1 : runRanAfter(right, left) ? -1 : 0));
  const newer = executed.at(-1);
  const older = executed.at(-2);
  if (newer === undefined || older === undefined) return null;
  if (newer.status !== "completed" || older.status !== "completed") return null;
  if (
    !sameModel(newer.modelSelection, older.modelSelection) ||
    !sameModel(newer.modelSelection, input.selection)
  ) {
    return null;
  }
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const olderFailures = lastOwnFailures(older, input.turnItems, nodesById);
  const commands = [...lastOwnFailures(newer, input.turnItems, nodesById)]
    .filter(([command, failed]) => failed && olderFailures.get(command) === true)
    .map(([command]) => command);
  if (commands.length === 0) return null;
  const effort = nextHigherEffort({
    descriptors: input.descriptors,
    selection: input.selection,
    ultrathinkPrompt: input.messages.some(
      (message) =>
        (message.id === older.userMessageId || message.id === newer.userMessageId) &&
        isClaudeUltrathinkPrompt(message.text),
    ),
  });
  return { key: newer.id, messageId: older.userMessageId, effort, commands };
}

/** The new thread's draft: the user reads it over and sends it. */
export function rootCausePrompt(commands: ReadonlyArray<string>): string {
  const ticks = commands.flatMap((command) => command.match(/`+/g) ?? []);
  const fence = "`".repeat(Math.max(3, ...ticks.map((run) => run.length + 1)));
  return [
    commands.length === 1
      ? "This command failed at the end of two turns in a row in another thread:"
      : "These commands failed at the end of two turns in a row in another thread:",
    "",
    fence,
    ...commands,
    fence,
    "",
    "Find the root cause. Do not edit any files: read the code and run only commands that change nothing. Report the cause, the evidence for it, and the fix you would make.",
  ].join("\n");
}

/** The groups a new thread may pick: none from a server that cannot resolve them. */
function offeredRoutingGroups(input: {
  readonly capability: boolean | undefined;
  readonly groups: ReadonlyArray<RoutingGroup> | undefined;
}): ReadonlyArray<RoutingGroup> {
  return input.capability === true ? (input.groups ?? []) : [];
}

export const ROUTING_TASK_CLASSES: ReadonlyArray<RoutingTaskClass> = [
  "readonly",
  "quick_edit",
  "implement",
  "hard",
];

export const ROUTING_TASK_CLASS_LABELS: Record<RoutingTaskClass, string> = {
  readonly: "Questions",
  quick_edit: "Small edits",
  implement: "Implementation",
  hard: "Large changes and plans",
};

const ROUTING_SKIP_REASON_LABELS: Record<RoutingSkipReason, string> = {
  instance_missing: "provider removed",
  instance_disabled: "provider off",
  not_ready: "provider not ready",
  project_disabled: "off in this project",
  model_unavailable: "model unavailable",
  usage_exhausted: "usage limit",
  runtime_mode: "permissions unsupported",
  plan_unsupported: "no plan mode",
};

interface ModelNameSource {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly shortName?: string | undefined;
    readonly aliases?: ReadonlyArray<string> | undefined;
  }>;
  /** Whether the instance looks able to run this model now; the server decides at launch. */
  readonly runnable?: ((model: string) => boolean) | undefined;
  /** The instance and plan that pay for a run, such as "Codex · ChatGPT Plus". */
  readonly subscription?: string | undefined;
}

export function subscriptionLabel(snapshot: ServerProvider): string | undefined {
  const plan = snapshot.auth.label?.replace(/\s+subscription$/i, "");
  const parts = [snapshot.displayName, plan?.includes("@") === true ? undefined : plan].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** A provider snapshot as a group member source, with the server's cheap launch checks. */
export function routingProviderSource(snapshot: ServerProvider, now: number): ModelNameSource {
  const ready =
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.status !== "error" &&
    snapshot.status !== "disabled" &&
    snapshot.auth.status !== "unauthenticated" &&
    isProviderAvailable(snapshot);
  return {
    instanceId: snapshot.instanceId,
    models: snapshot.models,
    runnable: (model) => ready && exhaustedUsageWindow(snapshot, now, model) === undefined,
    subscription: subscriptionLabel(snapshot),
  };
}

export function routingMemberLabel(
  member: Pick<ModelSelection, "instanceId" | "model">,
  providers: ReadonlyArray<ModelNameSource>,
): string {
  const model = providers
    .find((provider) => provider.instanceId === member.instanceId)
    ?.models.find(
      (candidate) => candidate.slug === member.model || candidate.aliases?.includes(member.model),
    );
  return model?.shortName ?? model?.name ?? member.model;
}

export interface RoutedGroupDisplay {
  readonly groupName: string;
  /** The thread leads this agent team. */
  readonly team: boolean;
  /** Such as "Fast → GPT-6.1", or "Fast (by quota) → GPT-6.1". */
  readonly label: string;
  /** Such as "Skipped: Opus 5.5 (usage limit)"; null when the first member ran. */
  readonly skipped: string | null;
}

/**
 * The group a thread launched through, as recorded at launch, so later edits to the group do not
 * relabel it. Once its user picks another model the thread is an ordinary manual one. A team the
 * user turned on or off later decides the team instead.
 */
export function routedGroupDisplay(input: {
  readonly routing: RouteDecision | null | undefined;
  readonly agentTeam?: ThreadAgentTeam | null | undefined;
  readonly selection: Pick<ModelSelection, "instanceId" | "model"> | null | undefined;
  readonly providers: ReadonlyArray<ModelNameSource>;
}): RoutedGroupDisplay | null {
  if (!input.selection) return null;
  const lead = routingMemberLabel(input.selection, input.providers);
  if (input.agentTeam) {
    return {
      groupName: input.agentTeam.name,
      team: true,
      label: `${teamTitle(input.agentTeam.name)}, led by ${lead}`,
      skipped: null,
    };
  }
  const decision = input.routing?.group;
  if (!decision) return null;
  if (decision.team === true && input.agentTeam === null) return null;
  if (
    decision.member.instanceId !== input.selection.instanceId ||
    decision.member.model !== input.selection.model
  ) {
    return null;
  }
  const skipped = decision.skipped.map(
    (skip) =>
      `${routingMemberLabel(skip, input.providers)} (${ROUTING_SKIP_REASON_LABELS[skip.reason]})`,
  );
  return {
    groupName: decision.name,
    team: decision.team === true,
    label:
      decision.team === true
        ? `${teamTitle(decision.name)}, led by ${lead}`
        : `${decision.name}${decision.rank === "quota" ? " (by quota)" : ""} → ${lead}`,
    skipped: skipped.length > 0 ? `Skipped: ${skipped.join(", ")}` : null,
  };
}

/** "Team Crew", but "Balanced team" stays as it is. */
const teamTitle = (name: string) => (/\bteam$/i.test(name) ? name : `Team ${name}`);

/** A saved team the composer's Team menu offers. */
export interface TeamChoice {
  readonly id: string;
  readonly name: string;
  /** Such as "Opus 5.5 leads GPT-6.1, Gemini 4". */
  readonly summary: string;
}

/**
 * Saved teams for the Team menu of a thread that already runs: the thread's model leads, so the
 * summary names it as the lead.
 */
export function threadTeamChoices(input: {
  readonly capability: boolean | undefined;
  readonly groups: ReadonlyArray<RoutingGroup> | undefined;
  readonly lead: Pick<ModelSelection, "instanceId" | "model"> | null | undefined;
  readonly providers: ReadonlyArray<ModelNameSource>;
}): ReadonlyArray<TeamChoice> {
  if (input.capability !== true) return [];
  return (input.groups ?? [])
    .filter((group) => group.team === true && group.members.length > 0)
    .map((team) => ({
      id: team.id,
      name: team.name,
      summary: agentTeamSummary(team, input.lead ?? undefined, input.providers),
    }));
}

const EFFORT_ONLY_REASONS: ReadonlySet<ReasonCode> = new Set(["model_row", "nearest_level"]);
const ROLE_LABELS = { research: "Research", review: "Review" } as const;

/**
 * The model Auto picked at launch while the thread still uses it, or, for a shadow choice, the
 * model it would have used with switching on. Null once its user picks another model.
 */
export function routedModelDisplay(input: {
  readonly routing: RouteDecision | null | undefined;
  readonly selection: Pick<ModelSelection, "instanceId" | "model"> | null | undefined;
  readonly providers: ReadonlyArray<ModelNameSource>;
}): string | null {
  const decision = input.routing?.model;
  if (!decision || decision.switched === "none" || !input.selection) return null;
  const subscription = input.providers.find(
    (provider) => provider.instanceId === decision.instanceId,
  )?.subscription;
  const name = `${routingMemberLabel(decision, input.providers)}${subscription ? ` on ${subscription}` : ""}`;
  const reason = describeRoutingReasons(
    input.routing
      ? routingReasons(input.routing).filter((code) => !EFFORT_ONLY_REASONS.has(code))
      : [],
  );
  const why = reason ? ` (${reason})` : "";
  const picker = input.routing?.role ? ROLE_LABELS[input.routing.role] : "Auto";
  if (!decision.applied) {
    // The server lets a review change vendor only with provider switching, even on one instance.
    const toggle = input.routing?.role === "review" ? "provider" : decision.switched;
    return `With ${toggle} switching on, ${picker} would have used ${name}${why}`;
  }
  if (
    decision.instanceId !== input.selection.instanceId ||
    decision.model !== input.selection.model
  ) {
    return null;
  }
  const from = decision.from
    ? `, instead of ${routingMemberLabel(decision.from, input.providers)}`
    : "";
  return `${picker} → ${name}${why}${from}`;
}

interface RoutingGroupProblems {
  /** Task classes whose rule names a group that no longer exists. */
  readonly missingRuleGroups: ReadonlyArray<RoutingTaskClass>;
  /** Member indexes, by group id, whose provider instance no longer exists. */
  readonly missingMembers: ReadonlyMap<string, ReadonlyArray<number>>;
  /** Plan threads count as large changes, and no member of that rule's group has plan mode. */
  readonly planlessHardRule: boolean;
}

export function routingGroupProblems(input: {
  readonly groups: ReadonlyArray<RoutingGroup>;
  readonly rules: RoutingGroupRules;
  readonly providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly showInteractionModeToggle?: boolean | undefined;
  }>;
}): RoutingGroupProblems {
  const groupIds = new Set(input.groups.map((group) => group.id));
  const instanceIds = new Set(input.providers.map((provider) => provider.instanceId));
  const missingMembers = new Map<string, ReadonlyArray<number>>();
  for (const group of input.groups) {
    const missing = group.members.flatMap((member, index) =>
      instanceIds.has(member.instanceId) ? [] : [index],
    );
    if (missing.length > 0) missingMembers.set(group.id, missing);
  }
  const hardGroup = input.groups.find((group) => group.id === input.rules.hard);
  return {
    missingRuleGroups: ROUTING_TASK_CLASSES.filter((taskClass) => {
      const groupId = input.rules[taskClass];
      return groupId !== undefined && !groupIds.has(groupId);
    }),
    missingMembers,
    planlessHardRule:
      hardGroup !== undefined &&
      hardGroup.members.every((member) => {
        const provider = input.providers.find((entry) => entry.instanceId === member.instanceId);
        return provider !== undefined && provider.showInteractionModeToggle !== true;
      }),
  };
}

export function rulesUsingRoutingGroup(
  rules: RoutingGroupRules,
  groupId: string,
): ReadonlyArray<RoutingTaskClass> {
  return ROUTING_TASK_CLASSES.filter((taskClass) => rules[taskClass] === groupId);
}

/** A stable id from the first name; a taken one gets a numeric suffix. */
export function newRoutingGroupId(name: string, taken: ReadonlyArray<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "group";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** Moves one entry by `delta` places; out-of-range moves return the list unchanged. */
export function moveListItem<T>(items: ReadonlyArray<T>, index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** Sets or clears one class's rule; the patch replaces every rule. */
export function withRoutingGroupRule(
  rules: RoutingGroupRules,
  taskClass: RoutingTaskClass,
  groupId: string | null,
): RoutingGroupRules {
  const { [taskClass]: _previous, ...rest } = rules;
  return groupId ? { ...rest, [taskClass]: groupId } : rest;
}

export interface PickerRoutingGroup {
  readonly id: string;
  readonly name: string;
  /** An agent team: the placeholder leads and delegates to the members. */
  readonly team: boolean;
  /** Member models in order, such as "Opus 5.5, GPT-6". */
  readonly summary: string;
  readonly placeholder: ModelSelection;
}

/**
 * Groups resolve once, when a thread launches, so only a new thread's single-model draft offers
 * them, and only from a server that resolves them.
 */
export function pickerRoutingGroups(input: {
  readonly newThread: boolean;
  readonly multiModel: boolean;
  readonly capability: boolean | undefined;
  readonly groups: ReadonlyArray<RoutingGroup> | undefined;
  readonly providers: ReadonlyArray<ModelNameSource>;
}): ReadonlyArray<PickerRoutingGroup> {
  if (!input.newThread || input.multiModel) return [];
  return offeredRoutingGroups(input).flatMap((group) => {
    // The draft shows the member the server would most likely pick, so an exhausted or
    // stopped first member does not block sending.
    const placeholder =
      group.members.find((member) => {
        const provider = input.providers.find((entry) => entry.instanceId === member.instanceId);
        const model = provider?.models.find(
          (candidate) =>
            candidate.slug === member.model || candidate.aliases?.includes(member.model),
        );
        return model !== undefined && provider?.runnable?.(model.slug) !== false;
      }) ?? group.members[0];
    if (!placeholder) return [];
    return [
      {
        id: group.id,
        name: group.name,
        team: group.team === true,
        summary:
          group.team === true
            ? agentTeamSummary(group, placeholder, input.providers)
            : group.members.map((member) => routingMemberLabel(member, input.providers)).join(", "),
        placeholder,
      },
    ];
  });
}

/** Such as "Opus 5.5 leads GPT-6.1, Gemini 4"; a lone member leads itself. */
export function agentTeamSummary(
  team: Pick<RoutingGroup, "members">,
  lead: Pick<ModelSelection, "instanceId" | "model"> | undefined,
  providers: ReadonlyArray<ModelNameSource>,
): string {
  const leader = lead ?? team.members[0];
  if (!leader) return "";
  const others = team.members.filter(
    (member) => member.instanceId !== leader.instanceId || member.model !== leader.model,
  );
  const leadLabel = routingMemberLabel(leader, providers);
  return others.length === 0
    ? `${leadLabel} leads`
    : `${leadLabel} leads ${others.map((member) => routingMemberLabel(member, providers)).join(", ")}`;
}

/** Plain routing groups; agent teams are edited and listed apart. */
export function plainRoutingGroups(
  groups: ReadonlyArray<RoutingGroup>,
): ReadonlyArray<RoutingGroup> {
  return groups.filter((group) => group.team !== true);
}

/** One task the lead handed to a team member: a step of the team's workflow. */
export interface AgentTeamTaskRow {
  readonly id: string;
  readonly title: string;
  /** The member that runs it, such as "GPT-6.1". */
  readonly member: string;
  readonly driver: ProviderDriverKind;
  /** The member's model and options, for its provider icon and effort. */
  readonly selection: ModelSelection;
  readonly status: "working" | "done" | "failed" | "stopped";
  /** Above 1 when this member got the task after an earlier task of its own ended: a redo. */
  readonly round: number;
  /** The first lines of what the lead asked for. */
  readonly brief: string;
  /** The first lines of the member's final report; null until it has one. */
  readonly report: string | null;
  /** What a working member last said it is doing. */
  readonly progress: string | null;
  /** A started task the lead's thread can still stop. */
  readonly stoppable: boolean;
  readonly childThreadId: ThreadId | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface AgentTeamProgress {
  readonly rows: ReadonlyArray<AgentTeamTaskRow>;
  readonly working: number;
  readonly done: number;
  readonly failed: number;
  /** When the first task started. */
  readonly startedAt: string | null;
  /** When the last task ended; null while a member works or the lead runs. */
  readonly completedAt: string | null;
  /**
   * The lead runs with no member working: it plans before its first handover and reviews after
   * one. Null when it is idle, a member works, or the caller cannot tell whether it runs.
   */
  readonly lead: "planning" | "reviewing" | null;
}

const TEAM_TASK_STATUS: Record<OrchestrationV2Subagent["status"], AgentTeamTaskRow["status"]> = {
  idle: "working",
  pending: "working",
  running: "working",
  waiting: "working",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "stopped",
};

function isoOrNull(value: DateTime.Utc | null): string | null {
  return value === null ? null : DateTime.formatIso(value);
}

/** Started tasks by start time; ones not started yet keep their order after them. */
function byStart(
  left: Pick<AgentTeamTaskRow, "startedAt">,
  right: Pick<AgentTeamTaskRow, "startedAt">,
): number {
  if (left.startedAt === null || right.startedAt === null) {
    return Number(left.startedAt === null) - Number(right.startedAt === null);
  }
  return Date.parse(left.startedAt) - Date.parse(right.startedAt);
}

/** The earlier task ended before the later one began, so the later one is a new handover. */
function endedBefore(
  earlier: Pick<AgentTeamTaskRow, "status" | "completedAt">,
  later: Pick<AgentTeamTaskRow, "startedAt">,
): boolean {
  if (earlier.status === "working") return false;
  if (earlier.completedAt === null || later.startedAt === null) return true;
  return Date.parse(earlier.completedAt) <= Date.parse(later.startedAt);
}

/**
 * The tasks a thread delegated to its team's members, in the order they started; ones not started
 * yet come last. Only tasks the thread itself delegated (not a provider's own subagents or
 * workflows) to a member of the team count.
 */
export function agentTeamProgress(input: {
  readonly threadId: string;
  /** A saved team's members; null for an automatic team, whose workers T3 picks per task. */
  readonly team: Pick<RoutingGroup, "members"> | null;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly providers: ReadonlyArray<ModelNameSource>;
  /** Whether the lead's own thread runs now; leave out when unknown. */
  readonly leadRunning?: boolean | undefined;
}): AgentTeamProgress {
  const tasks = input.subagents
    .flatMap((task): Omit<AgentTeamTaskRow, "round">[] => {
      if (task.threadId !== input.threadId || task.origin !== "app_owned") return [];
      if (task.workflow !== undefined || task.councilLens !== undefined) return [];
      const selection = task.modelSelection;
      const member =
        selection &&
        (input.team === null
          ? selection
          : input.team.members.find(
              (candidate) =>
                candidate.instanceId === selection.instanceId &&
                candidate.model === selection.model,
            ));
      if (!selection || !member) return [];
      const status = TEAM_TASK_STATUS[task.status];
      return [
        {
          id: task.id,
          title: task.title?.trim() || promptTitle(task.prompt),
          member: routingMemberLabel(member, input.providers),
          driver: task.driver,
          selection,
          status,
          brief: excerpt(task.prompt),
          report: task.result?.trim() ? excerpt(task.result) : null,
          progress: status === "working" ? task.progress?.trim() || null : null,
          stoppable: status === "working" && task.startedAt !== null,
          childThreadId: task.childThreadId,
          startedAt: isoOrNull(task.startedAt),
          completedAt: isoOrNull(task.completedAt),
        },
      ];
    })
    .sort(byStart);
  const rows: AgentTeamTaskRow[] = [];
  for (const task of tasks) {
    const previous = rows.filter(
      (row) =>
        row.selection.instanceId === task.selection.instanceId &&
        row.selection.model === task.selection.model &&
        endedBefore(row, task),
    );
    rows.push({ ...task, round: Math.max(0, ...previous.map((row) => row.round)) + 1 });
  }
  const working = rows.filter((row) => row.status === "working").length;
  const lead =
    input.leadRunning === true && working === 0
      ? rows.length === 0
        ? "planning"
        : "reviewing"
      : null;
  const ends = rows.flatMap((row) => (row.completedAt === null ? [] : [row.completedAt]));
  return {
    rows,
    working,
    done: rows.filter((row) => row.status === "done").length,
    failed: rows.filter((row) => row.status === "failed").length,
    startedAt: rows[0]?.startedAt ?? null,
    completedAt:
      working > 0 || lead !== null || ends.length === 0
        ? null
        : ends.reduce((latest, end) => (Date.parse(end) > Date.parse(latest) ? end : latest)),
    lead,
  };
}

function promptTitle(prompt: string): string {
  const line = prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "Task";
}

const EXCERPT_LINES = 8;
const EXCERPT_CHARS = 600;

/** The first lines of a prompt or report, cut with an ellipsis when there is more. */
function excerpt(text: string): string {
  const lines = text.trim().split("\n");
  const head = lines.slice(0, EXCERPT_LINES).join("\n").trimEnd();
  if (head.length > EXCERPT_CHARS) return `${head.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
  return lines.length > EXCERPT_LINES ? `${head}\n…` : head;
}
