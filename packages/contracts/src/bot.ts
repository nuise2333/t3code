import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
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

export const BotListResult = Schema.Struct({
  bots: Schema.Array(Bot),
  memories: Schema.Array(BotMemory),
  /** The most recent tasks, newest first. */
  tasks: Schema.Array(BotTask),
  /** One per bot whose chat has a message. */
  lastMessages: Schema.Array(BotLastMessage).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
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
