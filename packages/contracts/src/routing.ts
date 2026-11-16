import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** Auto routing never picks a level above high; higher levels stay a manual choice. */
export const RoutingEffort = Schema.Literals(["low", "medium", "high"]);
export type RoutingEffort = typeof RoutingEffort.Type;

export const RoutingTaskClass = Schema.Literals(["readonly", "quick_edit", "implement", "hard"]);
export type RoutingTaskClass = typeof RoutingTaskClass.Type;

/** Short codes; clients render the words, so a decision stays a few hundred bytes. */
export const RoutingReason = Schema.Literals([
  "plan_mode",
  "many_paths",
  "hard_keyword",
  "debug_keyword",
  "question",
  "quick_keyword",
  "default_class",
  "model_row",
  "nearest_level",
  "no_effort_control",
  "no_row",
  "user_choice",
  "security_prompt",
]);
export type RoutingReason = typeof RoutingReason.Type;

const EffortByClass = Schema.Struct({
  readonly: RoutingEffort,
  quick_edit: RoutingEffort,
  implement: RoutingEffort,
  hard: RoutingEffort,
});

const PartialEffortByClass = Schema.Struct({
  readonly: Schema.optionalKey(RoutingEffort),
  quick_edit: Schema.optionalKey(RoutingEffort),
  implement: Schema.optionalKey(RoutingEffort),
  hard: Schema.optionalKey(RoutingEffort),
});

/** Coarse benchmark tiers, cheapest last; S is the highest. */
export const RoutingTier = Schema.Literals(["S", "A", "B", "C"]);
export type RoutingTier = typeof RoutingTier.Type;

const PartialTierByClass = Schema.Struct({
  readonly: Schema.optionalKey(RoutingTier),
  quick_edit: Schema.optionalKey(RoutingTier),
  implement: Schema.optionalKey(RoutingTier),
  hard: Schema.optionalKey(RoutingTier),
});

