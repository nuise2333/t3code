import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

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
  "question",
  "quick_keyword",
  "default_class",
  "model_row",
  "nearest_level",
  "no_effort_control",
  "no_row",
  "user_choice",
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

const RoutingTableRow = Schema.Struct({
  driver: ProviderDriverKind,
  /** `*` matches any model of the driver. */
  model: TrimmedNonEmptyString,
  effortByClass: Schema.optionalKey(PartialEffortByClass),
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

export const RouteDecision = Schema.Struct({
  taskClass: RoutingTaskClass,
  /** The choice id routing writes to `optionId`; null when it leaves the selection unchanged. */
  effort: Schema.NullOr(RoutingEffort),
  optionId: Schema.optionalKey(TrimmedNonEmptyString),
  /** The value the selection would have used without routing. */
  baseline: Schema.optionalKey(TrimmedNonEmptyString),
  /** False for a shadow decision: recorded, but the launch kept its own selection. */
  applied: Schema.Boolean,
  reasons: Schema.Array(RoutingReason).check(Schema.isMaxLength(4)),
  tableUpdatedAt: Schema.optionalKey(Schema.String),
});
export type RouteDecision = typeof RouteDecision.Type;

export const LaunchRoutingRequest = Schema.Struct({ mode: Schema.Literal("auto") });
export type LaunchRoutingRequest = typeof LaunchRoutingRequest.Type;
