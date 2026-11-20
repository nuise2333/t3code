import {
  type Bot,
  BOT_MAX_DELEGATION_DEPTH,
  type BotMcpForgetInput,
  type BotMcpMemoryResult,
  type BotMcpRememberInput,
  type BotMcpSendMessageInput,
  type BotMcpSendMessageResult,
  CommandId,
  MessageId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { botBrief } from "../bots/BotDirectory.ts";
import * as BotService from "../bots/BotService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { runtimeModeRank } from "./delegatedTaskModes.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/** Messages one bot may send another in a window, so two bots cannot ping-pong forever. */
export const BOT_PAIR_MESSAGE_LIMIT = 16;
const BOT_PAIR_WINDOW_MS = 10 * 60_000;

export class BotMcpService extends Context.Service<
  BotMcpService,
  {
    readonly sendMessage: (
      scope: McpInvocationScope,
      input: BotMcpSendMessageInput,
    ) => Effect.Effect<BotMcpSendMessageResult, OrchestratorMcpFailure>;
    readonly remember: (
      scope: McpInvocationScope,
      input: BotMcpRememberInput,
    ) => Effect.Effect<BotMcpMemoryResult, OrchestratorMcpFailure>;
    readonly forget: (
      scope: McpInvocationScope,
      input: BotMcpForgetInput,
    ) => Effect.Effect<BotMcpMemoryResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/BotMcpService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** `@Builder`, `builder` and the bot's name all find the same teammate. */
export const findTeammate = (bots: ReadonlyArray<Bot>, to: string): Bot | undefined => {
  const wanted = to.trim().replace(/^@/, "").toLowerCase();
  return (
    bots.find((bot) => bot.handle === wanted) ??
    bots.find((bot) => bot.name.trim().toLowerCase() === wanted)
  );
};

/** Drops sends older than the window and reports whether one more fits. */
export const admitPairMessage = (
  sentAtMs: ReadonlyArray<number>,
  nowMs: number,
): { readonly admitted: boolean; readonly kept: ReadonlyArray<number> } => {
  const kept = sentAtMs.filter((at) => nowMs - at < BOT_PAIR_WINDOW_MS);
  if (kept.length >= BOT_PAIR_MESSAGE_LIMIT) return { admitted: false, kept };
  return { admitted: true, kept: [...kept, nowMs] };
};

export const layer = Layer.effect(
  BotMcpService,
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const random = yield* SecureRandom.SecureRandom;
    const pairSends = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<number>>>(new Map());

    const unavailable = (cause: { readonly message: string }) =>
      failure("orchestration_error", cause.message);

    const caller = Effect.fn("BotMcpService.caller")(function* (scope: McpInvocationScope) {
      const threadId = scope.thread?.threadId;
      if (threadId === undefined) {
        return yield* failure("thread_credential_required", "Only a bot's own thread can do this.");
      }
      const identity = yield* bots.identityOf(threadId).pipe(Effect.mapError(unavailable));
      if (identity === null) {
        return yield* failure(
          "capability_denied",
          "This thread is not a bot's chat or task, so it has no bot identity.",
        );
      }
      return { threadId, identity };
    });

    const sendMessage: BotMcpService["Service"]["sendMessage"] = Effect.fn(
      "BotMcpService.sendMessage",
    )(function* (scope, input) {
      const { threadId, identity } = yield* caller(scope);
      const self = identity.bot;
      const team = yield* bots.list().pipe(Effect.mapError(unavailable));
      const target = findTeammate(team.bots, input.to);
      if (target === undefined) {
        const handles = team.bots
          .filter((bot) => bot.id !== self.id)
          .map((bot) => `@${bot.handle}`)
          .join(", ");
        return yield* failure(
          "invalid_request",
          `No teammate is called ${input.to}. ${handles === "" ? "You have no teammates." : `Teammates: ${handles}.`}`,
        );
      }
      if (target.id === self.id) {
        return yield* failure("invalid_request", "That is you. Do the work yourself.");
      }
      if (identity.depth >= BOT_MAX_DELEGATION_DEPTH) {
        return yield* failure(
          "invalid_request",
          `Tasks stop ${BOT_MAX_DELEGATION_DEPTH} hand-offs from the user. Do this yourself, or report back what still needs doing.`,
        );
      }
      const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
      const pairKey = `${self.id}>${target.id}`;
      const admitted = yield* Ref.modify(pairSends, (map) => {
        const result = admitPairMessage(map.get(pairKey) ?? [], nowMs);
        return [result.admitted, new Map(map).set(pairKey, result.kept)];
      });
      if (!admitted) {
        return yield* failure(
          "invalid_request",
          `You have sent @${target.handle} ${BOT_PAIR_MESSAGE_LIMIT} messages in 10 minutes. Finish with what you have and report back.`,
        );
      }
      const sender = `@${self.handle}`;

      // The dispatcher is reached in its own chat, where the user sees everything.
      if (target.dispatcher) {
        // A task answers whoever asked; reopening the dispatcher's chat would restart the depth count.
        if (identity.kind === "task") {
          return yield* failure(
            "invalid_request",
            "Tasks report to whoever asked, not the dispatcher. Put this in your final answer.",
          );
        }
        const chat = yield* bots.openChat({ id: target.id }).pipe(Effect.mapError(unavailable));
        const key = yield* random.uuidV4().pipe(Effect.mapError(unavailable));
        yield* threads
          .sendToThread({
            projectId: chat.projectId,
            commandId: CommandId.make(`bot-message:${key}`),
            threadId: chat.threadId,
            messageId: MessageId.make(`bot-message:${key}`),
            senderThreadId: threadId,
            text: `[Message from ${sender}${input.title === undefined ? "" : `: ${input.title}`}]\n\n${input.text}`,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(unavailable));
        return {
          to: target.handle,
          threadId: chat.threadId,
          next: `Delivered to @${target.handle}'s chat. It does not reply here; carry on with your own work.`,
        };
      }

      const depth = identity.depth + 1;
      const memories = team.memories.filter((memory) => memory.botId === target.id);
      const task = [
        botBrief({
          bot: target,
          bots: team.bots,
          memories,
          task: { requester: sender, depth },
        }),
        `Task from ${sender}:\n\n${input.text}`,
      ].join("\n\n");
      const title = input.title ?? `${target.name}: ${input.text.slice(0, 60)}`;
      // The bot's own mode applies when it is no broader than this thread's; broader inherits.
      const callerMode = yield* threads.getThreadShell(threadId).pipe(
        Effect.map((thread) => thread?.runtimeMode ?? null),
        Effect.orElseSucceed(() => null),
      );
      const runtimeMode =
        callerMode !== null && runtimeModeRank(target.runtimeMode) <= runtimeModeRank(callerMode)
          ? target.runtimeMode
          : undefined;
      const delegated = yield* orchestrator.delegateTask(scope, {
        task,
        title,
        ...(runtimeMode === undefined ? {} : { runtimeMode }),
        target: {
          providerInstanceId: target.modelSelection.instanceId,
          model: target.modelSelection.model,
          ...(target.modelSelection.options === undefined
            ? {}
            : { options: target.modelSelection.options }),
        },
      });
      if (delegated.childThreadId === null) {
        return yield* failure("orchestration_error", "The task did not start a thread here.");
      }
      yield* bots
        .recordTask({
          threadId: delegated.childThreadId,
          taskId: delegated.taskId,
          botId: target.id,
          requesterThreadId: threadId,
          requesterBotId: self.id,
          title,
          depth,
        })
        .pipe(Effect.mapError(unavailable));
      return {
        to: target.handle,
        taskId: delegated.taskId,
        threadId: delegated.childThreadId,
        next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
      };
    });

    const remember: BotMcpService["Service"]["remember"] = Effect.fn("BotMcpService.remember")(
      function* (scope, input) {
        const { identity } = yield* caller(scope);
        const result = yield* bots
          .addMemory({ botId: identity.bot.id, text: input.text, source: "bot" })
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
        return { id: result.memory.id, memories: result.count };
      },
    );

    const forget: BotMcpService["Service"]["forget"] = Effect.fn("BotMcpService.forget")(
      function* (scope, input) {
        const { identity } = yield* caller(scope);
        const result = yield* bots
          .deleteMemory({ id: input.id, botId: identity.bot.id })
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message)));
        return { id: result.id, memories: result.count };
      },
    );

    return BotMcpService.of({ sendMessage, remember, forget });
  }),
);
