import {
  type Bot,
  type BotChannel,
  type BotChannelArchiveInput,
  type BotChannelContinueInput,
  type BotChannelCreateInput,
  type BotChannelDetail,
  BotChannelId,
  type BotChannelMessage,
  BotChannelMessageId,
  type BotChannelPostInput,
  type BotChannelPostResult,
  type BotChannelReassignInput,
  type BotChannelResult,
  type BotChannelStopInput,
  type BotChannelSubscribeInput,
  type BotChannelUpdateInput,
  type BotChannelWorkStatus,
  BotError,
  BotId,
  type BotOpenChatInput,
  type BotOpenChatResult,
  BOT_CHANNEL_HISTORY_PAGE,
  BOT_CHANNEL_MAX_RECIPIENTS,
  BOT_CHANNEL_NAME_MAX_CHARS,
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** Posts and replies each assignment carries as context, and how much of each. */
const HISTORY_CONTEXT = 8;
const HISTORY_CHARS = 600;

interface ChannelRow {
  readonly channel_id: string;
  readonly name: string;
  readonly lead_bot_id: string | null;
  readonly archived: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly channel_id: string;
  readonly message_id: string;
  readonly bot_id: string;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly status: string;
}

const OPEN_STATUSES = ["queued", "in_progress"] as const;

const workStatus = (status: string | null): BotChannelWorkStatus | null => {
  switch (status) {
    case "queued":
    case "in_progress":
    case "completed":
    case "failed":
    case "stopped":
      return status;
    default:
      return null;
  }
};

/** `#Launch ` → `Launch`; null when empty, too long or holding control characters. */
export const cleanChannelName = (raw: string): string | null => {
  const name = raw.trim().replace(/^#+/, "").trim();
  // Names are one plain line.
  if (
    name === "" ||
    [...name].length > BOT_CHANNEL_NAME_MAX_CHARS ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    return null;
  }
  return name;
};

/** Mentions win; with none the lead takes the post. At most two mentioned members run it. */
export const routeRecipients = (
  memberIds: ReadonlyArray<BotId>,
  leadBotId: BotId | null,
  requested: ReadonlyArray<BotId>,
): { readonly recipients: ReadonlyArray<BotId> } | { readonly error: string } => {
  if (requested.length === 0) {
    return leadBotId === null
      ? { error: "Add a bot in channel settings before posting." }
      : { recipients: [leadBotId] };
  }
  if (requested.length > BOT_CHANNEL_MAX_RECIPIENTS) {
    return { error: "Mention up to two bots in one post." };
  }
  if (requested.some((id) => !memberIds.includes(id))) {
    return { error: "Choose bots that belong to this channel." };
  }
  return { recipients: [...new Set(requested)] };
};

/**
 * A post's status from its assignments. A stop or failure is superseded by any later attempt
 * (Continue or Reassign), and a post left with no assignments is stopped so it can be continued.
 */
export const postStatus = (
  deliveries: ReadonlyArray<{ readonly status: BotChannelWorkStatus; readonly attempt: number }>,
): BotChannelWorkStatus => {
  if (deliveries.length === 0) return "stopped";
  const latest = Math.max(...deliveries.map((delivery) => delivery.attempt));
  const statuses = new Set(
    deliveries
      .filter(
        (delivery) =>
          delivery.attempt === latest ||
          (delivery.status !== "stopped" && delivery.status !== "failed"),
      )
      .map((delivery) => delivery.status),
  );
  for (const status of ["in_progress", "queued", "failed", "stopped"] as const) {
    if (statuses.has(status)) return status;
  }
  return "completed";
};

const deliveryStatusForRun = (status: OrchestrationV2Run["status"]): BotChannelWorkStatus => {
  switch (status) {
    case "queued":
      return "queued";
    case "preparing":
    case "starting":
    case "running":
    case "waiting":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "stopped";
  }
};

/** The post, then the channel's latest other posts and replies, so the bot builds on them. */
export const assignmentText = (
  channelName: string,
  text: string,
  history: ReadonlyArray<{ readonly author: string; readonly text: string }>,
): string => {
  const head = `Work requested in #${channelName}:\n\n${text}`;
  if (history.length === 0) return head;
  const lines = history.map((entry) => {
    const flat = entry.text.replace(/\s+/g, " ").trim();
    const chars = [...flat];
    const clipped =
      chars.length > HISTORY_CHARS ? `${chars.slice(0, HISTORY_CHARS).join("")}…` : flat;
    return `- ${entry.author}: ${clipped}`;
  });
  return `${head}\n\nRecent messages in #${channelName} (context, oldest first):\n${lines.join("\n")}`;
};

/** The run's last non-empty assistant message: what the bot answered. */
const finalAssistantText = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
  runId: RunId,
): string => {
  const item = projection.turnItems
    .filter(
      (candidate) =>
        candidate.runId === runId &&
        candidate.type === "assistant_message" &&
        candidate.text.trim() !== "",
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  const messages = projection.messages.filter(
    (message) =>
      message.runId === runId && message.role === "assistant" && message.text.trim() !== "",
  );
  const message =
    (item?.type === "assistant_message"
      ? messages.find((candidate) => candidate.id === item.messageId)
      : undefined) ??
    messages.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
    )[0];
  return (message?.text ?? (item?.type === "assistant_message" ? item.text : "")).trim();
};

const channelError = (
  message: string,
  options: { readonly channelId?: BotChannelId; readonly cause?: unknown } = {},
) =>
  new BotError({
    message,
    ...(options.channelId === undefined ? {} : { channelId: options.channelId }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });

const RANK: Record<BotChannelMessage["kind"], number> = { user: 0, assigned: 1, reply: 2 };

/** Shared channels, built inside BotService, which owns the bots and their chats. */
export const makeBotChannels = Effect.fn("BotChannels.make")(function* (callbacks: {
  readonly loadBots: Effect.Effect<ReadonlyArray<Bot>, BotError>;
  readonly openChat: (input: BotOpenChatInput) => Effect.Effect<BotOpenChatResult, BotError>;
  /** The bots list carries channel summaries. */
  readonly listChanged: Effect.Effect<void>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  // Each change names its channel; a detail subscriber re-reads only its own.
  const changes = yield* PubSub.sliding<BotChannelId>(64);

  const now = Effect.map(DateTime.now, (value) => DateTime.formatIso(value));
  const uuid = random
    .uuidV4()
    .pipe(Effect.mapError((cause) => channelError("Could not generate an id.", { cause })));
  const dbError =
    (message: string, channelId?: BotChannelId) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          channelError(message, { cause, ...(channelId === undefined ? {} : { channelId }) }),
        ),
      );

  const changed = (channelId: BotChannelId) =>
    PubSub.publish(changes, channelId).pipe(Effect.asVoid);

  const leadOf = (channel: BotChannel): BotId | null =>
    channel.leadBotId !== null && channel.memberIds.includes(channel.leadBotId)
      ? channel.leadBotId
      : (channel.memberIds[0] ?? null);

  const toChannel = (
    row: ChannelRow,
    members: ReadonlyArray<{ readonly channel_id: string; readonly bot_id: string }>,
  ): BotChannel => ({
    id: BotChannelId.make(row.channel_id),
    name: row.name,
    memberIds: members
      .filter((member) => member.channel_id === row.channel_id)
      .map((member) => BotId.make(member.bot_id)),
    leadBotId: row.lead_bot_id === null ? null : BotId.make(row.lead_bot_id),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  const list = Effect.fn("BotService.listChannels")(function* () {
    const rows = yield* sql<ChannelRow>`
      SELECT channel_id, name, lead_bot_id, archived, created_at, updated_at FROM bot_channels
      ORDER BY archived, name COLLATE NOCASE, channel_id
    `.pipe(NodeSqliteClient.readOnly, dbError("Could not load channels."));
    const members = yield* sql<{ readonly channel_id: string; readonly bot_id: string }>`
      SELECT channel_id, bot_id FROM bot_channel_members ORDER BY channel_id, position, bot_id
    `.pipe(NodeSqliteClient.readOnly, dbError("Could not load channels."));
    return rows.map((row) => toChannel(row, members));
  });

  const getChannel = Effect.fn("BotService.getChannel")(function* (id: BotChannelId) {
    const rows = yield* sql<ChannelRow>`
      SELECT channel_id, name, lead_bot_id, archived, created_at, updated_at FROM bot_channels
      WHERE channel_id = ${id}
    `.pipe(NodeSqliteClient.readOnly, dbError("Could not load the channel.", id));
    const row = rows[0];
    if (row === undefined) {
      return yield* channelError("This channel no longer exists.", { channelId: id });
    }
    const members = yield* sql<{ readonly channel_id: string; readonly bot_id: string }>`
      SELECT channel_id, bot_id FROM bot_channel_members WHERE channel_id = ${id}
      ORDER BY position, bot_id
    `.pipe(NodeSqliteClient.readOnly, dbError("Could not load the channel.", id));
    return toChannel(row, members);
  });

  const writableChannel = Effect.fn("BotService.writableChannel")(function* (
    id: BotChannelId,
    action: string,
  ) {
    const channel = yield* getChannel(id);
    if (channel.archived) {
      return yield* channelError(`This channel is deleted. Restore it to ${action}.`, {
        channelId: id,
      });
    }
    return channel;
  });

  const validName = Effect.fn("BotService.validChannelName")(function* (raw: string) {
    const name = cleanChannelName(raw);
    if (name === null) {
      return yield* channelError(
        `Use a channel name up to ${BOT_CHANNEL_NAME_MAX_CHARS} characters.`,
      );
    }
    return name;
  });

  const validMembers = Effect.fn("BotService.validChannelMembers")(function* (
    requested: ReadonlyArray<BotId>,
  ) {
    const known = new Set((yield* callbacks.loadBots).map((bot) => bot.id));
    const members = [...new Set(requested)];
    if (members.some((id) => !known.has(id))) return yield* channelError("Bot not found.");
    return members;
  });

  const writeMembers = (channelId: BotChannelId, members: ReadonlyArray<BotId>) =>
    Effect.forEach(
      members,
      (botId, position) =>
        sql`INSERT INTO bot_channel_members (channel_id, bot_id, position) VALUES (${channelId}, ${botId}, ${position})`,
      { discard: true },
    );

  const detail = Effect.fn("BotService.channelDetail")(function* (id: BotChannelId, limit: number) {
    const channel = yield* getChannel(id);
    const loadError = dbError("Could not load the channel history.", id);
    const messages = yield* sql<{
      readonly message_id: string;
      readonly kind: string;
      readonly author_bot_id: string | null;
      readonly text: string;
      readonly status: string | null;
      readonly created_at: string;
    }>`
      SELECT message_id, kind, author_bot_id, text, status, created_at FROM bot_channel_messages
      WHERE channel_id = ${id} ORDER BY created_at DESC, message_id DESC LIMIT ${limit + 1}
    `.pipe(NodeSqliteClient.readOnly, loadError);
    const deliveries = yield* sql<{
      readonly delivery_id: string;
      readonly bot_id: string;
      readonly name: string | null;
      readonly status: string;
      readonly created_at: string;
    }>`
      SELECT deliveries.delivery_id, deliveries.bot_id, bots.name, deliveries.status,
        deliveries.created_at
      FROM bot_channel_deliveries AS deliveries
      LEFT JOIN bots ON bots.bot_id = deliveries.bot_id
      WHERE deliveries.channel_id = ${id}
      ORDER BY deliveries.created_at DESC, deliveries.delivery_id DESC LIMIT ${limit + 1}
    `.pipe(NodeSqliteClient.readOnly, loadError);
    const rows: Array<BotChannelMessage> = [
      ...messages.map((row): BotChannelMessage => ({
        id: BotChannelMessageId.make(row.message_id),
        kind: row.kind === "reply" ? "reply" : "user",
        authorBotId: row.author_bot_id === null ? null : BotId.make(row.author_bot_id),
        text: row.text,
        status: workStatus(row.status),
        createdAt: row.created_at,
      })),
      ...deliveries.map((row): BotChannelMessage => ({
        id: BotChannelMessageId.make(row.delivery_id),
        kind: "assigned",
        authorBotId: BotId.make(row.bot_id),
        text: `Assigned to ${row.name ?? "a removed bot"}`,
        status: workStatus(row.status),
        createdAt: row.created_at,
      })),
    ].toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        RANK[left.kind] - RANK[right.kind] ||
        left.id.localeCompare(right.id),
    );
    const open = yield* sql<{ readonly bot_id: string; readonly status: string }>`
      SELECT DISTINCT bot_id, status FROM bot_channel_deliveries
      WHERE channel_id = ${id} AND status IN ${sql.in(OPEN_STATUSES)}
      ORDER BY bot_id
    `.pipe(NodeSqliteClient.readOnly, loadError);
    const result: BotChannelDetail = {
      channel,
      messages: rows.slice(Math.max(0, rows.length - limit)),
      hasMore: rows.length > limit,
      activeBotIds: [
        ...new Set(
          open.filter((row) => row.status === "in_progress").map((row) => BotId.make(row.bot_id)),
        ),
      ],
      busyBotIds: [...new Set(open.map((row) => BotId.make(row.bot_id)))],
    };
    return result;
  });

  const subscribe = (input: BotChannelSubscribeInput): Stream.Stream<BotChannelDetail, BotError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const limit = input.limit ?? BOT_CHANNEL_HISTORY_PAGE;
        // Subscribe before reading to buffer concurrent changes.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(detail(input.id, limit)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((id) => id === input.id),
            Stream.mapEffect(() => detail(input.id, limit)),
          ),
        );
      }),
    );

  const updatePostStatus = Effect.fn("BotService.updateChannelPostStatus")(function* (
    messageId: string,
  ) {
    const rows = yield* sql<{ readonly status: string; readonly attempt: number }>`
      SELECT status, attempt FROM bot_channel_deliveries WHERE message_id = ${messageId}
    `;
    const status = postStatus(
      rows.flatMap((row) => {
        const status = workStatus(row.status);
        return status === null ? [] : [{ status, attempt: row.attempt }];
      }),
    );
    yield* sql`UPDATE bot_channel_messages SET status = ${status} WHERE message_id = ${messageId}`;
  });

  const recentHistory = Effect.fn("BotService.channelHistory")(function* (
    channelId: BotChannelId,
    messageId: BotChannelMessageId,
  ) {
    const rows = yield* sql<{
      readonly kind: string;
      readonly text: string;
      readonly name: string | null;
    }>`
      SELECT messages.kind, messages.text, bots.name FROM bot_channel_messages AS messages
      LEFT JOIN bots ON bots.bot_id = messages.author_bot_id
      WHERE messages.channel_id = ${channelId} AND messages.message_id != ${messageId}
        AND messages.kind IN ('user', 'reply')
      ORDER BY messages.created_at DESC, messages.message_id DESC LIMIT ${HISTORY_CONTEXT}
    `.pipe(NodeSqliteClient.readOnly);
    return rows
      .map((row) => ({
        author: row.kind === "user" ? "You" : (row.name ?? "A removed bot"),
        text: row.text,
      }))
      .toReversed();
  });

  /** Takes a run off the bot's queue, or interrupts it when it is the bot's running turn. */
  const haltRun = Effect.fn("BotService.haltChannelRun")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const records = yield* threadManagement
      .getThreadRecords(threadId, ["runs"], { runIds: [runId] })
      .pipe(Effect.orElseSucceed(() => null));
    const run = records?.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return;
    const key = yield* uuid;
    if (run.status === "queued") {
      yield* threadManagement.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`bot-channel-cancel:${key}`),
        threadId,
        runId,
      });
      return;
    }
    if (deliveryStatusForRun(run.status) !== "in_progress") return;
    const shell = yield* threadManagement.getThreadShell(threadId);
    if (shell === null) return;
    // With a run id, only that run is interrupted; another turn the bot is running keeps going.
    yield* threadManagement.interruptThread({
      projectId: shell.projectId,
      commandId: CommandId.make(`bot-channel-stop:${key}`),
      threadId,
      runId,
      reason: "Stopped from the channel.",
    });
  });

  const haltQuietly = (row: Pick<DeliveryRow, "thread_id" | "run_id">) =>
    row.thread_id === null || row.run_id === null
      ? Effect.void
      : haltRun(ThreadId.make(row.thread_id), RunId.make(row.run_id)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("bots.channel-halt-failed", { threadId: row.thread_id, cause }),
          ),
        );

  /** Stops unfinished assignments; the records stay, marked stopped. */
  const stopDeliveries = Effect.fn("BotService.stopChannelWork")(function* (filter: {
    readonly channelId?: BotChannelId;
    readonly botIds?: ReadonlyArray<BotId>;
  }) {
    const open = yield* sql<DeliveryRow>`
      SELECT delivery_id, channel_id, message_id, bot_id, thread_id, run_id, status
      FROM bot_channel_deliveries WHERE status IN ${sql.in(OPEN_STATUSES)}
    `;
    const targets = open.filter(
      (row) =>
        (filter.channelId === undefined || row.channel_id === filter.channelId) &&
        (filter.botIds === undefined || filter.botIds.some((id) => id === row.bot_id)),
    );
    if (targets.length === 0) return;
    const timestamp = yield* now;
    const stopped = yield* Effect.filter(targets, (row) =>
      sql<{ readonly delivery_id: string }>`
        UPDATE bot_channel_deliveries SET status = 'stopped', updated_at = ${timestamp}
        WHERE delivery_id = ${row.delivery_id} AND status IN ${sql.in(OPEN_STATUSES)}
        RETURNING delivery_id
      `.pipe(Effect.map((rows) => rows.length > 0)),
    );
    yield* Effect.forEach(
      new Set(stopped.map((row) => row.message_id)),
      (messageId) => updatePostStatus(messageId),
      { discard: true },
    );
    // Marked first, so a turn that ends while it is halted cannot settle it otherwise.
    yield* Effect.forEach(stopped, haltQuietly, { discard: true });
    yield* Effect.forEach(
      new Set(stopped.map((row) => BotChannelId.make(row.channel_id))),
      changed,
      { discard: true },
    );
  });

  /** Moves an assignment along with its run. Only forward: a stopped one stays stopped. */
  const settleFromRun = Effect.fn("BotService.settleChannelDelivery")(function* (
    row: DeliveryRow,
    run: OrchestrationV2Run,
  ) {
    const target = deliveryStatusForRun(run.status);
    if (target === "queued") return;
    const timestamp = yield* now;
    const from = target === "in_progress" ? (["queued"] as const) : OPEN_STATUSES;
    let reply = "";
    if (target === "completed" && workStatus(row.status) !== "stopped" && row.thread_id !== null) {
      reply = yield* threadManagement
        .getThreadRecords(ThreadId.make(row.thread_id), ["messages", "turnItems"], {
          messageRoles: ["assistant"],
          messageRunIds: [run.id],
          turnItemRunIds: [run.id],
          turnItemTypes: ["assistant_message"],
        })
        .pipe(
          Effect.map((projection) => finalAssistantText(projection, run.id)),
          Effect.orElseSucceed(() => ""),
        );
    }
    const settled = yield* sql.withTransaction(
      Effect.gen(function* () {
        const claimed = yield* sql<{ readonly delivery_id: string }>`
          UPDATE bot_channel_deliveries SET status = ${target}, updated_at = ${timestamp}
          WHERE delivery_id = ${row.delivery_id} AND status IN ${sql.in(from)}
          RETURNING delivery_id
        `;
        if (claimed.length === 0) return false;
        if (reply !== "") {
          const id = `bot-channel-message:${yield* uuid}`;
          yield* sql`
            INSERT INTO bot_channel_messages (message_id, channel_id, kind, author_bot_id, text,
              status, created_at)
            VALUES (${id}, ${row.channel_id}, 'reply', ${row.bot_id}, ${reply}, NULL, ${timestamp})
          `;
        }
        yield* updatePostStatus(row.message_id);
        return true;
      }),
    );
    if (settled) yield* changed(BotChannelId.make(row.channel_id));
  });

  // Runs for every run event in the environment; two indexed lookups find the few that matter.
  const onRun = Effect.fn("BotService.onChannelRun")(function* (run: OrchestrationV2Run) {
    const continued =
      run.restartContinuationOfRunId ??
      run.manualContinuationOfRunId ??
      run.usageLimitContinuationOfRunId;
    if (continued !== undefined) {
      // The work goes on in a new run: a restart, a manual continue or a resume after a limit.
      const relinked = yield* sql<{ readonly message_id: string; readonly channel_id: string }>`
        UPDATE bot_channel_deliveries SET run_id = ${run.id}, status = 'in_progress'
        WHERE run_id = ${continued} AND status != 'completed'
        RETURNING message_id, channel_id
      `;
      yield* Effect.forEach(relinked, (row) => updatePostStatus(row.message_id), {
        discard: true,
      });
      yield* Effect.forEach(relinked, (row) => changed(BotChannelId.make(row.channel_id)), {
        discard: true,
      });
    }
    const rows = yield* sql<DeliveryRow>`
      SELECT delivery_id, channel_id, message_id, bot_id, thread_id, run_id, status
      FROM bot_channel_deliveries
      WHERE run_id = ${run.id} OR (run_id IS NULL AND thread_message_id = ${run.userMessageId})
    `;
    yield* Effect.forEach(rows, (row) => settleFromRun(row, run), { discard: true });
  });

  /** Assignments a restart left open: a run that is gone fails, one that ended settles. */
  const reconcile = Effect.fn("BotService.reconcileChannels")(function* (
    rows: ReadonlyArray<DeliveryRow>,
  ) {
    for (const row of rows) {
      const run =
        row.thread_id === null || row.run_id === null
          ? undefined
          : (yield* threadManagement
              .getThreadRecords(ThreadId.make(row.thread_id), ["runs"], {
                runIds: [RunId.make(row.run_id)],
              })
              .pipe(Effect.orElseSucceed(() => ({ runs: [] })))).runs.find(
              (candidate) => candidate.id === row.run_id,
            );
      if (run !== undefined) {
        yield* settleFromRun(row, run);
        continue;
      }
      const timestamp = yield* now;
      const failed = yield* sql<{ readonly delivery_id: string }>`
        UPDATE bot_channel_deliveries SET status = 'failed', updated_at = ${timestamp}
        WHERE delivery_id = ${row.delivery_id} AND status IN ${sql.in(OPEN_STATUSES)}
        RETURNING delivery_id
      `;
      if (failed.length === 0) continue;
      yield* updatePostStatus(row.message_id);
      yield* changed(BotChannelId.make(row.channel_id));
    }
  });

  const openDeliveries = sql<DeliveryRow>`
    SELECT delivery_id, channel_id, message_id, bot_id, thread_id, run_id, status
    FROM bot_channel_deliveries WHERE status IN ${sql.in(OPEN_STATUSES)}
  `.pipe(NodeSqliteClient.readOnly);

  /** Hands one post to one member: a queued message in the bot's own chat. */
  const assign = Effect.fn("BotService.assignChannelPost")(function* (input: {
    readonly channel: BotChannel;
    readonly messageId: BotChannelMessageId;
    readonly text: string;
    readonly bot: Bot;
    readonly attempt: number;
    readonly createdAt: string;
  }) {
    const key = yield* uuid;
    const deliveryId = `bot-channel-delivery:${key}`;
    const threadMessageId = MessageId.make(`bot-channel:${key}`);
    const history = yield* recentHistory(input.channel.id, input.messageId);
    yield* sql`
      INSERT INTO bot_channel_deliveries (delivery_id, channel_id, message_id, bot_id, attempt,
        thread_id, thread_message_id, run_id, status, created_at, updated_at)
      VALUES (${deliveryId}, ${input.channel.id}, ${input.messageId}, ${input.bot.id},
        ${input.attempt}, NULL, ${threadMessageId}, NULL, 'queued', ${input.createdAt},
        ${input.createdAt})
    `;
    const sent = yield* Effect.result(
      Effect.gen(function* () {
        const chat = yield* callbacks.openChat({ id: input.bot.id });
        yield* sql`UPDATE bot_channel_deliveries SET thread_id = ${chat.threadId} WHERE delivery_id = ${deliveryId}`;
        return yield* threadManagement
          .sendToThread({
            projectId: chat.projectId,
            commandId: CommandId.make(`bot-channel:${key}`),
            threadId: chat.threadId,
            messageId: threadMessageId,
            text: assignmentText(input.channel.name, input.text, history),
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.mapError((cause) =>
              channelError(`Could not hand the post to ${input.bot.name}.`, {
                channelId: input.channel.id,
                cause,
              }),
            ),
          );
      }),
    );
    const timestamp = yield* now;
    if (sent._tag === "Failure") {
      yield* Effect.logWarning("bots.channel-assign-failed", {
        channelId: input.channel.id,
        botId: input.bot.id,
        cause: sent.failure,
      });
      yield* sql`
        UPDATE bot_channel_deliveries SET status = 'failed', updated_at = ${timestamp}
        WHERE delivery_id = ${deliveryId} AND status IN ${sql.in(OPEN_STATUSES)}
      `;
      return;
    }
    const run = sent.success.run;
    yield* sql`UPDATE bot_channel_deliveries SET run_id = ${run.id} WHERE delivery_id = ${deliveryId}`;
    const rows = yield* sql<DeliveryRow>`
      SELECT delivery_id, channel_id, message_id, bot_id, thread_id, run_id, status
      FROM bot_channel_deliveries WHERE delivery_id = ${deliveryId}
    `;
    const row = rows[0];
    if (row === undefined) return;
    // A Stop that landed during the hand-over found no run to halt; halt it now.
    if (row.status === "stopped") yield* haltQuietly(row);
    else yield* settleFromRun(row, run);
  });

  const requireBots = Effect.fn("BotService.channelRecipients")(function* (
    channel: BotChannel,
    ids: ReadonlyArray<BotId>,
  ) {
    const bots = yield* callbacks.loadBots;
    const chosen = ids.flatMap((id) => bots.filter((bot) => bot.id === id));
    if (chosen.length < ids.length) {
      return yield* channelError("Choose bots that belong to this channel.", {
        channelId: channel.id,
      });
    }
    const paused = chosen.filter((bot) => bot.paused);
    if (paused.length > 0) {
      const names = paused.map((bot) => bot.name).join(" and ");
      return yield* channelError(
        `${names} ${paused.length > 1 ? "are" : "is"} paused. Resume ${paused.length > 1 ? "them" : "it"} to assign work.`,
        { channelId: channel.id },
      );
    }
    return chosen;
  });

  const create = Effect.fn("BotService.createChannel")(function* (input: BotChannelCreateInput) {
    const name = yield* validName(input.name);
    const members = yield* validMembers(input.memberIds);
    const id = BotChannelId.make(`bot-channel:${yield* uuid}`);
    const timestamp = yield* now;
    yield* sql
      .withTransaction(
        sql`
          INSERT INTO bot_channels (channel_id, name, lead_bot_id, archived, created_at, updated_at)
          VALUES (${id}, ${name}, ${members[0] ?? null}, 0, ${timestamp}, ${timestamp})
        `.pipe(Effect.andThen(writeMembers(id, members))),
      )
      .pipe(dbError("Could not create the channel."));
    yield* callbacks.listChanged;
    const result: BotChannelResult = { channel: yield* getChannel(id) };
    return result;
  });

  const update = Effect.fn("BotService.updateChannel")(function* (input: BotChannelUpdateInput) {
    const before = yield* writableChannel(input.id, "change it");
    const name = yield* validName(input.name);
    const members = yield* validMembers(input.memberIds);
    if (input.leadBotId !== null && !members.includes(input.leadBotId)) {
      return yield* channelError("Choose a lead from the channel members.", {
        channelId: input.id,
      });
    }
    const lead = input.leadBotId ?? members[0] ?? null;
    const timestamp = yield* now;
    yield* sql
      .withTransaction(
        sql`
          UPDATE bot_channels SET name = ${name}, lead_bot_id = ${lead}, updated_at = ${timestamp}
          WHERE channel_id = ${input.id}
        `.pipe(
          Effect.andThen(sql`DELETE FROM bot_channel_members WHERE channel_id = ${input.id}`),
          Effect.andThen(writeMembers(input.id, members)),
        ),
      )
      .pipe(dbError("Could not save the channel.", input.id));
    // A removed member's pending work here stops; the others can continue its posts.
    const removed = before.memberIds.filter((id) => !members.includes(id));
    if (removed.length > 0) {
      yield* stopDeliveries({ channelId: input.id, botIds: removed }).pipe(
        dbError("Could not stop the removed members' work.", input.id),
      );
    }
    yield* callbacks.listChanged;
    yield* changed(input.id);
    const result: BotChannelResult = { channel: yield* getChannel(input.id) };
    return result;
  });

  const archive = Effect.fn("BotService.archiveChannel")(function* (input: BotChannelArchiveInput) {
    yield* getChannel(input.id);
    const timestamp = yield* now;
    // Archived first, so no post is admitted while its pending work stops.
    yield* sql`
      UPDATE bot_channels SET archived = ${input.archived ? 1 : 0}, updated_at = ${timestamp}
      WHERE channel_id = ${input.id}
    `.pipe(dbError("Could not save the channel.", input.id));
    if (input.archived) {
      yield* stopDeliveries({ channelId: input.id }).pipe(
        dbError("Could not stop the channel's work.", input.id),
      );
    }
    yield* callbacks.listChanged;
    yield* changed(input.id);
    const result: BotChannelResult = { channel: yield* getChannel(input.id) };
    return result;
  });

  const post = Effect.fn("BotService.postToChannel")(function* (input: BotChannelPostInput) {
    const channel = yield* writableChannel(input.id, "post");
    const routed = routeRecipients(channel.memberIds, leadOf(channel), input.recipientIds);
    if ("error" in routed) return yield* channelError(routed.error, { channelId: channel.id });
    const recipients = yield* requireBots(channel, routed.recipients);
    const messageId = BotChannelMessageId.make(`bot-channel-message:${yield* uuid}`);
    const createdAt = yield* now;
    const writeError = dbError("Could not post to the channel.", channel.id);
    yield* sql`
      INSERT INTO bot_channel_messages (message_id, channel_id, kind, author_bot_id, text, status,
        created_at)
      VALUES (${messageId}, ${channel.id}, 'user', NULL, ${input.text}, 'queued', ${createdAt})
    `.pipe(writeError);
    yield* Effect.forEach(
      recipients,
      (bot) =>
        assign({ channel, messageId, text: input.text, bot, attempt: 1, createdAt }).pipe(
          writeError,
        ),
      { discard: true },
    );
    yield* updatePostStatus(messageId).pipe(writeError);
    yield* changed(channel.id);
    const result: BotChannelPostResult = { messageId };
    return result;
  });

  const retry = Effect.fn("BotService.retryChannelPost")(function* (
    input: BotChannelContinueInput & { readonly botId?: BotId },
  ) {
    const channel = yield* writableChannel(input.id, "continue");
    const rows = yield* sql<{ readonly text: string; readonly status: string | null }>`
      SELECT text, status FROM bot_channel_messages
      WHERE message_id = ${input.messageId} AND channel_id = ${input.id} AND kind = 'user'
    `.pipe(NodeSqliteClient.readOnly, dbError("Could not load the post.", input.id));
    const row = rows[0];
    if (row === undefined) {
      return yield* channelError("This channel message no longer exists.", { channelId: input.id });
    }
    if (row.status !== "stopped" && row.status !== "failed") {
      return yield* channelError("This message is no longer stopped.", { channelId: input.id });
    }
    const botId = input.botId ?? leadOf(channel);
    if (botId === null) {
      return yield* channelError("Add a bot in channel settings to continue.", {
        channelId: input.id,
      });
    }
    if (!channel.memberIds.includes(botId)) {
      return yield* channelError("Choose a bot that belongs to this channel.", {
        channelId: input.id,
      });
    }
    const [bot] = yield* requireBots(channel, [botId]);
    if (bot === undefined) return yield* channelError("Bot not found.", { channelId: input.id });
    const writeError = dbError("Could not continue the post.", input.id);
    const attempts = yield* sql<{ readonly attempt: number }>`
      SELECT COALESCE(MAX(attempt), 0) AS attempt FROM bot_channel_deliveries
      WHERE message_id = ${input.messageId}
    `.pipe(writeError);
    yield* assign({
      channel,
      messageId: input.messageId,
      text: row.text,
      bot,
      attempt: (attempts[0]?.attempt ?? 0) + 1,
      createdAt: yield* now,
    }).pipe(writeError);
    yield* updatePostStatus(input.messageId).pipe(writeError);
    yield* changed(input.id);
    return { id: input.id };
  });

  const stop = Effect.fn("BotService.stopChannel")(function* (input: BotChannelStopInput) {
    yield* getChannel(input.id);
    yield* stopDeliveries({ channelId: input.id }).pipe(
      dbError("Could not stop the channel's work.", input.id),
    );
    yield* changed(input.id);
    return { id: input.id };
  });

  /** A paused bot takes no channel work; its unfinished assignments stop. */
  const stopBot = (botId: BotId) =>
    stopDeliveries({ botIds: [botId] }).pipe(dbError("Could not stop the bot's channel work."));

  /** A deleted bot leaves every channel; its unfinished assignments stop and can be continued. */
  const removeBot = Effect.fn("BotService.removeBotFromChannels")(function* (botId: BotId) {
    yield* stopBot(botId);
    const channels = yield* sql<{ readonly channel_id: string }>`
      SELECT DISTINCT channel_id FROM bot_channel_members WHERE bot_id = ${botId}
    `.pipe(dbError("Could not update the bot's channels."));
    yield* sql
      .withTransaction(
        sql`DELETE FROM bot_channel_members WHERE bot_id = ${botId}`.pipe(
          Effect.andThen(
            sql`UPDATE bot_channels SET lead_bot_id = NULL WHERE lead_bot_id = ${botId}`,
          ),
        ),
      )
      .pipe(dbError("Could not update the bot's channels."));
    yield* Effect.forEach(channels, (row) => changed(BotChannelId.make(row.channel_id)), {
      discard: true,
    });
  });

  const reassign = (input: BotChannelReassignInput) => retry(input);
  const continuePost = (input: BotChannelContinueInput) => retry(input);

  return {
    list,
    subscribe,
    create,
    update,
    archive,
    post,
    stop,
    continuePost,
    reassign,
    stopBot,
    removeBot,
    onRun: (run: OrchestrationV2Run) =>
      onRun(run).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("bots.channel-run-failed", { runId: run.id, cause }),
        ),
      ),
    openDeliveries: openDeliveries.pipe(Effect.orElseSucceed(() => [])),
    reconcile: (rows: ReadonlyArray<DeliveryRow>) =>
      reconcile(rows).pipe(Effect.ignoreCause({ log: true })),
  };
});
