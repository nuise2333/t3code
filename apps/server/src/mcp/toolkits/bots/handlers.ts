import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotMcpService from "../../BotMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotToolkit } from "./tools.ts";

// Discovery hides these tools elsewhere; a direct call still has to come from a bot's thread.
const botScope = McpInvocationContext.McpInvocationContext.pipe(
  Effect.filterOrFail(
    (scope) => scope.capabilities.has("bots"),
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Only a bot's chat or task can use bot tools.",
      }),
  ),
);

const handlers = {
  bot_send_message: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* botScope;
      const service = yield* BotMcpService.BotMcpService;
      return yield* service.sendMessage(scope, input);
    }),
  ),
  // Memories change no workspace, so read-only and plan-mode bots may keep them.
  bot_remember: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* botScope;
      const service = yield* BotMcpService.BotMcpService;
      return yield* service.remember(scope, input);
    }),
  ),
  bot_forget: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* botScope;
      const service = yield* BotMcpService.BotMcpService;
      return yield* service.forget(scope, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof BotToolkit.tools>;

export const layer = McpToolAccess.toLayer(BotToolkit, handlers);
