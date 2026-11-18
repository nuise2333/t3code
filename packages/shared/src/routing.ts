import {
  isProviderAvailable,
  type AutoTeamKind,
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
  /\b(?:renam\w*|typos?|bump\w*|tweak\w*|one[- ]liners?|one[- ]line (?:fix|change|edit)\w*)\b|\bchange\b[^.?!\n]*\bto\b|改名|重命名|拼写|错别字|把[^。；;\n]*改成/i;
const WRITE_VERBS_EN =
  "fix|add|implement|change|update|remove|delete|write|create|make|build|edit|replace";
const WRITE_VERBS_ZH = "修复|实现|添加|删除|更新|修改|新增|创建|编写|写一|写个";
const WRITE_VERB = new RegExp(`\\b(?:${WRITE_VERBS_EN})\\w*\\b|${WRITE_VERBS_ZH}`, "i");
// "Don't change anything" and 不要修改 forbid a write, so they leave a question a question.
const NEGATED_WRITE = new RegExp(
  `\\b(?:don't|do not|never|without)\\s+(?:\\w+\\s+)?(?:${WRITE_VERBS_EN})\\w*|(?:不要|别|不用|无需|请勿|不得|不必)(?:${WRITE_VERBS_ZH})`,
  "gi",
);
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
  if (
    prompt.length <= 400 &&
    !WRITE_VERB.test(words.replace(NEGATED_WRITE, " ")) &&
    QUESTION.test(words)
  ) {
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

export interface HigherEffort {
  readonly optionId: string;
  readonly value: string;
  readonly label: string;
}

/**
 * The lowest offered level above the current one. Its user asks for it, so it may pass High,
 * unlike Auto.
 */
export function nextHigherEffort(input: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  /** Ultrathink in a prompt being retried already set its level. */
  readonly ultrathinkPrompt: boolean;
}): HigherEffort | null {
  if (effortSetOutsidePicker(input)) return null;
  const descriptor = input.descriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return null;
  const explicit = input.selection?.options?.find((option) => option.id === descriptor.id)?.value;
  const current =
    typeof explicit === "string" ? explicit : getProviderOptionCurrentValue(descriptor);
  const currentRank = typeof current === "string" ? LEVEL_RANK[current] : undefined;
  if (currentRank === undefined) return null;
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  let next: { readonly id: string; readonly label: string; readonly rank: number } | null = null;
  for (const option of descriptor.options) {
    const rank: number | undefined = LEVEL_RANK[option.id];
    if (rank === undefined || rank <= currentRank || injected.has(option.id)) continue;
    if (next === null || rank < next.rank) next = { id: option.id, label: option.label, rank };
  }
  return next === null ? null : { optionId: descriptor.id, value: next.id, label: next.label };
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
  /** Set by a delegated role; replaces what the prompt would classify as. */
  readonly taskClass?: RoutingTaskClass | undefined;
  /** The lowest level to pick; a missing level then rises, still never past high. */
  readonly minEffort?: RoutingEffort | undefined;
}): { readonly selection: ModelSelection; readonly decision: RouteDecision } {
  const { table, selection } = input;
  const classified =
    input.taskClass === undefined
      ? classifyTask(input)
      : { taskClass: input.taskClass, reasons: [] as ReadonlyArray<RoutingReason> };
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
  const exactRow = modelRow(table, input.driver, [input.modelSlug ?? selection.model]);
  const row =
    exactRow ?? table.rows.find((row) => row.driver === input.driver && row.model === "*");
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
  const signalTarget =
    classified.reasons.includes("default_class") &&
    defaultRank !== undefined &&
    defaultRank > EFFORT_LADDER.indexOf(classTarget)
      ? (EFFORT_LADDER[Math.min(defaultRank, EFFORT_LADDER.length - 1)] ?? classTarget)
      : classTarget;
  const minEffort = input.minEffort;
  const target =
    minEffort !== undefined &&
    EFFORT_LADDER.indexOf(minEffort) > EFFORT_LADDER.indexOf(signalTarget)
      ? minEffort
      : signalTarget;
  const effort =
    minEffort === undefined
      ? nearestOfferedLevel(target, offered, defaultRank)
      : (EFFORT_LADDER.slice(EFFORT_LADDER.indexOf(target)).find((level) => offered.has(level)) ??
        null);
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

const QUOTA_RANK_ORDER: Readonly<Record<QuotaFunding, number>> = {
  subscription: 0,
  credits: 1,
  unknown: 2,
  payg: 3,
};

/**
 * The first member that can run this launch, in order or by quota; never a model outside the
 * group. Quota ranks subscriptions with room by pressure, then credits, unknown, pay-as-you-go,
 * and last whatever sits inside the reserve.
 */
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
  const byQuota = input.group.rank === "quota";
  const usable: Array<{
    readonly index: number;
    readonly member: ModelSelection;
    readonly provider: ServerProvider;
    readonly slug: string;
  }> = [];
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
    if (reason !== null || provider === undefined) {
      skipped.push({
        index,
        instanceId: member.instanceId,
        model: member.model,
        reason: reason ?? "instance_missing",
      });
      continue;
    }
    usable.push({
      index,
      member,
      provider,
      slug: findModel(provider, member.model)?.slug ?? member.model,
    });
    if (!byQuota) break;
  }
  const ranked = byQuota
    ? usable
        .map((entry) => {
          const standing = quotaStanding(entry.provider, entry.slug, input.now);
          return {
            entry,
            group: standing.inReserve ? 4 : QUOTA_RANK_ORDER[standing.funding],
            pressure: standing.funding === "subscription" ? standing.pressure : 0,
          };
        })
        .sort((a, b) => a.group - b.group || b.pressure - a.pressure)
        .map(({ entry }) => entry)
    : usable;
  const chosen = ranked[0];
  if (chosen === undefined) return { ok: false, skipped };
  const descriptors = findModel(chosen.provider, chosen.member.model)?.capabilities
    ?.optionDescriptors;
  return {
    ok: true,
    index: chosen.index,
    selection: acceptedOptions(chosen.member, descriptors),
    skipped,
  };
}

