import {
  BotMcpForgetInput,
  BotMcpMemoryResult,
  BotMcpRememberInput,
  BotMcpSendMessageInput,
  BotMcpSendMessageResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as BotMcpService from "../../BotMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BotMcpService.BotMcpService,
];

const BotSendMessageTool = Tool.make("bot_send_message", {
  description:
    "Hand work to a teammate bot from your brief. It starts a task as that bot in this checkout; its final answer comes back here on its own, so don't wait or poll. A message to the dispatcher goes to its chat and gets no reply; tasks cannot message it. The teammate sees none of this chat: include files, context and the result you want.",
  parameters: BotMcpSendMessageInput,
  success: BotMcpSendMessageResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send work to a teammate bot")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const BotRememberTool = Tool.make("bot_remember", {
  description:
    "Save one durable fact, preference or lesson to your bot memory; it appears in your brief in later chats.",
  parameters: BotMcpRememberInput,
  success: BotMcpMemoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Remember a fact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const BotForgetTool = Tool.make("bot_forget", {
  description: "Remove one of your bot memories that is wrong or out of date.",
  parameters: BotMcpForgetInput,
  success: BotMcpMemoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Forget a memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const BotToolkit = Toolkit.make(BotSendMessageTool, BotRememberTool, BotForgetTool);
