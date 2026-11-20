import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      handle TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      dispatcher INTEGER NOT NULL DEFAULT 0,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      project_id TEXT NOT NULL,
      home_thread_id TEXT,
      avatar TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_memories (
      memory_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_memories_bot ON bot_memories(bot_id, created_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_tasks (
      thread_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      requester_thread_id TEXT NOT NULL,
      requester_bot_id TEXT,
      title TEXT NOT NULL,
      depth INTEGER NOT NULL,
      status TEXT NOT NULL,
      nudged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_tasks_status ON bot_tasks(status, updated_at)`;
});