/** Cheapest first; Auto takes the cheapest tier at or above the task's and never goes past S. */
const TIER_ORDER: ReadonlyArray<RoutingTier> = ["C", "B", "A", "S"];
// Questions lower effort, not the model: C-tier models trail by 20+ points on read-only Q&A.
const DESIRED_TIER: Readonly<Record<RoutingTaskClass, RoutingTier>> = {
  readonly: "A",
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

// Drivers a gateway like magpie sits behind; OpenCode's `vendor/model` ids bill through OpenCode.
const GATEWAY_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

const isOpaqueRouter = (driver: string, model: string) =>
  OPAQUE_ROUTER_MODELS[driver]?.includes(model) === true;

const FRONTEND =
  /\b(?:UI|CSS|layouts?|buttons?|components?|screenshots?|styles?|styling|frontend|front-end)\b|页面|界面|样式|布局|按钮|组件|截图|前端/i;

/** UI work a screenshot shows; GPT models score with Haiku on screenshot-driven frontend bugs. */
export const isFrontendPrompt = (prompt: string): boolean => FRONTEND.test(prompt);

// Claude 5.5 models and Fable 5.2 reroute these to Opus 4.8 (HN 49901375, 2026-09-29; Theo, 2026-11-11).
const SECURITY =
  /\b(?:security|vulnerab\w*|exploit\w*|CVEs?)\b|\bCVE-\d|漏洞|(?<!类型|线程|并发|内存)安全(?!地)/i;

/** A security or vulnerability prompt, outside pasted code. */
export const isSecurityPrompt = (prompt: string): boolean => SECURITY.test(stripPasted(prompt));

const isTierRow = (row: RoutingTable["rows"][number]) =>
  row.verified === true &&
  row.relativeCost !== undefined &&
  row.model !== "*" &&
  !UNROUTED_DRIVERS.has(row.driver) &&
  !isOpaqueRouter(row.driver, row.model);

type RoutingRow = RoutingTable["rows"][number];

/**
 * The driver's row for a model's ids. Gateways like magpie prefix ids (`auto/<slug>`), so a
 * prefixed id falls back to the row of its last segment, never stripping an effort suffix.
 * `otherDrivers` also takes that slug's tier row on another driver, for tier and cost only, on
 * the drivers a gateway serves.
 */
function modelRow(
  table: RoutingTable,
  driver: string,
  ids: ReadonlyArray<string>,
  otherDrivers = false,
): RoutingRow | undefined {
  const own = (row: RoutingRow) => row.driver === driver && row.model !== "*";
  const exact = table.rows.find((row) => own(row) && ids.includes(row.model));
  if (exact !== undefined) return exact;
  const segments = ids.flatMap((id) =>
    id.includes("/") ? [id.slice(id.lastIndexOf("/") + 1)] : [],
  );
  if (segments.length === 0) return undefined;
  return (
    table.rows.find((row) => own(row) && segments.includes(row.model)) ??
    (otherDrivers && GATEWAY_DRIVERS.has(driver)
      ? table.rows.find((row) => isTierRow(row) && segments.includes(row.model))
      : undefined)
  );
}

type ProviderModel = Pick<ServerProvider["models"][number], "slug" | "aliases">;

const tierRowFor = (table: RoutingTable, driver: string, model: ProviderModel) =>
  modelRow(table, driver, [model.slug, ...(model.aliases ?? [])], true);

/** Every Auto launch has someone waiting on it, so background-only rows are no candidates yet. */
const isCandidateRow = (row: RoutingTable["rows"][number]) =>
  isTierRow(row) && row.backgroundOnly !== true;

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

type QuotaFunding = "subscription" | "credits" | "payg" | "unknown";

interface QuotaStanding {
  readonly funding: QuotaFunding;
  /** The tightest window has no more than the share Auto leaves for the user. */
  readonly inReserve: boolean;
  /** Room above the reserve per hour to the tightest window's reset; higher spends first. */
  readonly pressure: number;
}

const API_KEY_AUTH = /api[-_ ]?key/i;

/** Inferred from the windows a model spends; map the usage source's own kind once it reports one. */
function quotaFunding(
  provider: ServerProvider,
  windows: ReadonlyArray<{ readonly id: string }>,
): QuotaFunding {
  if (windows.length === 0) {
    return provider.auth.type !== undefined && API_KEY_AUTH.test(provider.auth.type)
      ? "payg"
      : "unknown";
  }
  if (provider.driver === "codex" && windows.every((window) => window.id === "individual")) {
    return "credits";
  }
  return "subscription";
}

function quotaStanding(provider: ServerProvider, model: string, now: number): QuotaStanding {
  const windows = applicableUsageWindows(provider, now, model);
  const funding = quotaFunding(provider, windows);
  if (windows.length === 0) return { funding, inReserve: false, pressure: 0 };
  const tightest = windows.reduce((least, window) =>
    window.usedPercent > least.usedPercent ? window : least,
  );
  const remaining = 100 - tightest.usedPercent;
  if (remaining <= QUOTA_RESERVE_PERCENT) return { funding, inReserve: true, pressure: 0 };
  const resetsAt = tightest.resetsAt === undefined ? Number.NaN : Date.parse(tightest.resetsAt);
  const hours = Number.isFinite(resetsAt)
    ? (resetsAt - now) / 3_600_000
    : tightest.windowDurationMins === undefined
      ? FALLBACK_RESET_HOURS
      : tightest.windowDurationMins / 60;
  return {
    funding,
    inReserve: false,
    pressure: (remaining - QUOTA_RESERVE_PERCENT) / Math.max(hours, 1),
  };
}

/** 0 known with room, 1 unknown, 2 known inside the reserve; higher score spends expiring quota first. */
function quotaRank(provider: ServerProvider, model: string, now: number) {
  const standing = quotaStanding(provider, model, now);
  const windowed = standing.funding === "subscription" || standing.funding === "credits";
  return {
    bucket: !windowed ? 1 : standing.inReserve ? 2 : 0,
    score: standing.pressure,
  };
}

export type ModelVendor = "anthropic" | "openai" | "google" | "xai";

/** Who trains a model, by its slug; drivers like Antigravity and Cursor serve several vendors. */
export function modelVendor(driver: string, slug: string): ModelVendor | null {
  const model = slug.slice(slug.lastIndexOf("/") + 1).toLowerCase();
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || /^o\d/.test(model)) return "openai";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("grok-")) return "xai";
  if (driver === "claudeAgent") return "anthropic";
  if (driver === "codex") return "openai";
  return null;
}

