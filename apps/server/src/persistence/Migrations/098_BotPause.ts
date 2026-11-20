import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`;
  // Schedules the pause turned off, so resuming turns back on only those.
  yield* sql`ALTER TABLE bots ADD COLUMN paused_schedule_ids_json TEXT NOT NULL DEFAULT '[]'`;
});
