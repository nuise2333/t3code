import {
  Bot,
  BotId,
  BotMemoryId,
  BOT_MAX_DELEGATION_DEPTH,
  type BotMemory,
  type BotTask,
  NodeId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export interface BotRow {
  readonly bot_id: string;
  readonly name: string;
  readonly handle: string;
  readonly title: string;
  readonly instructions: string;
  readonly dispatcher: number;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly project_id: string;
  readonly home_thread_id: string | null;
  readonly avatar: string;
  readonly color: string;
  readonly paused: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BotMemoryRow {
  readonly memory_id: string;
  readonly bot_id: string;
  readonly text: string;
  readonly source: string;
  readonly created_at: string;
}

export interface BotTaskRow {
  readonly thread_id: string;
  readonly task_id: string;
  readonly bot_id: string;
  readonly requester_thread_id: string;
  readonly requester_bot_id: string | null;
  readonly title: string;
  readonly depth: number;
  readonly status: string;
  readonly nudged_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const decodeBot = Schema.decodeUnknownEffect(Bot);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Bot.fields.modelSelection),
);

export const decodeBotRow = Effect.fn("BotDirectory.decodeBotRow")(function* (row: BotRow) {
  const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
  return yield* decodeBot({
    id: row.bot_id,
    name: row.name,
    handle: row.handle,
    title: row.title,
    instructions: row.instructions,
    dispatcher: row.dispatcher === 1,
    modelSelection,
    runtimeMode: row.runtime_mode,
    projectId: row.project_id,
    homeThreadId: row.home_thread_id,
    avatar: row.avatar,
    color: row.color,
    paused: row.paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

export const memoryFromRow = (row: BotMemoryRow): BotMemory => ({
  id: BotMemoryId.make(row.memory_id),
  botId: BotId.make(row.bot_id),
  text: row.text,
  source: row.source === "user" ? "user" : "bot",
  createdAt: row.created_at,
});

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "working",
  "waiting",
  "done",
  "failed",
  "stopped",
]);

export const taskFromRow = (row: BotTaskRow): BotTask => ({
  threadId: ThreadId.make(row.thread_id),
  taskId: NodeId.make(row.task_id),
  botId: BotId.make(row.bot_id),
  requesterThreadId: ThreadId.make(row.requester_thread_id),
  requesterBotId: row.requester_bot_id === null ? null : BotId.make(row.requester_bot_id),
  title: row.title,
  depth: row.depth,
  status: TASK_STATUSES.has(row.status) ? (row.status as BotTask["status"]) : "working",
  nudgedAt: row.nudged_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Which bot a thread runs as: its own chat, or a task another bot handed it. */
export type BotThreadIdentity =
  | { readonly kind: "home"; readonly bot: Bot; readonly depth: 0 }
  | {
      readonly kind: "task";
      readonly bot: Bot;
      readonly depth: number;
      readonly task: BotTask;
    };

export const selectBots = (sql: SqlClient.SqlClient) =>
  sql<BotRow>`
    SELECT bot_id, name, handle, title, instructions, dispatcher, model_selection_json,
      runtime_mode, project_id, home_thread_id, avatar, color, paused, created_at, updated_at
    FROM bots
    ORDER BY dispatcher DESC, created_at ASC, bot_id ASC
  `.pipe(NodeSqliteClient.readOnly);

export const selectMemories = (sql: SqlClient.SqlClient) =>
  sql<BotMemoryRow>`
    SELECT memory_id, bot_id, text, source, created_at
    FROM bot_memories
    ORDER BY created_at ASC, memory_id ASC
  `.pipe(NodeSqliteClient.readOnly);

/**
 * Reads straight from the bot tables so session setup and turn start can ask
 * without depending on BotService. A database without them answers "not a bot".
 */
export const identityOf = Effect.fn("BotDirectory.identityOf")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const home = yield* sql<BotRow>`
    SELECT bot_id, name, handle, title, instructions, dispatcher, model_selection_json,
      runtime_mode, project_id, home_thread_id, avatar, color, paused, created_at, updated_at
    FROM bots WHERE home_thread_id = ${threadId}
  `.pipe(NodeSqliteClient.readOnly);
  if (home[0] !== undefined) {
    const bot = yield* decodeBotRow(home[0]);
    const identity: BotThreadIdentity = { kind: "home", bot, depth: 0 };
    return identity;
  }
  const tasks = yield* sql<BotTaskRow & BotRow>`
    SELECT t.thread_id, t.task_id, t.bot_id, t.requester_thread_id, t.requester_bot_id, t.title,
      t.depth, t.status, t.nudged_at, t.created_at, t.updated_at,
      b.name, b.handle, b.title AS bot_title, b.instructions, b.dispatcher, b.model_selection_json,
      b.runtime_mode, b.project_id, b.home_thread_id, b.avatar, b.color, b.paused,
      b.created_at AS bot_created_at, b.updated_at AS bot_updated_at
    FROM bot_tasks t JOIN bots b ON b.bot_id = t.bot_id
    WHERE t.thread_id = ${threadId}
  `.pipe(NodeSqliteClient.readOnly);
  const row = tasks[0] as
    | (BotTaskRow &
        BotRow & {
          readonly bot_title: string;
          readonly bot_created_at: string;
          readonly bot_updated_at: string;
        })
    | undefined;
  if (row === undefined) return null;
  const bot = yield* decodeBotRow({
    ...row,
    title: row.bot_title,
    created_at: row.bot_created_at,
    updated_at: row.bot_updated_at,
  });
  const task = taskFromRow(row);
  const identity: BotThreadIdentity = { kind: "task", bot, depth: task.depth, task };
  return identity;
});

/** Null for any thread that is not a bot's, including when the tables are missing. */
export const identityOrNull = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  identityOf(sql, threadId).pipe(Effect.orElseSucceed(() => null));

const BRIEF_MEMORY_CHARS = 6_000;

const ROSTER_DUTY_CHARS = 120;

/** What a teammate does: its title, or the start of its instructions when it has none. */
const duty = (bot: Bot): string => {
  const title = bot.title.trim();
  if (title !== "") return title;
  const first = bot.instructions.trim().split("\n")[0]?.trim() ?? "";
  return first.length > ROSTER_DUTY_CHARS ? `${first.slice(0, ROSTER_DUTY_CHARS - 1)}…` : first;
};

const roster = (bots: ReadonlyArray<Bot>, self: Bot, inTask: boolean): string => {
  // A task answers whoever asked, so its roster leaves out the dispatcher.
  const others = bots.filter((bot) => bot.id !== self.id && !(inTask && bot.dispatcher));
  if (others.length === 0) return "No teammates yet.";
  return others
    .map((bot) => {
      const job = duty(bot);
      const note = bot.paused
        ? " (paused; unavailable, do not message it)"
        : bot.dispatcher
          ? " (dispatcher; a message to it gets no reply)"
          : "";
      return `- @${bot.handle}: ${bot.name}${job === "" ? "" : `, ${job}`}${note}`;
    })
    .join("\n");
};

const memoryLines = (memories: ReadonlyArray<BotMemory>): string => {
  if (memories.length === 0) return "None yet.";
  const lines: Array<string> = [];
  let used = 0;
  // Newest first, so a long list keeps what was learned last.
  for (const memory of [...memories].reverse()) {
    const line = `- [${memory.id}] ${memory.text}`;
    if (used + line.length > BRIEF_MEMORY_CHARS) break;
    used += line.length + 1;
    lines.push(line);
  }
  return lines.reverse().join("\n");
};

const roleRules = (input: {
  readonly bot: Bot;
  readonly bots: ReadonlyArray<Bot>;
  readonly task: { readonly requester: string; readonly depth: number } | null;
}): string => {
  const teammates = input.bots.filter(
    (bot) => bot.id !== input.bot.id && !bot.paused && !(input.task !== null && bot.dispatcher),
  );
  const canDelegate =
    teammates.length > 0 && (input.task === null || input.task.depth < BOT_MAX_DELEGATION_DEPTH);
  const delegation = canDelegate
    ? "To hand work to a teammate, call `bot_send_message` with everything they need: they see none of this chat. A teammate's result comes back here on its own; do not wait for it or poll it, and end your turn when nothing else is left."
    : "Handing work to teammates is not available here.";
  if (input.task !== null) {
    return [
      `This chat is a task ${input.task.requester} handed you. Do it yourself, in the checkout they work in. Your final answer is the result they get back: lead with it. Do not message anyone else with the result.`,
      "If you are blocked or need a decision, say so plainly in your final answer instead of guessing.",
      delegation,
    ].join("\n");
  }
  if (input.bot.dispatcher && input.bots.length > 1) {
    return [
      "You are the team's dispatcher. Split the user's request and hand each piece to the teammate whose job fits it. Do the work yourself only when no teammate fits or the user asks you to.",
      "Tasks run in this chat's project and checkout. After sending, tell the user in a line or two who has what and end your turn. Results arrive in this chat as task completions: relay them to the user, and send follow-up work when a result needs it.",
      delegation,
    ].join("\n");
  }
  return [
    "This is your own chat with the user. Do the work yourself; hand a piece to a teammate only when it is clearly their job.",
    delegation,
  ].join("\n");
};

/** The `<t3_code_bot>` block: who the bot is, what it remembers, who its teammates are. */
export const botBrief = (input: {
  readonly bot: Bot;
  readonly bots: ReadonlyArray<Bot>;
  readonly memories: ReadonlyArray<BotMemory>;
  readonly task: { readonly requester: string; readonly depth: number } | null;
}): string => {
  const { bot } = input;
  const title = bot.title.trim() === "" ? "" : `, ${bot.title.trim()}`;
  const instructions = bot.instructions.trim();
  return [
    "<t3_code_bot>",
    `You are ${bot.name} (@${bot.handle})${title}, one of the user's bots in T3 Code.`,
    instructions === "" ? null : `Your instructions from the user:\n${instructions}`,
    `Your memories (\`bot_remember\` saves one durable fact or lesson for later chats; \`bot_forget\` removes one by id):\n${memoryLines(input.memories)}`,
    `Your team:\n${roster(input.bots, bot, input.task !== null)}`,
    roleRules(input),
    "</t3_code_bot>",
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
};

/** The brief for a bot's own chat, or null when the thread is not one. */
export const homeBriefFor = Effect.fn("BotDirectory.homeBriefFor")(
  function* (sql: SqlClient.SqlClient, threadId: ThreadId) {
    const identity = yield* identityOrNull(sql, threadId);
    if (identity === null || identity.kind !== "home") return null;
    const bots = yield* selectBots(sql).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeBotRow)),
    );
    const memories = yield* sql<BotMemoryRow>`
    SELECT memory_id, bot_id, text, source, created_at
    FROM bot_memories WHERE bot_id = ${identity.bot.id}
    ORDER BY created_at ASC, memory_id ASC
  `.pipe(NodeSqliteClient.readOnly);
    return botBrief({ bot: identity.bot, bots, memories: memories.map(memoryFromRow), task: null });
  },
  Effect.orElseSucceed(() => null),
);

/** Session setup asks this to grant bot tools to a bot's threads and the tasks they start. */
export const runsAsBot = Effect.fn("BotDirectory.runsAsBot")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  parentThreadId: ThreadId | null,
) {
  if ((yield* identityOrNull(sql, threadId)) !== null) return true;
  if (parentThreadId === null) return false;
  return (yield* identityOrNull(sql, parentThreadId)) !== null;
});
