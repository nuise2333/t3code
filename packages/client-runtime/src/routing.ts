import {
  type AutoRoutingSettings,
  isProviderAvailable,
  type LaunchRoutingRequest,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type RouteDecision,
  type RoutingGroup,
  type RoutingGroupRules,
  type RoutingReason,
  type RoutingSkipReason,
  type RoutingTaskClass,
  type ServerProvider,
} from "@t3tools/contracts";
import { isReasoningSelect } from "@t3tools/shared/model";
import { effortSetOutsidePicker } from "@t3tools/shared/routing";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";

const REASON_LABELS: Partial<Record<RoutingReason, string>> = {
  plan_mode: "Plan mode",
  many_paths: "Mentions 3+ files",
  hard_keyword: "Large change",
  debug_keyword: "Debugging",
  question: "Question, no edits",
  quick_keyword: "Small edit",
  default_class: "No clear signal",
  model_row: "Tuned for this model",
  nearest_level: "Closest level this model offers",
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

export function describeRoutingReasons(reasons: ReadonlyArray<RoutingReason>): string {
  return reasons.flatMap((reason) => REASON_LABELS[reason] ?? []).join(", ");
}

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
  const reason = describeRoutingReasons(routing.reasons);
  return {
    levelLabel,
    reason,
    summary: reason ? `Auto picked ${levelLabel}: ${reason}` : `Auto picked ${levelLabel}`,
  };
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
  /** Such as "Fast → GPT-6.1". */
  readonly label: string;
  /** Such as "Skipped: Opus 5.5 (usage limit)"; null when the first member ran. */
  readonly skipped: string | null;
}

/**
 * The group a thread launched through, as recorded at launch, so later edits to the group do not
 * relabel it. Once its user picks another model the thread is an ordinary manual one.
 */
export function routedGroupDisplay(input: {
  readonly routing: RouteDecision | null | undefined;
  readonly selection: Pick<ModelSelection, "instanceId" | "model"> | null | undefined;
  readonly providers: ReadonlyArray<ModelNameSource>;
}): RoutedGroupDisplay | null {
  const decision = input.routing?.group;
  if (!decision || !input.selection) return null;
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
    label: `${decision.name} → ${routingMemberLabel(input.selection, input.providers)}`,
    skipped: skipped.length > 0 ? `Skipped: ${skipped.join(", ")}` : null,
  };
}

const EFFORT_ONLY_REASONS: ReadonlySet<RoutingReason> = new Set(["model_row", "nearest_level"]);

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
    input.routing?.reasons.filter((code) => !EFFORT_ONLY_REASONS.has(code)) ?? [],
  );
  const why = reason ? ` (${reason})` : "";
  if (!decision.applied) {
    return `With ${decision.switched} switching on, Auto would have used ${name}${why}`;
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
  return `Auto → ${name}${why}${from}`;
}

interface RoutingGroupProblems {
  /** Task classes whose rule names a group that no longer exists. */
  readonly missingRuleGroups: ReadonlyArray<RoutingTaskClass>;
  /** Member indexes, by group id, whose provider instance no longer exists. */
  readonly missingMembers: ReadonlyMap<string, ReadonlyArray<number>>;
}

export function routingGroupProblems(input: {
  readonly groups: ReadonlyArray<RoutingGroup>;
  readonly rules: RoutingGroupRules;
  readonly providers: ReadonlyArray<{ readonly instanceId: ProviderInstanceId }>;
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
  return {
    missingRuleGroups: ROUTING_TASK_CLASSES.filter((taskClass) => {
      const groupId = input.rules[taskClass];
      return groupId !== undefined && !groupIds.has(groupId);
    }),
    missingMembers,
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
        summary: group.members
          .map((member) => routingMemberLabel(member, input.providers))
          .join(", "),
        placeholder,
      },
    ];
  });
}
