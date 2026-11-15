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
const HARD_KEYWORD =
  /\b(?:refactor\w*|migrat\w*|across|upgrad\w*|rewrit\w*|architect\w*)\b|重构|迁移|升级/i;
const QUICK_KEYWORD =
  /\b(?:renam\w*|typos?|bump\w*|tweak\w*|one[- ]line\w*)\b|\bchange\b[^.?!\n]*\bto\b|重命名|改成|错别字/i;
const WRITE_VERB =
  /\b(?:fix|add|implement|change|update|remove|delete|write|create|make|build|edit|replace)\w*\b|修复|实现|添加|删除/i;
const QUESTION =
  /\b(?:why|explain|what|where|how|find|which)\b|[?？]|为什么|解释|在哪|是什么|查找/i;

function countPaths(prompt: string): number {
  const paths = new Set<string>();
  for (const match of prompt.matchAll(PATH_TOKEN)) {
    const token = match[1];
    if (token !== undefined && !/^https?:/i.test(token)) paths.add(token);
  }
  return paths.size;
}

export function classifyTask(input: {
  readonly prompt: string;
  readonly interactionMode: ProviderInteractionMode;
}): { readonly taskClass: RoutingTaskClass; readonly reasons: ReadonlyArray<RoutingReason> } {
  if (input.interactionMode === "plan") return { taskClass: "hard", reasons: ["plan_mode"] };
  const prompt = input.prompt.trim();
  const paths = countPaths(prompt);
  if (paths >= 3) return { taskClass: "hard", reasons: ["many_paths"] };
  if (HARD_KEYWORD.test(prompt)) return { taskClass: "hard", reasons: ["hard_keyword"] };
  if (prompt.length <= 300 && paths <= 1 && QUICK_KEYWORD.test(prompt)) {
    return { taskClass: "quick_edit", reasons: ["quick_keyword"] };
  }
  if (prompt.length <= 400 && !WRITE_VERB.test(prompt) && QUESTION.test(prompt)) {
    return { taskClass: "readonly", reasons: ["question"] };
  }
  return { taskClass: "implement", reasons: ["default_class"] };
}

/** The target if offered, else the nearest lower level, else the nearest higher one up to high. */
function nearestOfferedLevel(
  target: RoutingEffort,
  offered: ReadonlySet<string>,
): RoutingEffort | null {
  const index = EFFORT_LADDER.indexOf(target);
  const order = [...EFFORT_LADDER.slice(0, index + 1).reverse(), ...EFFORT_LADDER.slice(index + 1)];
  return order.find((level) => offered.has(level)) ?? null;
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
  const target = rowEffort ?? table.defaultEffortByClass[classified.taskClass];
  const descriptor = input.descriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return unchanged("no_effort_control");
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  const offered = new Set(
    descriptor.options.map((option) => option.id).filter((id) => !injected.has(id)),
  );
  const effort = nearestOfferedLevel(target, offered);
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
