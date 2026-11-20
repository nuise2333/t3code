import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  BotChannelId,
  BotChannelMessageId,
  BotId,
  BotMemoryId,
  IsoDateTime,
  NodeId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const BOT_HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const MAX_BOTS = 32;
export const MAX_BOT_MEMORIES = 100;
export const BOT_MEMORY_MAX_CHARS = 500;
export const BOT_INSTRUCTIONS_MAX_CHARS = 20_000;
/** Bot-to-bot delegation stops this many hops below the chat a person started. */
export const BOT_MAX_DELEGATION_DEPTH = 3;

export const BotHandle = TrimmedNonEmptyString.check(Schema.isPattern(BOT_HANDLE_PATTERN)).annotate(
  {
    description: "Lowercase letters, digits and dashes, such as `builder`.",
  },
);
export type BotHandle = typeof BotHandle.Type;

export const BotColor = Schema.Literals([
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
]);
export type BotColor = typeof BotColor.Type;

const BotName = TrimmedNonEmptyString.check(Schema.isMaxLength(60));
const BotTitle = Schema.String.check(Schema.isMaxLength(80));
const BotInstructions = Schema.String.check(Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_CHARS));
const BotAvatar = Schema.String.check(Schema.isMaxLength(16));
const BotMemoryText = TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_MEMORY_MAX_CHARS));

