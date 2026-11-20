import {
  Bot,
  type BotChannelArchiveInput,
  type BotChannelAckResult,
  type BotChannelContinueInput,
  type BotChannelCreateInput,
  type BotChannelDetail,
  type BotChannelPostInput,
  type BotChannelPostResult,
  type BotChannelReassignInput,
  type BotChannelResult,
  type BotChannelStopInput,
  type BotChannelSubscribeInput,
  type BotChannelUpdateInput,
  BotError,
  BotId,
  BotMemoryId,
  BOT_LAST_MESSAGE_MAX_CHARS,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MAX_BOT_MEMORIES,
  MAX_BOTS,
  MessageId,
  type BotDeleteInput,
  type BotDeleteResult,
  type BotLastMessage,
  type BotListResult,
  type BotMemory,
  type BotMemoryAddInput,
  type BotMemoryAddResult,
  type BotMemoryDeleteInput,
  type BotMemoryDeleteResult,
  type BotMemorySource,
  type BotOpenChatInput,
  type BotOpenChatResult,
  type BotSetPausedInput,
  type BotSetPausedResult,
  type BotTask,
  type BotTaskStatus,
  type BotUpsertInput,
  type BotUpsertResult,
  type NodeId,
  type OrchestrationV2Run,
  type ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import { makeBotChannels } from "./BotChannels.ts";
import {
  type BotMemoryRow,
  type BotTaskRow,
  type BotThreadIdentity,
  decodeBotRow,
  identityOf,
  memoryFromRow,
  selectBots,
  selectMemories,
  taskFromRow,
} from "./BotDirectory.ts";

const RECENT_TASKS_PER_BOT = 20;
const WATCHDOG_INTERVAL_MS = 5 * 60_000;
/** A working task this quiet is asked for a status report; this long again and it is stopped. */
export const BOT_TASK_QUIET_MS = 20 * 60_000;
/** Events this soon after a nudge are the nudge itself landing, not progress. */
const BOT_TASK_NUDGE_GRACE_MS = 2 * 60_000;

const BOT_TASK_NUDGE_TEXT =
  "[Status check] This task has been quiet for a while. If you are still working, keep going; your final answer is still the task's result. If you are stuck or need a decision, end your turn with what you have and what blocks you.";

export interface BotTaskRecordInput {
  readonly threadId: ThreadId;
  readonly taskId: NodeId;
  readonly botId: BotId;
  readonly requesterThreadId: ThreadId;
  readonly requesterBotId: BotId | null;
  readonly title: string;
  readonly depth: number;
}

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: () => Effect.Effect<BotListResult, BotError>;
    readonly subscribeList: () => Stream.Stream<BotListResult, BotError>;
    readonly upsert: (input: BotUpsertInput) => Effect.Effect<BotUpsertResult, BotError>;
    readonly delete: (input: BotDeleteInput) => Effect.Effect<BotDeleteResult, BotError>;
    /** Pausing stops the bot's running turns and its chat's schedules; resuming restores those schedules. */
    readonly setPaused: (input: BotSetPausedInput) => Effect.Effect<BotSetPausedResult, BotError>;
    /** The bot's own chat, started on first open. */
    readonly openChat: (input: BotOpenChatInput) => Effect.Effect<BotOpenChatResult, BotError>;
    readonly addMemory: (
      input: BotMemoryAddInput & { readonly source?: BotMemorySource },
    ) => Effect.Effect<BotMemoryAddResult & { readonly count: number }, BotError>;
    readonly deleteMemory: (
      input: BotMemoryDeleteInput & { readonly botId?: BotId },
    ) => Effect.Effect<BotMemoryDeleteResult & { readonly count: number }, BotError>;
    readonly identityOf: (threadId: ThreadId) => Effect.Effect<BotThreadIdentity | null, BotError>;
    readonly recordTask: (input: BotTaskRecordInput) => Effect.Effect<void, BotError>;
    /** A shared channel with its latest history, re-sent whenever it changes. */
    readonly subscribeChannel: (
      input: BotChannelSubscribeInput,
    ) => Stream.Stream<BotChannelDetail, BotError>;
    readonly createChannel: (
      input: BotChannelCreateInput,
    ) => Effect.Effect<BotChannelResult, BotError>;
    /** Removing a member stops its pending work in the channel. */
    readonly updateChannel: (
      input: BotChannelUpdateInput,
    ) => Effect.Effect<BotChannelResult, BotError>;
    /** Deleting archives the channel and stops its pending work; restoring reopens it. */
    readonly archiveChannel: (
      input: BotChannelArchiveInput,
    ) => Effect.Effect<BotChannelResult, BotError>;
    /** Assigns the post to the lead, or to the one or two members it mentions. */
    readonly postToChannel: (
      input: BotChannelPostInput,
    ) => Effect.Effect<BotChannelPostResult, BotError>;
    readonly stopChannel: (
      input: BotChannelStopInput,
    ) => Effect.Effect<BotChannelAckResult, BotError>;
    /** Runs a stopped or failed post again with the lead, as a new attempt. */
    readonly continueChannelPost: (
      input: BotChannelContinueInput,
    ) => Effect.Effect<BotChannelAckResult, BotError>;
    readonly reassignChannelPost: (
      input: BotChannelReassignInput,
    ) => Effect.Effect<BotChannelAckResult, BotError>;
  }
