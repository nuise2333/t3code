import {
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type RouteDecision,
  type RoutingEffort,
  type RoutingGroup,
  type RoutingReason,
  type RoutingSkipReason,
  type RoutingTable,
  type RoutingTaskClass,
  type RoutingTier,
  type RuntimeMode,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  getProviderOptionCurrentValue,
  isClaudeUltrathinkPrompt,
  isReasoningSelect,
  optionSelectionProblem,
  withLegacyUltracodeEffort,
} from "./model.ts";
import { applicableUsageWindows, exhaustedUsageWindow } from "./usageLimits.ts";

const EFFORT_LADDER: ReadonlyArray<RoutingEffort> = ["low", "medium", "high"];

const PATH_TOKEN =
  /(?:^|[\s`'"([])((?:[\w@.-]+\/)+[\w@.-]+|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|swift|css|scss|html|ya?ml|toml|sql|sh|rb|c|cc|cpp|h|hpp|cs|php|vue|svelte))(?=$|[\s`'"),:;\]]|\.(?:\s|$))/g;
const HARD_KEYWORD = /\b(?:across|rewrit\w*|architect\w*)\b|跨模块|跨文件|重写/i;
const REFACTOR = /\brefactor\w*\b|重构/i;
const REFACTOR_SPAN = /\bacross\b|跨(?!域|平台|端)/i;
const DEBUG_KEYWORD =
  /\bwhy\b[^.?!\n]*(?:\b(?:fail\w*|broken|crash\w*)|(?:\bnot\b|n't)[^.?!\n]*\bwork\w*)|\b(?:root cause|debug(?:ging)?|flaky|race conditions?|regressions?(?! tests?)|stack ?traces?)\b|报错|崩溃|失败|排查|根因|调试|为什么[^。？?！!\n]*不(?!用|选|采用|使用|直接)/i;
const QUICK_KEYWORD =
  /\b(?:renam\w*|typos?|bump\w*|tweak\w*|one[- ]line\w*)\b|\bchange\b[^.?!\n]*\bto\b|改名|重命名|拼写|错别字|把[^。；;\n]*改成/i;
const WRITE_VERB =
  /\b(?:fix|add|implement|change|update|remove|delete|write|create|make|build|edit|replace)\w*\b|修复|实现|添加|删除|更新|修改|新增|创建|编写|写一|写个/i;
const QUESTION =
  /\b(?:why|explain|what|where|how|find|which)\b|[?？]|为什么|怎么|解释|说明|在哪|是什么|查找/i;
const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;
const STACK_FRAME = /^[ \t]*(?:at [^\n]*:\d+(?::\d+)?\)?|File "[^"\n]+", line \d+[^\n]*)[ \t]*$/gm;

function countPaths(prompt: string): number {
  const paths = new Set<string>();
  for (const match of prompt.matchAll(PATH_TOKEN)) {
    const token = match[1];
    if (token !== undefined && !/^https?:/i.test(token)) paths.add(token);
  }
  return paths.size;
}

/** Pasted code and stack frames carry paths and words nobody asked about. */
function stripPasted(prompt: string): string {
  return prompt.replace(CODE_FENCE, "").replace(STACK_FRAME, "").trim();
}

export function classifyTask(input: {
  readonly prompt: string;
  readonly interactionMode: ProviderInteractionMode;
}): { readonly taskClass: RoutingTaskClass; readonly reasons: ReadonlyArray<RoutingReason> } {
  if (input.interactionMode === "plan") return { taskClass: "hard", reasons: ["plan_mode"] };
  const prompt = stripPasted(input.prompt);
  const paths = countPaths(prompt);
  const words = prompt.replace(PATH_TOKEN, " ");
  // Broad is not hard: many paths stay on the record but do not pick the class.
  const broad: Array<RoutingReason> = paths >= 3 ? ["many_paths"] : [];
  const classed = (taskClass: RoutingTaskClass, reason: RoutingReason) => ({
    taskClass,
    reasons: [...broad, reason],
  });
  if (
    HARD_KEYWORD.test(words) ||
    (REFACTOR.test(words) && (paths >= 2 || REFACTOR_SPAN.test(words)))
  ) {
    return classed("hard", "hard_keyword");
  }
  if (DEBUG_KEYWORD.test(words)) return classed("hard", "debug_keyword");
  if (prompt.length <= 300 && paths <= 1 && QUICK_KEYWORD.test(words)) {
    return classed("quick_edit", "quick_keyword");
  }
  if (prompt.length <= 400 && !WRITE_VERB.test(words) && QUESTION.test(words)) {
    return classed("readonly", "question");
  }
  return classed("implement", "default_class");
}

const AT_MOST_HIGH: ReadonlySet<string> = new Set(["none", "minimal", "low", "medium", "high"]);

/** The cap applies to what reaches the provider, since an adapter can remap a label. */
const emitsAtMostHigh = (emitted: string | null | undefined): boolean =>
  emitted === undefined || (emitted !== null && AT_MOST_HIGH.has(emitted));

const LEVEL_RANK: Readonly<Record<string, number>> = {
  none: -1,
  off: -1,
  minimal: -1,
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

/**
 * The target if offered, else the nearest lower level, else the nearest higher one up to high.
 * A lower level beneath the model's own default gives way to the higher one.
 */
function nearestOfferedLevel(
  target: RoutingEffort,
  offered: ReadonlySet<string>,
  defaultRank: number | undefined,
): RoutingEffort | null {
  if (offered.has(target)) return target;
  const index = EFFORT_LADDER.indexOf(target);
  const lower = EFFORT_LADDER.slice(0, index)
    .reverse()
    .find((level) => offered.has(level));
  const higher = EFFORT_LADDER.slice(index + 1).find((level) => offered.has(level));
  if (
    lower !== undefined &&
    defaultRank !== undefined &&
    EFFORT_LADDER.indexOf(lower) < defaultRank
  ) {
    return higher ?? lower;
  }
  return lower ?? higher ?? null;
}

/** Ultrathink in the prompt or Ultracode on sets the level outside the effort picker. */
export function effortSetOutsidePicker(input: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly ultrathinkPrompt: boolean;
}): boolean {
  const descriptors = input.descriptors ?? [];
  const reasoning = descriptors.find(isReasoningSelect);
  if (input.ultrathinkPrompt && (reasoning?.promptInjectedValues?.length ?? 0) > 0) return true;
  const ultracode = descriptors.find(
    (descriptor) => descriptor.id === "ultracode" && descriptor.type === "boolean",
  );
  if (ultracode === undefined) return false;
  const stated = withLegacyUltracodeEffort(descriptors, input.selection?.options)?.find(
    (option) => option.id === "ultracode",
  )?.value;
  return (stated ?? getProviderOptionCurrentValue(ultracode)) === true;
}

export function routeFor(input: {
  readonly table: RoutingTable;
  readonly driver: ProviderDriverKind;
  readonly selection: ModelSelection;
  /** The catalog slug the selection's model resolves to, when it names an alias. */
  readonly modelSlug?: string | undefined;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
  readonly prompt: string;
  readonly interactionMode: ProviderInteractionMode;
  /** False records a shadow decision and returns the selection unchanged. */
  readonly apply: boolean;
  /** The level the adapter sends for a choice: undefined sends the id itself, null sends none. */
  readonly emittedLevel?: ((choiceId: string) => string | null | undefined) | undefined;
}): { readonly selection: ModelSelection; readonly decision: RouteDecision } {
  const { table, selection } = input;
  const classified = classifyTask(input);
  const unchanged = (reason: RoutingReason) => ({
    selection,
    decision: {
      taskClass: classified.taskClass,
      effort: null,
      applied: false,
      reasons: [...classified.reasons, reason],
      tableUpdatedAt: table.updatedAt,
    },
  });

  // ACP Registry agents publish arbitrary reasoning levels, so no table row can speak for them.
  if (input.driver === "acpRegistry") return unchanged("no_row");
  if (
    effortSetOutsidePicker({
      descriptors: input.descriptors,
      selection,
      ultrathinkPrompt: isClaudeUltrathinkPrompt(input.prompt),
    })
  ) {
    return unchanged("user_choice");
  }
  const rows = table.rows.filter((row) => row.driver === input.driver);
  const model = input.modelSlug ?? selection.model;
  const exactRow = rows.find((row) => row.model === model);
  const row = exactRow ?? rows.find((row) => row.model === "*");
  if (row === undefined) return unchanged("no_row");

  const rowEffort = row.effortByClass?.[classified.taskClass];
  const classTarget = rowEffort ?? table.defaultEffortByClass[classified.taskClass];
  const descriptor = input.descriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return unchanged("no_effort_control");
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  const offered = new Set(
    descriptor.options
      .map((option) => option.id)
      .filter((id) => !injected.has(id) && emitsAtMostHigh(input.emittedLevel?.(id))),
  );
  const modelDefault = getProviderOptionCurrentValue(descriptor);
  const defaultRank = typeof modelDefault === "string" ? LEVEL_RANK[modelDefault] : undefined;
  // With no signal, routing has no evidence to go below the model's own default.
  const target =
    classified.reasons.includes("default_class") &&
    defaultRank !== undefined &&
    defaultRank > EFFORT_LADDER.indexOf(classTarget)
      ? (EFFORT_LADDER[Math.min(defaultRank, EFFORT_LADDER.length - 1)] ?? classTarget)
      : classTarget;
  const effort = nearestOfferedLevel(target, offered, defaultRank);
  if (effort === null) return unchanged("no_effort_control");

  const explicit = selection.options?.find((option) => option.id === descriptor.id)?.value;
  const baseline =
    typeof explicit === "string" ? explicit : getProviderOptionCurrentValue(descriptor, selection);
  const reasons: Array<RoutingReason> = [...classified.reasons];
  if (rowEffort !== undefined) reasons.push("model_row");
  if (effort !== target) reasons.push("nearest_level");
  const decision: RouteDecision = {
    taskClass: classified.taskClass,
    effort,
    optionId: descriptor.id,
    ...(typeof baseline === "string" ? { baseline } : {}),
    applied: input.apply,
    reasons,
    tableUpdatedAt: table.updatedAt,
  };
  if (!input.apply) return { selection, decision };

  const options = selection.options ?? [];
  const routedOption = { id: descriptor.id, value: effort };
  return {
    selection: {
      ...selection,
      options: options.some((option) => option.id === descriptor.id)
        ? options.map((option) => (option.id === descriptor.id ? routedOption : option))
        : [...options, routedOption],
    },
    decision,
  };
}

export interface RoutingGroupSkip {
  readonly index: number;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly reason: RoutingSkipReason;
}

export type RoutingGroupResolution =
  | {
      readonly ok: true;
      readonly index: number;
      readonly selection: ModelSelection;
      readonly skipped: ReadonlyArray<RoutingGroupSkip>;
    }
  | { readonly ok: false; readonly skipped: ReadonlyArray<RoutingGroupSkip> };

function memberSkipReason(input: {
  readonly member: ModelSelection;
  readonly provider: ServerProvider | undefined;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly projectId: ProjectId | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly runnableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  readonly now: number;
}): RoutingSkipReason | null {
  const { member, provider } = input;
  if (provider === undefined) return "instance_missing";
  if (!provider.enabled) return "instance_disabled";
  if (
    input.runnableInstanceIds?.has(member.instanceId) === false ||
    !provider.installed ||
    provider.status === "error" ||
    provider.status === "disabled" ||
    provider.auth.status === "unauthenticated" ||
    !isProviderAvailable(provider)
  ) {
    return "not_ready";
  }
  if (!resolveProjectProviderInstanceEnabled(input.settings, input.projectId, member.instanceId)) {
    return "project_disabled";
  }
  const model = provider.models.find(
    (candidate) =>
      candidate.slug === member.model || candidate.aliases?.includes(member.model) === true,
  );
  if (model === undefined) return "model_unavailable";
  if (exhaustedUsageWindow(provider, input.now, model.slug) !== undefined) return "usage_exhausted";
  // A provider without the thread's mode would quietly run it as approval-required.
  const modes = provider.supportedRuntimeModes;
  if (modes !== undefined && modes.length > 0 && !modes.includes(input.runtimeMode)) {
    return "runtime_mode";
  }
  if (input.interactionMode === "plan" && provider.showInteractionModeToggle !== true) {
    return "plan_unsupported";
  }
  return null;
}

/** A member's options are the user's choice; only ones its model still accepts are kept. */
function acceptedOptions(
  member: ModelSelection,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ModelSelection {
  if (member.options === undefined || descriptors === undefined) return member;
  const seen = new Set<string>();
  const options = member.options.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return optionSelectionProblem(option, descriptors) === null;
  });
  const { options: _options, ...rest } = member;
  return options.length === 0 ? rest : { ...rest, options };
}

/** The first member, in order, that can run this launch; never a model outside the group. */
export function resolveRoutingGroup(input: {
  readonly group: RoutingGroup;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly projectId: ProjectId | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly runnableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly now: number;
}): RoutingGroupResolution {
  const skipped: Array<RoutingGroupSkip> = [];
  for (const [index, member] of input.group.members.entries()) {
    const provider = input.providers.find(
      (candidate) => candidate.instanceId === member.instanceId,
    );
    const reason = memberSkipReason({
      ...input,
      runnableInstanceIds: input.runnableInstanceIds,
      member,
      provider,
    });
    if (reason !== null) {
      skipped.push({ index, instanceId: member.instanceId, model: member.model, reason });
      continue;
    }
    const descriptors = provider?.models.find(
      (candidate) =>
        candidate.slug === member.model || candidate.aliases?.includes(member.model) === true,
    )?.capabilities?.optionDescriptors;
    return { ok: true, index, selection: acceptedOptions(member, descriptors), skipped };
  }
  return { ok: false, skipped };
}

/** Cheapest first; Auto takes the cheapest tier at or above the task's and never goes past S. */
const TIER_ORDER: ReadonlyArray<RoutingTier> = ["C", "B", "A", "S"];
const DESIRED_TIER: Readonly<Record<RoutingTaskClass, RoutingTier>> = {
  readonly: "C",
  quick_edit: "B",
  implement: "A",
  hard: "S",
};
/** Share of a usage window Auto leaves for the user's own interactive work. */
const QUOTA_RESERVE_PERCENT = 15;
const FALLBACK_RESET_HOURS = 168;

// Provider-side routers bill opaquely, so Auto never picks one (J5); a user's own pick keeps it.
const OPAQUE_ROUTER_MODELS: Readonly<Partial<Record<string, ReadonlyArray<string>>>> = {
  cursor: ["auto", "default"],
  kiro: ["default", "auto"],
};
// ACP agents publish arbitrary models; Pi only takes an explicit model as a hint.
const UNROUTED_DRIVERS: ReadonlySet<string> = new Set(["acpRegistry", "pi"]);

const isOpaqueRouter = (driver: string, model: string) =>
  OPAQUE_ROUTER_MODELS[driver]?.includes(model) === true;

const isCandidateRow = (row: RoutingTable["rows"][number]) =>
  row.verified === true &&
  row.tier !== undefined &&
  row.model !== "*" &&
  !UNROUTED_DRIVERS.has(row.driver) &&
  !isOpaqueRouter(row.driver, row.model);

const findModel = (provider: ServerProvider, model: string) =>
  provider.models.find(
    (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
  );

/** A launch with fresh options lands on the model's defaults; skip models whose defaults cost more. */
function premiumByDefault(descriptors: ReadonlyArray<ProviderOptionDescriptor>): boolean {
  if (effortSetOutsidePicker({ descriptors, selection: null, ultrathinkPrompt: false }))
    return true;
  return descriptors.some((descriptor) => {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      return getProviderOptionCurrentValue(descriptor) === true;
    }
    if (descriptor.id === "contextWindow" && descriptor.type === "select") {
      const value = getProviderOptionCurrentValue(descriptor);
      return value !== undefined && value !== descriptor.options[0]?.id;
    }
    return false;
  });
}

/** 0 known with room, 1 unknown, 2 known inside the reserve; higher score spends expiring quota first. */
function quotaRank(provider: ServerProvider, model: string, now: number) {
  const windows = applicableUsageWindows(provider, now, model);
  if (windows.length === 0) return { bucket: 1, score: 0 };
  const tightest = windows.reduce((least, window) =>
    window.usedPercent > least.usedPercent ? window : least,
  );
  const remaining = 100 - tightest.usedPercent;
  if (remaining <= QUOTA_RESERVE_PERCENT) return { bucket: 2, score: 0 };
  const resetsAt = tightest.resetsAt === undefined ? Number.NaN : Date.parse(tightest.resetsAt);
  const hours = Number.isFinite(resetsAt)
    ? (resetsAt - now) / 3_600_000
    : tightest.windowDurationMins === undefined
      ? FALLBACK_RESET_HOURS
      : tightest.windowDurationMins / 60;
  return { bucket: 0, score: (remaining - QUOTA_RESERVE_PERCENT) / Math.max(hours, 1) };
}

type AutoModelSkipReason = RoutingSkipReason | "premium_default";

interface AutoModelChoice {
  /** The draft's selection when nothing switches; otherwise the target with no options yet. */
  readonly selection: ModelSelection;
  readonly tier: RoutingTier | null;
  readonly switched: "none" | "model" | "provider";
  readonly skipped: number;
  readonly skippedByReason: Readonly<Partial<Record<AutoModelSkipReason, number>>>;
}

/**
 * The model Auto would launch with: the cheapest verified tier at or above the task's, and
 * no pricier than the thread's model unless the task is hard,
 * among candidates that pass a routing group member's checks.
 */
export function chooseAutoModel(input: {
  readonly table: RoutingTable;
  readonly taskClass: RoutingTaskClass;
  readonly current: ModelSelection;
  /**
   * `instance`: other models on the thread's instance. `provider`: other instances, keeping the
   * current model on its own instance. `any`: both.
   */
  readonly scope: "instance" | "provider" | "any";
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly projectId: ProjectId | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly now: number;
}): AutoModelChoice {
  const { current } = input;
  const currentProvider = input.providers.find(
    (provider) => provider.instanceId === current.instanceId,
  );
  const currentSlug =
    currentProvider === undefined
      ? current.model
      : (findModel(currentProvider, current.model)?.slug ?? current.model);
  const currentTier =
    input.table.rows.find(
      (row) =>
        isCandidateRow(row) && row.driver === currentProvider?.driver && row.model === currentSlug,
    )?.tier ?? null;
  const skippedByReason: Partial<Record<AutoModelSkipReason, number>> = {};
  let skipped = 0;
  const keep = (): AutoModelChoice => ({
    selection: current,
    tier: currentTier,
    switched: "none",
    skipped,
    skippedByReason,
  });
  if (
    currentProvider !== undefined &&
    (UNROUTED_DRIVERS.has(currentProvider.driver) ||
      isOpaqueRouter(currentProvider.driver, currentSlug))
  ) {
    return keep();
  }

  const candidates: Array<{
    readonly provider: ServerProvider;
    readonly slug: string;
    readonly tier: RoutingTier;
    readonly isCurrent: boolean;
  }> = [];
  for (const row of input.table.rows) {
    if (!isCandidateRow(row) || row.tier === undefined) continue;
    for (const provider of input.providers) {
      if (provider.driver !== row.driver) continue;
      if (input.scope === "instance" && provider.instanceId !== current.instanceId) continue;
      const model = findModel(provider, row.model);
      if (model === undefined) continue;
      const isCurrent = provider.instanceId === current.instanceId && model.slug === currentSlug;
      if (input.scope === "provider" && provider.instanceId === current.instanceId && !isCurrent) {
        continue;
      }
      const reason: AutoModelSkipReason | null =
        memberSkipReason({
          ...input,
          member: { instanceId: provider.instanceId, model: model.slug },
          provider,
          runnableInstanceIds: undefined,
        }) ??
        (!isCurrent && premiumByDefault(model.capabilities?.optionDescriptors ?? [])
          ? "premium_default"
          : null);
      if (reason !== null) {
        skipped += 1;
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
        continue;
      }
      candidates.push({ provider, slug: model.slug, tier: row.tier, isCurrent });
    }
  }

  // Only hard tasks may move to a pricier tier than the thread's model, so turning Auto on saves.
  const ceiling =
    input.taskClass === "hard" || currentTier === null
      ? TIER_ORDER.length
      : TIER_ORDER.indexOf(currentTier) + 1;
  const tier = TIER_ORDER.slice(TIER_ORDER.indexOf(DESIRED_TIER[input.taskClass]), ceiling).find(
    (level) => candidates.some((candidate) => candidate.tier === level),
  );
  if (tier === undefined) return keep();
  const ranked = candidates
    .filter((candidate) => candidate.tier === tier)
    .map((candidate) => ({
      candidate,
      onCurrentInstance: candidate.provider.instanceId === current.instanceId ? 0 : 1,
      isCurrent: candidate.isCurrent ? 0 : 1,
      ...quotaRank(candidate.provider, candidate.slug, input.now),
    }))
    // Staying on the thread's instance keeps its prompt cache and session; then spend expiring quota.
    .sort(
      (a, b) =>
        a.onCurrentInstance - b.onCurrentInstance ||
        a.isCurrent - b.isCurrent ||
        a.bucket - b.bucket ||
        b.score - a.score,
    );
  const chosen = ranked[0]?.candidate;
  if (chosen === undefined || chosen.isCurrent) return { ...keep(), tier };
  return {
    selection: { instanceId: chosen.provider.instanceId, model: chosen.slug },
    tier,
    switched: chosen.provider.instanceId === current.instanceId ? "model" : "provider",
    skipped,
    skippedByReason,
  };
}
