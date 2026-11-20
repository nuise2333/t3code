import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_channels (
      channel_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lead_bot_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_channel_members (
      channel_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (channel_id, bot_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_channel_members_bot ON bot_channel_members(bot_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_channel_messages (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      author_bot_id TEXT,
      text TEXT NOT NULL,
      status TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_channel_messages_page ON bot_channel_messages(channel_id, created_at, message_id)`;
  // One assignment of a post to a member; `attempt` counts Continue and Reassign retries.
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_channel_deliveries (
      delivery_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      thread_id TEXT,
      thread_message_id TEXT NOT NULL,
      run_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_channel_deliveries_page ON bot_channel_deliveries(channel_id, created_at, delivery_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_channel_deliveries_message ON bot_channel_deliveries(message_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_channel_deliveries_thread_message ON bot_channel_deliveries(thread_message_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_channel_deliveries_run ON bot_channel_deliveries(run_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_bot_channel_deliveries_status ON bot_channel_deliveries(status)`;
});
