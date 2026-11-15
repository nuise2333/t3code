import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInteractionMode,
  ProviderOptionDescriptor,
  RouteDecision,
  RoutingEffort,
  RoutingReason,
  RoutingTable,
  RoutingTaskClass,
} from "@t3tools/contracts";

import {
  getProviderOptionCurrentValue,
  isClaudeUltrathinkPrompt,
  isReasoningSelect,
  withLegacyUltracodeEffort,
} from "./model.ts";

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
    descriptor.options.map((option) => option.id).filter((id) => !injected.has(id)),
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