>()("t3/bots/BotService") {}

const botError = (message: string, options: { botId?: BotId; cause?: unknown } = {}) =>
  new BotError({
    message,
    ...(options.botId === undefined ? {} : { botId: options.botId }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });

const encodeModelSelectionJson = Schema.encodeSync(
  Schema.fromJsonString(Bot.fields.modelSelection),
);

const now = Effect.map(DateTime.now, (value) => DateTime.formatIso(value));

/** `Ana María` → `ana-maria`; names with no ASCII letters fall back to `bot`. */
export const handleFromName = (name: string): string => {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug === "" ? "bot" : slug;
};

export const uniqueHandle = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base.slice(0, 32 - String(suffix).length - 1)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** One line of at most BOT_LAST_MESSAGE_MAX_CHARS characters. */
export const previewText = (text: string): string => {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length <= BOT_LAST_MESSAGE_MAX_CHARS
    ? line
    : `${chars.slice(0, BOT_LAST_MESSAGE_MAX_CHARS - 1).join("")}…`;
};

const ScheduleIdsJson = Schema.fromJsonString(Schema.Array(ScheduledTaskId));
const decodeScheduleIds = Schema.decodeUnknownEffect(ScheduleIdsJson);
const encodeScheduleIds = Schema.encodeSync(ScheduleIdsJson);

export const taskStatusForRun = (status: OrchestrationV2Run["status"]): BotTaskStatus | null => {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "stopped";
  }
};

/** What the watchdog does to one working task, given how long it has been quiet. */
export const watchdogAction = (input: {
  readonly status: BotTaskStatus;
  readonly nudgedAtMs: number | null;
  readonly lastActivityMs: number;
  readonly nowMs: number;
}): "none" | "nudge" | "stop" => {
  if (input.status !== "working") return "none";
  if (input.nowMs - input.lastActivityMs < BOT_TASK_QUIET_MS) return "none";
  if (
    input.nudgedAtMs === null ||
    input.nudgedAtMs + BOT_TASK_NUDGE_GRACE_MS < input.lastActivityMs
  )
    return "nudge";
  return input.nowMs - input.nudgedAtMs >= BOT_TASK_QUIET_MS ? "stop" : "none";
};

