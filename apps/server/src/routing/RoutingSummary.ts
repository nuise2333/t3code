import {
  RoutingTaskClass,
  type RoutingSummaryInput,
  type RoutingSummaryResult,
  type RoutingSummaryRow,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

interface SummaryRow {
  readonly task_class: string | null;
  readonly threads: number;
  readonly effort_changed: number | null;
  readonly effort_shadow: number | null;
  readonly model_switched: number | null;
  readonly model_shadow: number | null;
  readonly group_launches: number | null;
}

const isTaskClass = Schema.is(RoutingTaskClass);

export class RoutingSummary extends Context.Service<
  RoutingSummary,
  {
    /** Launch decisions of live threads created in the window, by task class. */
    readonly read: (input: RoutingSummaryInput) => Effect.Effect<RoutingSummaryResult>;
  }
>()("t3/routing/RoutingSummary") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const read = Effect.fn("RoutingSummary.read")(function* (input: RoutingSummaryInput) {
    const since = DateTime.formatIso(
      DateTime.subtractDuration(yield* DateTime.now, Duration.days(input.days)),
    );
    const rows = yield* sql<SummaryRow>`
      WITH decisions AS (
        SELECT json_extract(payload_json, '$.routing') AS r
        FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
          AND created_at >= ${since}
          AND json_extract(payload_json, '$.routing') IS NOT NULL
      ),
      flags AS (
        SELECT
          json_extract(r, '$.taskClass') AS task_class,
          json_extract(r, '$.effort') IS NOT NULL
            AND json_extract(r, '$.effort') IS NOT json_extract(r, '$.baseline') AS effort_moved,
          json_extract(r, '$.applied') = 1 AS applied,
          json_extract(r, '$.model.switched') IN ('model', 'provider') AS model_moved,
          json_extract(r, '$.model.applied') = 1 AS model_applied,
          json_extract(r, '$.group') IS NOT NULL AS grouped
        FROM decisions
      )
      SELECT
        task_class,
        COUNT(*) AS threads,
        SUM(effort_moved AND applied) AS effort_changed,
        SUM(effort_moved AND NOT applied) AS effort_shadow,
        SUM(model_moved AND model_applied) AS model_switched,
        SUM(model_moved AND NOT model_applied) AS model_shadow,
        SUM(grouped) AS group_launches
      FROM flags
      GROUP BY task_class
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch((cause) =>
        Effect.logWarning("Routing summary query failed; none is shown.", cause).pipe(
          Effect.as([] as ReadonlyArray<SummaryRow>),
        ),
      ),
    );
    return {
      rows: RoutingTaskClass.literals.flatMap((taskClass): ReadonlyArray<RoutingSummaryRow> => {
        const row = rows.find((entry) => entry.task_class === taskClass);
        if (row === undefined || !isTaskClass(row.task_class)) return [];
        return [
          {
            taskClass,
            threads: row.threads,
            effortChanged: row.effort_changed ?? 0,
            effortShadow: row.effort_shadow ?? 0,
            modelSwitched: row.model_switched ?? 0,
            modelShadow: row.model_shadow ?? 0,
            groupLaunches: row.group_launches ?? 0,
          },
        ];
      }),
    };
  });

  return RoutingSummary.of({ read });
});

export const layer = Layer.effect(RoutingSummary, make);
