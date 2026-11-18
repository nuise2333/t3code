import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RoutingSummary from "./RoutingSummary.ts";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");

it.effect("counts each task class's applied and shadow decisions inside the window", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const sql = yield* SqlClient.SqlClient;
    const insert = (
      id: string,
      routing: object | undefined,
      options: { readonly createdAt?: string; readonly deleted?: boolean } = {},
    ) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at, payload_json
      ) VALUES (
        ${id}, 'project-1', 'Thread', 'codex', 'full-access', 'default',
        ${options.createdAt ?? "2026-11-15T00:00:00.000Z"}, '2026-11-15T00:00:00.000Z',
        ${options.deleted ? "2026-11-15T01:00:00.000Z" : null},
        ${JSON.stringify(routing === undefined ? {} : { routing })}
      )
    `;
    const decision = (fields: object) => ({
      taskClass: "readonly",
      effort: "medium",
      baseline: "high",
      applied: true,
      reasons: [],
      ...fields,
    });
    yield* insert("applied", decision({}));
    yield* insert("shadow", decision({ applied: false }));
    yield* insert("unchanged", decision({ baseline: "medium" }));
    yield* insert(
      "switched",
      decision({
        model: { instanceId: "c", model: "m", tier: "C", switched: "model", applied: true },
      }),
    );
    yield* insert(
      "model-shadow",
      decision({
        taskClass: "implement",
        effort: null,
        model: { instanceId: "c", model: "m", tier: "A", switched: "provider", applied: false },
      }),
    );
    yield* insert(
      "grouped",
      decision({ taskClass: "implement", effort: null, group: { id: "office" } }),
    );
    yield* insert("manual", undefined);
    yield* insert("old", decision({}), { createdAt: "2026-10-01T00:00:00.000Z" });
    yield* insert("deleted", decision({}), { deleted: true });

    const summary = yield* RoutingSummary.RoutingSummary;
    const { rows } = yield* summary.read({ days: 30 });
    assert.deepEqual(rows, [
      {
        taskClass: "readonly",
        threads: 4,
        effortChanged: 2,
        effortShadow: 1,
        modelSwitched: 1,
        modelShadow: 0,
        groupLaunches: 0,
      },
      {
        taskClass: "implement",
        threads: 2,
        effortChanged: 0,
        effortShadow: 0,
        modelSwitched: 0,
        modelShadow: 1,
        groupLaunches: 1,
      },
    ]);
  }).pipe(
    Effect.provide(RoutingSummary.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