export const layer = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const scheduler = yield* Scheduler.Scheduler;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    // Notifications re-emit the full list; slow subscribers need only the newest dirty signal.
    const changes = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    // Task threads the reactor follows, with the last time each showed activity.
    const lastActivity = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());
    // Bots' own chats as of the last list, so a turn there can refresh its preview.
    const homeThreads = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
    // Launches wait their turn, so two opens of one bot cannot start two chats.
    const launchLock = yield* Semaphore.make(1);

    const uuid = random
      .uuidV4()
      .pipe(Effect.mapError((cause) => botError("Could not generate an id.", { cause })));

    const loadBots = selectBots(sql).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeBotRow)),
      Effect.mapError((cause) => botError("Could not load bots.", { cause })),
    );

    const findBot = Effect.fn("BotService.findBot")(function* (id: BotId) {
      const bots = yield* loadBots;
      const bot = bots.find((candidate) => candidate.id === id);
      if (bot === undefined) return yield* botError("Bot not found.", { botId: id });
      return { bot, bots };
    });

    const list: BotService["Service"]["list"] = Effect.fn("BotService.list")(function* () {
      const bots = yield* loadBots;
      const memories = yield* selectMemories(sql).pipe(
        Effect.mapError((cause) => botError("Could not load bot memories.", { cause })),
      );
      const tasks = yield* sql<BotTaskRow>`
        SELECT thread_id, task_id, bot_id, requester_thread_id, requester_bot_id, title, depth,
          status, nudged_at, created_at, updated_at
        FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY bot_id ORDER BY created_at DESC, thread_id ASC) AS rank
          FROM bot_tasks
        )
        WHERE rank <= ${RECENT_TASKS_PER_BOT}
        ORDER BY created_at DESC, thread_id ASC
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => botError("Could not load bot tasks.", { cause })),
      );
      // A bot-to-bot or system note is not a message the user wrote, so it is skipped.
      const latest = yield* sql<{
        readonly bot_id: string;
        readonly role: string;
        readonly text: string | null;
        readonly created_at: string;
      }>`
        SELECT bots.bot_id, latest.role,
          substr(json_extract(latest.payload_json, '$.text'), 1, 600) AS text, latest.created_at
        FROM bots
        JOIN orchestration_v2_projection_messages AS latest ON latest.message_id = (
          SELECT messages.message_id FROM orchestration_v2_projection_messages AS messages
          WHERE messages.thread_id = bots.home_thread_id
            AND messages.streaming = 0
            AND messages.message_id NOT LIKE 'async-answer:%'
            AND json_extract(messages.payload_json, '$.text') != ''
            AND (
              messages.role = 'assistant'
              OR (
                messages.role = 'user'
                AND COALESCE(json_extract(messages.payload_json, '$.createdBy'), 'user') = 'user'
              )
            )
          ORDER BY messages.created_at DESC, messages.message_id DESC
          LIMIT 1
        )
        WHERE bots.home_thread_id IS NOT NULL
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => botError("Could not load bot messages.", { cause })),
      );
      yield* Ref.set(
        homeThreads,
        new Set(bots.flatMap((bot) => (bot.homeThreadId === null ? [] : [bot.homeThreadId]))),
      );
      const lastMessages: Array<BotLastMessage> = latest.map((row) => ({
        botId: BotId.make(row.bot_id),
        role: row.role === "user" ? "user" : "assistant",
        text: previewText(row.text ?? ""),
        at: row.created_at,
      }));
      return {
        bots,
        memories: memories.map(memoryFromRow),
        tasks: tasks.map(taskFromRow),
        lastMessages,
        channels: yield* botChannels.list(),
      };
    });

    const subscribeList: BotService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading to buffer concurrent changes.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: BotService["Service"]["upsert"] = Effect.fn("BotService.upsert")(
      function* (input) {
        const bots = yield* loadBots;
        const existing =
          input.id === undefined ? undefined : bots.find((bot) => bot.id === input.id);
        if (input.id !== undefined && existing === undefined) {
          return yield* botError("Bot not found.", { botId: input.id });
        }
        if (existing === undefined && bots.length >= MAX_BOTS) {
          return yield* botError(`A team holds at most ${MAX_BOTS} bots.`);
        }
        const taken = new Set(
          bots.filter((bot) => bot.id !== existing?.id).map((bot) => bot.handle),
        );
        const requestedHandle = input.handle ?? existing?.handle;
        if (
          requestedHandle !== undefined &&
          input.handle !== undefined &&
          taken.has(requestedHandle)
        ) {
          return yield* botError(`Another bot already uses @${requestedHandle}.`);
        }
        const handle = requestedHandle ?? uniqueHandle(handleFromName(input.name), taken);
        const keptProjectId =
          input.projectId === null ? undefined : (input.projectId ?? existing?.projectId);
        const projectId: ProjectId =
          keptProjectId ??
          (yield* managedFolders.ensureScratchProject.pipe(
            Effect.map((scratch) => scratch.projectId),
            Effect.mapError((cause) =>
              botError(`${cause.message} Pick a chat project for this bot instead.`, { cause }),
            ),
          ));
        const timestamp = yield* now;
        const id = existing?.id ?? BotId.make(`bot:${yield* uuid}`);
        // A chat belongs to its project; moving the bot starts a new one there.
        const homeThreadId =
          existing !== undefined && existing.projectId === projectId ? existing.homeThreadId : null;
        const bot: Bot = {
          id,
          name: input.name,
          handle,
          title: input.title,
          instructions: input.instructions,
          dispatcher: input.dispatcher,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode ?? existing?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          projectId,
          homeThreadId,
          avatar: input.avatar,
          color: input.color,
          paused: existing?.paused ?? false,
          createdAt: existing?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        const modelSelectionJson = encodeModelSelectionJson(bot.modelSelection);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (bot.dispatcher) {
                yield* sql`UPDATE bots SET dispatcher = 0, updated_at = ${timestamp} WHERE dispatcher = 1 AND bot_id != ${id}`;
              }
              yield* sql`
                INSERT INTO bots (bot_id, name, handle, title, instructions, dispatcher,
                  model_selection_json, runtime_mode, project_id, home_thread_id, avatar, color,
                  created_at, updated_at)
                VALUES (${id}, ${bot.name}, ${bot.handle}, ${bot.title}, ${bot.instructions},
                  ${bot.dispatcher ? 1 : 0}, ${modelSelectionJson}, ${bot.runtimeMode},
                  ${bot.projectId}, ${bot.homeThreadId}, ${bot.avatar}, ${bot.color},
                  ${bot.createdAt}, ${bot.updatedAt})
                ON CONFLICT (bot_id) DO UPDATE SET
                  name = excluded.name,
                  handle = excluded.handle,
                  title = excluded.title,
                  instructions = excluded.instructions,
                  dispatcher = excluded.dispatcher,
                  model_selection_json = excluded.model_selection_json,
                  runtime_mode = excluded.runtime_mode,
                  project_id = excluded.project_id,
                  -- Keep a chat opened since this save read the row; a new project drops it.
                  home_thread_id = CASE WHEN bots.project_id = excluded.project_id
                    THEN bots.home_thread_id ELSE NULL END,
                  avatar = excluded.avatar,
                  color = excluded.color,
                  updated_at = excluded.updated_at
              `;
            }),
          )
          .pipe(
            Effect.mapError((cause) => botError("Could not save the bot.", { botId: id, cause })),
          );
        yield* notifyChanged;
        return { bot };
      },
    );

    const deleteBot: BotService["Service"]["delete"] = Effect.fn("BotService.delete")(
      function* (input) {
        yield* botChannels.removeBot(input.id);
        // Its chat and task threads stay; they are ordinary threads once the bot is gone.
        yield* sql
          .withTransaction(
            sql`DELETE FROM bot_memories WHERE bot_id = ${input.id}`.pipe(
              Effect.andThen(sql`DELETE FROM bot_tasks WHERE bot_id = ${input.id}`),
              Effect.andThen(sql`DELETE FROM bots WHERE bot_id = ${input.id}`),
            ),
          )
          .pipe(
            Effect.mapError((cause) =>
              botError("Could not delete the bot.", { botId: input.id, cause }),
            ),
          );
        yield* notifyChanged;
        return { id: input.id };
      },
    );

    const interruptForPause = Effect.fn("BotService.interruptForPause")(function* (
      bot: Bot,
      threadId: ThreadId,
    ) {
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return;
      yield* threadManagement
        .interruptThread({
          projectId: shell.projectId,
          commandId: CommandId.make(`bot-pause:${yield* uuid}`),
          threadId,
          reason: `${bot.name} was paused.`,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    });

    const setPaused: BotService["Service"]["setPaused"] = Effect.fn("BotService.setPaused")(
      function* (input) {
        const { bot } = yield* findBot(input.id);
        if (bot.paused === input.paused) return { bot };
        const timestamp = yield* now;
        const saveError = (cause: unknown) =>
          botError(`Could not ${input.paused ? "pause" : "resume"} ${bot.name}.`, {
            botId: bot.id,
            cause,
          });
        const stored = yield* sql<{ readonly paused_schedule_ids_json: string }>`
          UPDATE bots SET paused = ${input.paused ? 1 : 0}, updated_at = ${timestamp}
          WHERE bot_id = ${bot.id}
          RETURNING paused_schedule_ids_json
        `.pipe(Effect.mapError(saveError));
        const paused: Bot = { ...bot, paused: input.paused, updatedAt: timestamp };
        if (input.paused) {
          yield* botChannels.stopBot(bot.id);
          const working = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM bot_tasks
            WHERE bot_id = ${bot.id} AND status IN ('working', 'waiting')
          `.pipe(NodeSqliteClient.readOnly, Effect.mapError(saveError));
          const threads = [
            ...(bot.homeThreadId === null ? [] : [bot.homeThreadId]),
            ...working.map((row) => ThreadId.make(row.thread_id)),
          ];
          yield* Effect.forEach(threads, (threadId) => interruptForPause(bot, threadId), {
            discard: true,
          });
          const schedules =
            bot.homeThreadId === null
              ? []
              : (yield* scheduledTasks.list().pipe(Effect.mapError(saveError))).tasks.filter(
                  (task) => task.enabled && task.threadId === bot.homeThreadId,
                );
          const turnedOff = yield* Effect.filter(schedules, (task) =>
            scheduledTasks.setEnabled({ id: task.id, enabled: false }).pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("bots.pause-schedule-failed", { taskId: task.id, cause }).pipe(
                  Effect.as(false),
                ),
              ),
            ),
          );
          yield* sql`
            UPDATE bots SET paused_schedule_ids_json = ${encodeScheduleIds(turnedOff.map((task) => task.id))}
            WHERE bot_id = ${bot.id}
          `.pipe(Effect.mapError(saveError));
        } else {
          const ids = yield* decodeScheduleIds(stored[0]?.paused_schedule_ids_json ?? "[]").pipe(
            Effect.orElseSucceed(() => []),
          );
          yield* sql`UPDATE bots SET paused_schedule_ids_json = '[]' WHERE bot_id = ${bot.id}`.pipe(
            Effect.mapError(saveError),
          );
          // A schedule deleted or changed meanwhile is left as it is.
          yield* Effect.forEach(
            ids,
            (id) =>
              scheduledTasks
                .setEnabled({ id, enabled: true })
                .pipe(Effect.ignoreCause({ log: true })),
            { discard: true },
          );
        }
        yield* notifyChanged;
        return { bot: paused };
      },
    );

    const liveThread = (threadId: ThreadId) =>
      threadManagement.getThreadShell(threadId).pipe(
        Effect.map((thread) => thread !== null && thread.archivedAt === null),
        Effect.orElseSucceed(() => false),
      );

    const launchChat = Effect.fn("BotService.launchChat")(function* (bot: Bot) {
      const launched = yield* threadLaunch
        .launch({
          commandId: CommandId.make(`bot-chat:${bot.id}:${yield* uuid}`),
          projectId: bot.projectId,
          title: bot.avatar.trim() === "" ? bot.name : `${bot.avatar.trim()} ${bot.name}`,
          generateTitle: false,
          modelSelection: bot.modelSelection,
          runtimeMode: bot.runtimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "root" },
          // The bot's brief stands in for a team lead or council prompt.
          agentTeam: null,
          council: null,
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) =>
            botError(`Could not start ${bot.name}'s chat.`, { botId: bot.id, cause }),
          ),
        );
      const timestamp = yield* now;
      yield* sql`UPDATE bots SET home_thread_id = ${launched.threadId}, updated_at = ${timestamp} WHERE bot_id = ${bot.id}`.pipe(
        Effect.mapError((cause) =>
          botError("Could not save the bot's chat.", { botId: bot.id, cause }),
        ),
      );
      yield* notifyChanged;
      return launched.threadId;
    });

    const openChat: BotService["Service"]["openChat"] = Effect.fn("BotService.openChat")(
      function* (input) {
        const existing = yield* findBot(input.id);
        const known = existing.bot.homeThreadId;
        if (known !== null && (yield* liveThread(known))) {
          return { threadId: known, projectId: existing.bot.projectId };
        }
        return yield* launchLock.withPermits(1)(
          Effect.gen(function* () {
            // Another open may have started the chat while this one waited.
            const { bot } = yield* findBot(input.id);
            if (bot.homeThreadId !== null && (yield* liveThread(bot.homeThreadId))) {
              return { threadId: bot.homeThreadId, projectId: bot.projectId };
            }
            return { threadId: yield* launchChat(bot), projectId: bot.projectId };
          }),
        );
      },
    );

    const botChannels = yield* makeBotChannels({
      loadBots,
      openChat,
      listChanged: notifyChanged,
    });

    const countMemories = (botId: BotId) =>
      sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM bot_memories WHERE bot_id = ${botId}`.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError((cause) => botError("Could not count memories.", { botId, cause })),
      );

    const addMemory: BotService["Service"]["addMemory"] = Effect.fn("BotService.addMemory")(
      function* (input) {
        yield* findBot(input.botId);
        const count = yield* countMemories(input.botId);
        if (count >= MAX_BOT_MEMORIES) {
          return yield* botError(
            `This bot already keeps ${MAX_BOT_MEMORIES} memories. Forget one before adding another.`,
            { botId: input.botId },
          );
        }
        const memory: BotMemory = {
          id: BotMemoryId.make(`bot-memory:${yield* uuid}`),
          botId: input.botId,
          text: input.text,
          source: input.source ?? "user",
          createdAt: yield* now,
        };
        yield* sql`
          INSERT INTO bot_memories (memory_id, bot_id, text, source, created_at)
          VALUES (${memory.id}, ${memory.botId}, ${memory.text}, ${memory.source}, ${memory.createdAt})
        `.pipe(
          Effect.mapError((cause) =>
            botError("Could not save the memory.", { botId: input.botId, cause }),
          ),
        );
        yield* notifyChanged;
        return { memory, count: count + 1 };
      },
    );

    const deleteMemory: BotService["Service"]["deleteMemory"] = Effect.fn(
      "BotService.deleteMemory",
    )(function* (input) {
      const rows = yield* sql<BotMemoryRow>`
        SELECT memory_id, bot_id, text, source, created_at FROM bot_memories WHERE memory_id = ${input.id}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => botError("Could not load the memory.", { cause })),
      );
      const row = rows[0];
      // A bot may only forget its own memories.
      if (row === undefined || (input.botId !== undefined && row.bot_id !== input.botId)) {
        return yield* botError("Memory not found.");
      }
      yield* sql`DELETE FROM bot_memories WHERE memory_id = ${input.id}`.pipe(
        Effect.mapError((cause) => botError("Could not delete the memory.", { cause })),
      );
      yield* notifyChanged;
      return { id: input.id, count: yield* countMemories(BotId.make(row.bot_id)) };
    });

    /** The task's status from its thread's latest run; null when the thread cannot be read. */
    const statusFromThread = (threadId: ThreadId) =>
      threadManagement.getThreadRecords(threadId, ["runs"]).pipe(
        Effect.map((records): BotTaskStatus => {
          const latest = records.runs.reduce<OrchestrationV2Run | null>(
            (best, run) => (best === null || run.ordinal > best.ordinal ? run : best),
            null,
          );
          return latest === null ? "working" : (taskStatusForRun(latest.status) ?? "working");
        }),
        Effect.orElseSucceed(() => null),
      );

    /** Writes the status the thread shows now; covers run events this process never saw. */
    const reconcileTask = Effect.fn("BotService.reconcileTask")(function* (threadId: ThreadId) {
      const status = yield* statusFromThread(threadId);
      if (status === null) return null;
      const timestamp = yield* now;
      const changed = yield* sql<{ readonly thread_id: string }>`
        UPDATE bot_tasks SET status = ${status}, updated_at = ${timestamp}
        WHERE thread_id = ${threadId} AND status != ${status}
        RETURNING thread_id
      `;
      if (status !== "working" && status !== "waiting") {
        yield* Ref.update(lastActivity, (map) => {
          const next = new Map(map);
          next.delete(threadId);
          return next;
        });
      }
      if (changed.length > 0) yield* notifyChanged;
      return status;
    });

    const recordTask: BotService["Service"]["recordTask"] = Effect.fn("BotService.recordTask")(
      function* (input) {
        const timestamp = yield* now;
        yield* sql`
          INSERT INTO bot_tasks (thread_id, task_id, bot_id, requester_thread_id, requester_bot_id,
            title, depth, status, nudged_at, created_at, updated_at)
          VALUES (${input.threadId}, ${input.taskId}, ${input.botId}, ${input.requesterThreadId},
            ${input.requesterBotId}, ${input.title}, ${input.depth}, 'working', NULL,
            ${timestamp}, ${timestamp})
          ON CONFLICT (thread_id) DO NOTHING
        `.pipe(Effect.mapError((cause) => botError("Could not record the task.", { cause })));
        const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
        yield* Ref.update(lastActivity, (map) => new Map(map).set(input.threadId, nowMs));
        yield* notifyChanged;
        // The child may have finished before this row existed, when its events were skipped.
        yield* reconcileTask(input.threadId).pipe(
          Effect.mapError((cause) => botError("Could not record the task.", { cause })),
        );
      },
    );

    // Follow task threads' runs so the Bots page shows live status.
    const activeTaskRows = sql<BotTaskRow>`
      SELECT thread_id, task_id, bot_id, requester_thread_id, requester_bot_id, title, depth,
        status, nudged_at, created_at, updated_at
      FROM bot_tasks WHERE status IN ('working', 'waiting')
    `.pipe(NodeSqliteClient.readOnly);

    const startMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
    const restored = yield* activeTaskRows.pipe(Effect.orElseSucceed(() => []));
    // After a restart the clock starts over rather than stopping everything at once.
    yield* Ref.set(
      lastActivity,
      new Map(restored.map((row) => [ThreadId.make(row.thread_id), startMs])),
    );

    const onRunUpdated = Effect.fn("BotService.onRunUpdated")(function* (run: OrchestrationV2Run) {
      const status = taskStatusForRun(run.status);
      if (status === null) return;
      const followed = (yield* Ref.get(lastActivity)).has(run.threadId);
      if (!followed) {
        // A task recorded on another path, or before this process started following it.
        const rows = yield* sql<{
          readonly thread_id: string;
        }>`SELECT thread_id FROM bot_tasks WHERE thread_id = ${run.threadId}`.pipe(
          NodeSqliteClient.readOnly,
        );
        if (rows.length === 0) return;
      }
      const timestamp = yield* now;
      const changed = yield* sql<{ readonly thread_id: string }>`
        UPDATE bot_tasks SET status = ${status}, updated_at = ${timestamp}
        WHERE thread_id = ${run.threadId} AND status != ${status}
        RETURNING thread_id
      `;
      const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
      yield* Ref.update(lastActivity, (map) => {
        const next = new Map(map);
        if (status === "working" || status === "waiting") next.set(run.threadId, nowMs);
        else next.delete(run.threadId);
        return next;
      });
      if (changed.length > 0) yield* notifyChanged;
    });

    // A new turn or a finished one in a bot's own chat changes its preview.
    const onHomeRun = Effect.fn("BotService.onHomeRun")(function* (
      type: "run.created" | "run.updated",
      run: OrchestrationV2Run,
    ) {
      if (!(yield* Ref.get(homeThreads)).has(run.threadId)) return;
      const status = taskStatusForRun(run.status);
      if (type === "run.created" || (status !== "working" && status !== "waiting")) {
        yield* notifyChanged;
      }
    });

    const followEvents = Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      if (event.type === "run.updated" || event.type === "run.created") {
        return onHomeRun(event.type, event.payload).pipe(
          Effect.andThen(onRunUpdated(event.payload)),
          Effect.catchCause((cause) =>
            Effect.logWarning("bots.task-status-failed", { threadId: event.threadId, cause }),
          ),
          Effect.andThen(botChannels.onRun(event.payload)),
        );
      }
      // Any other event on a followed task counts as activity; it stays in memory.
      return Ref.update(lastActivity, (map) => {
        if (!map.has(event.threadId)) return map;
        return new Map(map).set(event.threadId, DateTime.toEpochMillis(event.occurredAt));
      });
    });
    // Startup recovery settles runs before activation, so restored rows are checked once the
    // follower is running rather than waiting for events that already passed.
    const restoredDeliveries = yield* botChannels.openDeliveries;
    yield* forkParked(
      Effect.gen(function* () {
        const follower = yield* Effect.forkChild(followEvents);
        yield* Effect.forEach(restored, (row) =>
          reconcileTask(ThreadId.make(row.thread_id)).pipe(Effect.ignoreCause({ log: true })),
        );
        yield* botChannels.reconcile(restoredDeliveries);
        yield* Fiber.join(follower);
      }),
    );

    const lastScan = yield* Ref.make(startMs);
    const watchdog = Effect.gen(function* () {
      const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
      if (nowMs - (yield* Ref.get(lastScan)) < WATCHDOG_INTERVAL_MS) return;
      yield* Ref.set(lastScan, nowMs);
      const rows = yield* activeTaskRows;
      const activity = yield* Ref.get(lastActivity);
      for (const row of rows) {
        const task: BotTask = taskFromRow(row);
        const action = watchdogAction({
          status: task.status,
          nudgedAtMs: task.nudgedAt === null ? null : Date.parse(task.nudgedAt),
          lastActivityMs: activity.get(task.threadId) ?? startMs,
          nowMs,
        });
        if (action === "none") continue;
        // A run that ended unseen settles here instead of being nudged.
        const status = yield* reconcileTask(task.threadId);
        if (status !== "working") continue;
        const shell = yield* threadManagement
          .getThreadShell(task.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null) continue;
        const key = yield* uuid;
        if (action === "nudge") {
          const sent = yield* threadManagement
            .sendToThread({
              projectId: shell.projectId,
              commandId: CommandId.make(`bot-nudge:${key}`),
              threadId: task.threadId,
              messageId: MessageId.make(`bot-nudge:${key}`),
              text: BOT_TASK_NUDGE_TEXT,
              attachments: [],
              mode: "steer",
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("bots.watchdog-nudge-failed", {
                  threadId: task.threadId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            );
          if (!sent) continue;
          const timestamp = yield* now;
          yield* sql`UPDATE bot_tasks SET nudged_at = ${timestamp} WHERE thread_id = ${task.threadId}`;
        } else {
          yield* threadManagement
            .interruptThread({
              projectId: shell.projectId,
              commandId: CommandId.make(`bot-stall:${key}`),
              threadId: task.threadId,
              reason: "No progress after a status check.",
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
        yield* notifyChanged;
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("bots.watchdog-failed", { cause })));
    yield* scheduler.register("bot-watchdog", watchdog);

    return BotService.of({
      list,
      subscribeList,
      upsert,
      delete: deleteBot,
      setPaused,
      openChat,
      addMemory,
      deleteMemory,
      identityOf: Effect.fn("BotService.identityOf")((threadId: ThreadId) =>
        identityOf(sql, threadId).pipe(
          Effect.mapError((cause) =>
            botError("Could not read the bot for this thread.", { cause }),
          ),
        ),
      ),
      recordTask,
      subscribeChannel: botChannels.subscribe,
      createChannel: botChannels.create,
      updateChannel: botChannels.update,
      archiveChannel: botChannels.archive,
      postToChannel: botChannels.post,
      stopChannel: botChannels.stop,
      continueChannelPost: botChannels.continuePost,
      reassignChannelPost: botChannels.reassign,
    });
  }),
);