export const Bot = Schema.Struct({
  id: BotId,
  name: BotName,
  handle: BotHandle,
  /** The job, such as "Code reviewer". */
  title: BotTitle,
  /** Duties, workflows and personality, in the user's words. */
  instructions: BotInstructions,
  /** The one bot that splits requests and hands them to the others. */
  dispatcher: Schema.Boolean,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  /** Where the bot's own chat runs; tasks run where they were asked. */
  projectId: ProjectId,
  homeThreadId: Schema.NullOr(ThreadId),
  avatar: BotAvatar,
  color: BotColor,
  /** Hidden from the list's main groups; takes no new work until resumed. */
  paused: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Bot = typeof Bot.Type;

export const BOT_LAST_MESSAGE_MAX_CHARS = 140;

/** The newest message in a bot's own chat, flattened to one line for list previews. */
export const BotLastMessage = Schema.Struct({
  botId: BotId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  at: IsoDateTime,
});
export type BotLastMessage = typeof BotLastMessage.Type;

export const BotMemorySource = Schema.Literals(["bot", "user"]);
export type BotMemorySource = typeof BotMemorySource.Type;

export const BotMemory = Schema.Struct({
  id: BotMemoryId,
  botId: BotId,
  text: BotMemoryText,
  source: BotMemorySource,
  createdAt: IsoDateTime,
});
export type BotMemory = typeof BotMemory.Type;

export const BotTaskStatus = Schema.Literals(["working", "waiting", "done", "failed", "stopped"]);
export type BotTaskStatus = typeof BotTaskStatus.Type;

/** Work one bot handed another: a delegated child thread run as the target bot. */
export const BotTask = Schema.Struct({
  threadId: ThreadId,
  taskId: NodeId,
  botId: BotId,
  requesterThreadId: ThreadId,
  requesterBotId: Schema.NullOr(BotId),
  title: Schema.String,
  depth: Schema.Int,
  status: BotTaskStatus,
  /** Set when the watchdog asked a quiet task for a status report. */
  nudgedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotTask = typeof BotTask.Type;

export const BOT_CHANNEL_NAME_MAX_CHARS = 48;
export const BOT_CHANNEL_TEXT_MAX_CHARS = 16_384;
const BOT_CHANNEL_MAX_MEMBERS = 64;
/** A post routes to at most this many mentioned members, who work in parallel. */
export const BOT_CHANNEL_MAX_RECIPIENTS = 2;
export const BOT_CHANNEL_HISTORY_PAGE = 100;

/** A group conversation between bots, such as `#launch`; the lead takes posts with no mention. */
export const BotChannel = Schema.Struct({
  id: BotChannelId,
  name: Schema.String,
  /** In order; the first is the default lead. */
  memberIds: Schema.Array(BotId),
  leadBotId: Schema.NullOr(BotId),
  /** Deleted channels keep their history, read only, until restored. */
  archived: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotChannel = typeof BotChannel.Type;

export const BotChannelWorkStatus = Schema.Literals([
  "queued",
  "in_progress",
  "completed",
  "failed",
  "stopped",
]);
export type BotChannelWorkStatus = typeof BotChannelWorkStatus.Type;

/** A user post, a member's reply, or one assignment of a post to a member. */
export const BotChannelMessage = Schema.Struct({
  id: BotChannelMessageId,
  kind: Schema.Literals(["user", "reply", "assigned"]),
  authorBotId: Schema.NullOr(BotId),
  text: Schema.String,
  /** Posts: aggregated from their assignments. Assignments: their own. Replies: null. */
  status: Schema.NullOr(BotChannelWorkStatus),
  createdAt: IsoDateTime,
});
export type BotChannelMessage = typeof BotChannelMessage.Type;

export const BotChannelDetail = Schema.Struct({
  channel: BotChannel,
  /** The latest `limit` rows, oldest first. */
  messages: Schema.Array(BotChannelMessage),
  /** Older rows exist beyond `limit`. */
  hasMore: Schema.Boolean,
  /** Members running a turn for this channel now. */
  activeBotIds: Schema.Array(BotId),
  /** Members with unfinished work here, running or waiting in their queue. */
  busyBotIds: Schema.Array(BotId),
});
export type BotChannelDetail = typeof BotChannelDetail.Type;

// One over the limit, so a leading `#` the server drops still fits.
const BotChannelName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BOT_CHANNEL_NAME_MAX_CHARS + 1),
);
const BotChannelMemberIds = Schema.Array(BotId).check(Schema.isMaxLength(BOT_CHANNEL_MAX_MEMBERS));

export const BotChannelSubscribeInput = Schema.Struct({
  id: BotChannelId,
  /** Default BOT_CHANNEL_HISTORY_PAGE; grows by a page for Show earlier messages. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
});
export type BotChannelSubscribeInput = typeof BotChannelSubscribeInput.Type;

export const BotChannelCreateInput = Schema.Struct({
  name: BotChannelName,
  memberIds: BotChannelMemberIds,
});
export type BotChannelCreateInput = typeof BotChannelCreateInput.Type;

export const BotChannelUpdateInput = Schema.Struct({
  id: BotChannelId,
  name: BotChannelName,
  memberIds: BotChannelMemberIds,
  /** Null picks the first member. */
  leadBotId: Schema.NullOr(BotId),
});
export type BotChannelUpdateInput = typeof BotChannelUpdateInput.Type;

export const BotChannelArchiveInput = Schema.Struct({ id: BotChannelId, archived: Schema.Boolean });
export type BotChannelArchiveInput = typeof BotChannelArchiveInput.Type;

export const BotChannelResult = Schema.Struct({ channel: BotChannel });
export type BotChannelResult = typeof BotChannelResult.Type;

export const BotChannelPostInput = Schema.Struct({
  id: BotChannelId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_CHANNEL_TEXT_MAX_CHARS)),
  /** Mentioned members; empty goes to the lead. */
  recipientIds: BotChannelMemberIds,
});
export type BotChannelPostInput = typeof BotChannelPostInput.Type;
export const BotChannelPostResult = Schema.Struct({ messageId: BotChannelMessageId });
export type BotChannelPostResult = typeof BotChannelPostResult.Type;

export const BotChannelStopInput = Schema.Struct({ id: BotChannelId });
export type BotChannelStopInput = typeof BotChannelStopInput.Type;

/** Runs a stopped or failed post again with the lead. */
export const BotChannelContinueInput = Schema.Struct({
  id: BotChannelId,
  messageId: BotChannelMessageId,
});
export type BotChannelContinueInput = typeof BotChannelContinueInput.Type;

/** Runs a stopped or failed post again with the chosen member. */
export const BotChannelReassignInput = Schema.Struct({
  id: BotChannelId,
  messageId: BotChannelMessageId,
  botId: BotId,
});
export type BotChannelReassignInput = typeof BotChannelReassignInput.Type;

export const BotChannelAckResult = Schema.Struct({ id: BotChannelId });
export type BotChannelAckResult = typeof BotChannelAckResult.Type;

export const BotListResult = Schema.Struct({
  bots: Schema.Array(Bot),
  memories: Schema.Array(BotMemory),
  /** The most recent tasks, newest first. */
  tasks: Schema.Array(BotTask),
  /** One per bot whose chat has a message. */
  lastMessages: Schema.Array(BotLastMessage).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** Shared channels, archived ones included. */
  channels: Schema.Array(BotChannel).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type BotListResult = typeof BotListResult.Type;

export const BotUpsertInput = Schema.Struct({
  id: Schema.optionalKey(BotId),
  name: BotName,
  /** Default: derived from the name. */
  handle: Schema.optionalKey(BotHandle),
  title: BotTitle,
  instructions: BotInstructions,
  dispatcher: Schema.Boolean,
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
  /** Omitted keeps the current project (new bots: "No project"); null moves it to "No project". */
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  avatar: BotAvatar,
  color: BotColor,
});
export type BotUpsertInput = typeof BotUpsertInput.Type;

export const BotUpsertResult = Schema.Struct({ bot: Bot });
export type BotUpsertResult = typeof BotUpsertResult.Type;

export const BotDeleteInput = Schema.Struct({ id: BotId });
export type BotDeleteInput = typeof BotDeleteInput.Type;
export const BotDeleteResult = Schema.Struct({ id: BotId });
export type BotDeleteResult = typeof BotDeleteResult.Type;

export const BotSetPausedInput = Schema.Struct({ id: BotId, paused: Schema.Boolean });
export type BotSetPausedInput = typeof BotSetPausedInput.Type;
export const BotSetPausedResult = Schema.Struct({ bot: Bot });
export type BotSetPausedResult = typeof BotSetPausedResult.Type;

export const BotOpenChatInput = Schema.Struct({ id: BotId });
export type BotOpenChatInput = typeof BotOpenChatInput.Type;
export const BotOpenChatResult = Schema.Struct({ threadId: ThreadId, projectId: ProjectId });
export type BotOpenChatResult = typeof BotOpenChatResult.Type;

export const BotMemoryAddInput = Schema.Struct({ botId: BotId, text: BotMemoryText });
export type BotMemoryAddInput = typeof BotMemoryAddInput.Type;
export const BotMemoryAddResult = Schema.Struct({ memory: BotMemory });
export type BotMemoryAddResult = typeof BotMemoryAddResult.Type;

export const BotMemoryDeleteInput = Schema.Struct({ id: BotMemoryId });
export type BotMemoryDeleteInput = typeof BotMemoryDeleteInput.Type;
export const BotMemoryDeleteResult = Schema.Struct({ id: BotMemoryId });
export type BotMemoryDeleteResult = typeof BotMemoryDeleteResult.Type;

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  message: Schema.String,
  botId: Schema.optional(BotId),
  channelId: Schema.optional(BotChannelId),
  cause: Schema.optional(Schema.Defect()),
}) {}

// MCP tools a bot's own threads get.

export const BotMcpSendMessageInput = Schema.Struct({
  to: TrimmedNonEmptyString.annotate({ description: "Teammate's @handle or name." }),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(50_000)).annotate({
    description:
      "Everything the teammate needs: it sees none of this chat. Say what result you want back.",
  }),
  title: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
      description: "A short name for the task.",
    }),
  ),
});
export type BotMcpSendMessageInput = typeof BotMcpSendMessageInput.Type;

export const BotMcpSendMessageResult = Schema.Struct({
  to: BotHandle,
  /** A task opened for the teammate; absent when the message went to the dispatcher's chat. */
  taskId: Schema.optionalKey(NodeId),
  threadId: ThreadId,
  next: Schema.String,
});
export type BotMcpSendMessageResult = typeof BotMcpSendMessageResult.Type;

export const BotMcpRememberInput = Schema.Struct({
  text: BotMemoryText.annotate({
    description:
      "One durable fact, preference or lesson worth knowing in later chats. No secrets, no task progress.",
  }),
});
export type BotMcpRememberInput = typeof BotMcpRememberInput.Type;

export const BotMcpForgetInput = Schema.Struct({
  id: BotMemoryId.annotate({ description: "Memory id from your brief." }),
});
export type BotMcpForgetInput = typeof BotMcpForgetInput.Type;

export const BotMcpMemoryResult = Schema.Struct({ id: BotMemoryId, memories: Schema.Int });
export type BotMcpMemoryResult = typeof BotMcpMemoryResult.Type;