const RoutingTableRow = Schema.Struct({
  driver: ProviderDriverKind,
  /** `*` matches any model of the driver. */
  model: TrimmedNonEmptyString,
  effortByClass: Schema.optionalKey(PartialEffortByClass),
  /** A class left out has no agreed evidence, so the model is no candidate for it. */
  tierByClass: Schema.optionalKey(PartialTierByClass),
  /** Cheaper is lower; each step is about double the cost of a task. */
  relativeCost: Schema.optionalKey(NonNegativeInt),
  /** Whether changing effort keeps the prompt cache, per channel; a missing key is unknown. */
  effortChangeKeepsCache: Schema.optionalKey(
    Schema.Struct({
      direct: Schema.optionalKey(Schema.Boolean),
      bedrock: Schema.optionalKey(Schema.Boolean),
      customEndpoint: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  /** Only verified rows with an exact model, a relative cost and a class's tier are candidates. */
  verified: Schema.optionalKey(Schema.Boolean),
  /** Too slow for a launch someone waits on; its tiers wait for unattended routing. */
  backgroundOnly: Schema.optionalKey(Schema.Boolean),
  sourceIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});

const RoutingTableEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.String,
  sources: Schema.Record(
    Schema.String,
    Schema.Struct({ url: TrimmedNonEmptyString, dataDate: TrimmedNonEmptyString }),
  ),
  defaultEffortByClass: EffortByClass,
  rows: Schema.Array(RoutingTableRow),
});

const hasValidRoutingRows = (table: typeof RoutingTableEnvelope.Type): boolean => {
  const keys = new Set<string>();
  return table.rows.every((row) => {
    const key = `${row.driver}\u0000${row.model}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return row.sourceIds.every((id) => table.sources[id] !== undefined);
  });
};

export const RoutingTable = RoutingTableEnvelope.pipe(
  Schema.check(
    Schema.makeFilter(hasValidRoutingRows, {
      expected: "unique driver and model rows that cite existing sources",
    }),
  ),
);
export type RoutingTable = typeof RoutingTable.Type;

export const RoutingGroupId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);
export type RoutingGroupId = typeof RoutingGroupId.Type;

export const MAX_ROUTING_GROUPS = 16;
export const MAX_ROUTING_GROUP_MEMBERS = 8;

/** An ordered list of selections; a launch takes the first member that can run it, or by quota. */
export const RoutingGroup = Schema.Struct({
  /** Stable once created; a rename changes only `name`. */
  id: RoutingGroupId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  members: Schema.Array(ModelSelection).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ROUTING_GROUP_MEMBERS),
  ),
  strategy: Schema.Literal("order"),
  /** Not a strategy value: older clients drop groups with an unknown strategy, then save the list. */
  rank: Schema.optionalKey(Schema.Literals(["order", "quota"])),
});
export type RoutingGroup = typeof RoutingGroup.Type;

/** Group ids by task class; consulted only for launches that ask for Auto. */
export const RoutingGroupRules = Schema.Struct({
  readonly: Schema.optionalKey(RoutingGroupId),
  quick_edit: Schema.optionalKey(RoutingGroupId),
  implement: Schema.optionalKey(RoutingGroupId),
  hard: Schema.optionalKey(RoutingGroupId),
});
export type RoutingGroupRules = typeof RoutingGroupRules.Type;

export const RoutingSkipReason = Schema.Literals([
  "instance_missing",
  "instance_disabled",
  "not_ready",
  "project_disabled",
  "model_unavailable",
  "usage_exhausted",
  "runtime_mode",
  "plan_unsupported",
]);
export type RoutingSkipReason = typeof RoutingSkipReason.Type;

const RouteGroupMember = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});

export const RouteGroupDecision = Schema.Struct({
  id: RoutingGroupId,
  /** The name at launch, so a later rename or delete keeps the thread's label. */
  name: TrimmedNonEmptyString,
  via: Schema.Literals(["picker", "rule"]),
  rank: Schema.optionalKey(Schema.Literal("quota")),
  chosen: NonNegativeInt,
  /** Members as they were at launch, so later group edits do not relabel this thread. */
  member: RouteGroupMember,
  skipped: Schema.Array(
    Schema.Struct({ ...RouteGroupMember.fields, index: NonNegativeInt, reason: RoutingSkipReason }),
  ).check(Schema.isMaxLength(MAX_ROUTING_GROUP_MEMBERS)),
});
export type RouteGroupDecision = typeof RouteGroupDecision.Type;

/** What Auto picked for the model at launch; a shadow when switching is off. */
export const RouteModelDecision = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  tier: Schema.NullOr(RoutingTier),
  switched: Schema.Literals(["none", "model", "provider"]),
  /** False for a shadow choice: what Auto would have launched with switching on. */
  applied: Schema.Boolean,
  /** Candidates the hard filters removed, as a count; reasons stay out of thread payloads. */
  skipped: NonNegativeInt,
  /** The draft's model, only when the switch was applied. */
  from: Schema.optionalKey(RouteGroupMember),
  /** Set when a screenshot of UI work kept GPT models and other instances out of the candidates. */
  reason: Schema.optionalKey(Schema.Literal("image_frontend")),
});
export type RouteModelDecision = typeof RouteModelDecision.Type;

export const RouteDecision = Schema.Struct({
  taskClass: RoutingTaskClass,
  /** A delegated task's role that picked the model; older clients drop the key. */
  role: Schema.optionalKey(Schema.Literals(["research", "review"])),
  /** The choice id routing writes to `optionId`; null when it leaves the selection unchanged. */
  effort: Schema.NullOr(RoutingEffort),
  optionId: Schema.optionalKey(TrimmedNonEmptyString),
  /** The value the selection would have used without routing. */
  baseline: Schema.optionalKey(TrimmedNonEmptyString),
  /** False for a shadow decision: recorded, but the launch kept its own selection. */
  applied: Schema.Boolean,
  reasons: Schema.Array(RoutingReason).check(Schema.isMaxLength(5)),
  tableUpdatedAt: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(RouteGroupDecision),
  model: Schema.optionalKey(RouteModelDecision),
});
export type RouteDecision = typeof RouteDecision.Type;

export const LaunchRoutingRequest = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("auto"),
    /** Sent only by a draft whose user did not pick its model; without it Auto keeps the model. */
    model: Schema.optionalKey(Schema.Literal("auto")),
  }),
  Schema.Struct({ mode: Schema.Literal("group"), groupId: RoutingGroupId }),
]);
export type LaunchRoutingRequest = typeof LaunchRoutingRequest.Type;