/** The vendor of a selection's model, resolving an alias through its instance's model list. */
export function selectionVendor(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ModelVendor | null {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) return null;
  return modelVendor(
    provider.driver,
    findModel(provider, selection.model)?.slug ?? selection.model,
  );
}

type AutoModelSkipReason = RoutingSkipReason | "premium_default" | "image_frontend";

interface AutoModelChoice {
  /** The draft's selection when nothing switches; otherwise the target with no options yet. */
  readonly selection: ModelSelection;
  /** Set when a security prompt kept the thread's model. */
  readonly reason?: "security_prompt";
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
  /**
   * The first message attaches an image of UI work: never move to a GPT model, and outside a
   * review never leave the thread's instance.
   */
  readonly imageFrontend: boolean;
  /** Outside a review, a security prompt keeps the thread's model. */
  readonly securityPrompt?: boolean | undefined;
  /** Instances with an orchestration adapter; others would fail only at dispatch. */
  readonly runnableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  /**
   * A delegated review: another vendor's model, at no lower tier than the parent's, at any cost.
   * A null parent vendor admits any known vendor.
   */
  readonly review?: { readonly parentVendor: ModelVendor | null } | undefined;
  readonly now: number;
}): AutoModelChoice {
  const { current } = input;
  const currentProvider = input.providers.find(
    (provider) => provider.instanceId === current.instanceId,
  );
  const currentModel =
    currentProvider === undefined ? undefined : findModel(currentProvider, current.model);
  const currentSlug = currentModel?.slug ?? current.model;
  const currentLookup =
    currentProvider === undefined
      ? undefined
      : tierRowFor(input.table, currentProvider.driver, currentModel ?? { slug: current.model });
  const currentRow =
    currentLookup !== undefined && isTierRow(currentLookup) ? currentLookup : undefined;
  const currentTier = currentRow?.tierByClass?.[input.taskClass] ?? null;
  const skippedByReason: Partial<Record<AutoModelSkipReason, number>> = {};
  let skipped = 0;
  const keep = (): AutoModelChoice => ({
    selection: current,
    tier: currentTier,
    switched: "none",
    skipped,
    skippedByReason,
  });
  const { review } = input;
  if (
    review === undefined &&
    currentProvider !== undefined &&
    (UNROUTED_DRIVERS.has(currentProvider.driver) ||
      isOpaqueRouter(currentProvider.driver, currentSlug))
  ) {
    return keep();
  }
  if (review === undefined && input.securityPrompt === true) {
    return { ...keep(), reason: "security_prompt" };
  }

  const candidates: Array<{
    readonly provider: ServerProvider;
    readonly slug: string;
    readonly tier: RoutingTier;
    readonly relativeCost: number;
    readonly isCurrent: boolean;
  }> = [];
  for (const row of input.table.rows) {
    const tier = row.tierByClass?.[input.taskClass];
    if (!isCandidateRow(row) || tier === undefined || row.relativeCost === undefined) continue;
    for (const provider of input.providers) {
      if (input.scope === "instance" && provider.instanceId !== current.instanceId) continue;
      const resolves = (candidate: ProviderModel) =>
        tierRowFor(input.table, provider.driver, candidate) === row;
      const exact = findModel(provider, row.model);
      const model = exact !== undefined && resolves(exact) ? exact : provider.models.find(resolves);
      if (model === undefined) continue;
      const isCurrent = provider.instanceId === current.instanceId && model.slug === currentSlug;
      if (input.scope === "provider" && provider.instanceId === current.instanceId && !isCurrent) {
        continue;
      }
      if (review !== undefined) {
        const vendor = modelVendor(provider.driver, model.slug);
        if (isCurrent || vendor === null || vendor === review.parentVendor) continue;
      }
      const reason: AutoModelSkipReason | null =
        memberSkipReason({
          ...input,
          member: { instanceId: provider.instanceId, model: model.slug },
          provider,
          runnableInstanceIds: input.runnableInstanceIds,
        }) ??
        (isCurrent
          ? null
          : premiumByDefault(model.capabilities?.optionDescriptors ?? [])
            ? "premium_default"
            : input.imageFrontend &&
                (modelVendor(provider.driver, model.slug) === "openai" ||
                  (review === undefined && provider.instanceId !== current.instanceId))
              ? "image_frontend"
              : null);
      if (reason !== null) {
        skipped += 1;
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
        continue;
      }
      candidates.push({
        provider,
        slug: model.slug,
        tier,
        relativeCost: row.relativeCost,
        isCurrent,
      });
    }
  }

  if (review !== undefined) {
    const floor = Math.max(
      TIER_ORDER.indexOf(DESIRED_TIER[input.taskClass]),
      currentTier === null ? -1 : TIER_ORDER.indexOf(currentTier),
    );
    const reviewer = candidates
      .filter((candidate) => TIER_ORDER.indexOf(candidate.tier) >= floor)
      .map((candidate) => ({
        candidate,
        ...quotaRank(candidate.provider, candidate.slug, input.now),
      }))
      .sort(
        (a, b) =>
          a.candidate.relativeCost - b.candidate.relativeCost ||
          a.bucket - b.bucket ||
          b.score - a.score,
      )[0]?.candidate;
    if (reviewer === undefined) return keep();
    return {
      selection: { instanceId: reviewer.provider.instanceId, model: reviewer.slug },
      tier: reviewer.tier,
      switched: reviewer.provider.instanceId === current.instanceId ? "model" : "provider",
      skipped,
      skippedByReason,
    };
  }

  // Only hard tasks may move to a pricier model than the thread's, so turning Auto on saves.
  // An unknown current cost can't be undercut, so the thread keeps its model.
  if (input.taskClass !== "hard" && currentRow?.relativeCost === undefined) return keep();
  const ceiling =
    input.taskClass === "hard" || currentRow?.relativeCost === undefined
      ? Number.POSITIVE_INFINITY
      : currentRow.relativeCost;
  const affordable = candidates.filter((candidate) => candidate.relativeCost <= ceiling);
  const tier = TIER_ORDER.slice(TIER_ORDER.indexOf(DESIRED_TIER[input.taskClass])).find((level) =>
    affordable.some((candidate) => candidate.tier === level),
  );
  if (tier === undefined) return keep();
  const ranked = affordable
    .filter((candidate) => candidate.tier === tier)
    .map((candidate) => ({
      candidate,
      onCurrentInstance: candidate.provider.instanceId === current.instanceId ? 0 : 1,
      isCurrent: candidate.isCurrent ? 0 : 1,
      ...quotaRank(candidate.provider, candidate.slug, input.now),
    }))
    // The thread's instance keeps its account; then the cheaper model, then expiring quota.
    .sort(
      (a, b) =>
        a.onCurrentInstance - b.onCurrentInstance ||
        a.candidate.relativeCost - b.candidate.relativeCost ||
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

/**
 * A worker's model for an automatic team, from every ready instance. Cheap takes the cheapest
 * model at the task's tier or above; Balanced the cheapest one tier higher; Best the cheapest at
 * the highest tier on offer. Null when no model in the table can run here.
 */
export function chooseTeamWorkerModel(input: {
  readonly kind: AutoTeamKind;
  readonly table: RoutingTable;
  readonly taskClass: RoutingTaskClass;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly projectId: ProjectId | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly runnableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly now: number;
}): { readonly selection: ModelSelection; readonly tier: RoutingTier } | null {
  const candidates: Array<{
    readonly provider: ServerProvider;
    readonly slug: string;
    readonly tier: RoutingTier;
    readonly relativeCost: number;
  }> = [];
  for (const row of input.table.rows) {
    const tier = row.tierByClass?.[input.taskClass];
    if (!isCandidateRow(row) || tier === undefined || row.relativeCost === undefined) continue;
    for (const provider of input.providers) {
      const resolves = (candidate: ProviderModel) =>
        tierRowFor(input.table, provider.driver, candidate) === row;
      const exact = findModel(provider, row.model);
      const model = exact !== undefined && resolves(exact) ? exact : provider.models.find(resolves);
      if (model === undefined) continue;
      if (premiumByDefault(model.capabilities?.optionDescriptors ?? [])) continue;
      const reason = memberSkipReason({
        ...input,
        member: { instanceId: provider.instanceId, model: model.slug },
        provider,
        runnableInstanceIds: input.runnableInstanceIds,
      });
      if (reason !== null) continue;
      candidates.push({ provider, slug: model.slug, tier, relativeCost: row.relativeCost });
    }
  }
  if (candidates.length === 0) return null;
  const rank = (tier: RoutingTier) => TIER_ORDER.indexOf(tier);
  const desired = rank(DESIRED_TIER[input.taskClass]);
  const available = [...new Set(candidates.map((candidate) => rank(candidate.tier)))].sort(
    (a, b) => a - b,
  );
  const atOrAbove = (floor: number) => available.find((level) => level >= floor);
  const level =
    input.kind === "best"
      ? available.at(-1)
      : input.kind === "balanced"
        ? (atOrAbove(Math.min(desired + 1, rank("S"))) ?? atOrAbove(desired) ?? available.at(-1))
        : (atOrAbove(desired) ?? available.at(-1));
  const chosen = candidates
    .filter((candidate) => rank(candidate.tier) === level)
    .map((candidate) => ({
      candidate,
      ...quotaRank(candidate.provider, candidate.slug, input.now),
    }))
    .sort(
      (a, b) =>
        a.candidate.relativeCost - b.candidate.relativeCost ||
        a.bucket - b.bucket ||
        b.score - a.score,
    )[0]?.candidate;
  return chosen === undefined
    ? null
    : {
        selection: { instanceId: chosen.provider.instanceId, model: chosen.slug },
        tier: chosen.tier,
      };
}

/**
 * Another vendor's model for a read-only look at a failure, on a delegated review's rules, so it
 * never depends on Auto's switches. Null when no other vendor's model qualifies.
 */
export function crossVendorModel(input: {
  readonly table: RoutingTable;
  readonly failing: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  readonly projectId: ProjectId | null;
  readonly runtimeMode: RuntimeMode;
  readonly runnableInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly now: number;
}): ModelSelection | null {
  const choice = chooseAutoModel({
    ...input,
    taskClass: "readonly",
    current: input.failing,
    scope: "any",
    interactionMode: "default",
    imageFrontend: false,
    review: { parentVendor: selectionVendor(input.providers, input.failing) },
  });
  return choice.switched === "none" ? null : choice.selection;
}
