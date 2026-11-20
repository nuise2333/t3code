import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  BOT_MAX_DELEGATION_DEPTH,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { BotThreadIdentity } from "../bots/BotDirectory.ts";
import * as BotService from "../bots/BotService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BotMcpService from "./BotMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const at = "2026-01-01T00:00:00.000Z";

const makeBot = (handle: string, overrides: Partial<Bot> = {}): Bot => ({
  id: BotId.make(`bot:${handle}`),
  name: handle.charAt(0).toUpperCase() + handle.slice(1),
  handle,
  title: "",
  instructions: "",
  dispatcher: false,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  projectId: ProjectId.make("project:scratch"),
  homeThreadId: null,
  avatar: "",
  color: "blue",
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

describe("findTeammate", () => {
  const bots = [makeBot("builder"), makeBot("reviewer", { name: "Ana María" })];
  it.each([
    ["@builder", "builder"],
    ["builder", "builder"],
    ["  @Builder ", "builder"],
    ["BUILDER", "builder"],
    ["Ana María", "reviewer"],
    ["ana maría", "reviewer"],
    ["@reviewer", "reviewer"],
    ["nobody", undefined],
  ] as const)("%j -> %s", (to, handle) => {
    assert.equal(BotMcpService.findTeammate(bots, to)?.handle, handle);
  });
});

describe("admitPairMessage", () => {
  const window = 10 * 60_000;
  const now = 100 * window;
  const full = Array.from({ length: BotMcpService.BOT_PAIR_MESSAGE_LIMIT }, (_, i) => now - i);
  it.each([
    ["an empty history", [], true, 1],
    ["one under the limit", full.slice(1), true, BotMcpService.BOT_PAIR_MESSAGE_LIMIT],
    ["a full window", full, false, BotMcpService.BOT_PAIR_MESSAGE_LIMIT],
    ["a full history all older than the window", full.map((sent) => sent - window), true, 1],
    [
      "a full history with one just inside the window",
      [...full.slice(1).map((sent) => sent - window), now - window + 1],
      true,
      2,
    ],
  ] as const)("%s", (_label, sent, admitted, kept) => {
    const result = BotMcpService.admitPairMessage(sent, now);
    assert.equal(result.admitted, admitted);
    assert.equal(result.kept.length, kept);
    if (admitted) assert.equal(result.kept.at(-1), now);
  });
});

const lead = makeBot("lead", {
  dispatcher: true,
  homeThreadId: ThreadId.make("thread:lead-home"),
});
const builder = makeBot("builder", {
  runtimeMode: "approval-required",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claude"),
    model: "claude-haiku",
    options: [{ id: "effort", value: "low" }],
  } as Bot["modelSelection"],
});
const reviewer = makeBot("reviewer");
const team = [lead, builder, reviewer];

const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env:test"),
  capabilities: new Set(["bots"]),
  issuedAt: 0,
  requestNamespace: "test",
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
});

const harness = (identities: ReadonlyMap<ThreadId, BotThreadIdentity>) =>
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<BotService.BotTaskRecordInput>>([]);
    const delegated = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const sent = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
      [],
    );
    const context = yield* Layer.build(
      BotMcpService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(BotService.BotService)({
              identityOf: (threadId) => Effect.succeed(identities.get(threadId) ?? null),
              list: () => Effect.succeed({ bots: team, memories: [], tasks: [] }),
              openChat: ({ id }) =>
                Effect.succeed({
                  threadId: ThreadId.make(`thread:${id}-home`),
                  projectId: ProjectId.make("project:scratch"),
                }),
              recordTask: (input) => Ref.update(recorded, (all) => [...all, input]),
            }),
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
              delegateTask: (_scope, input) =>
                Ref.update(delegated, (all) => [...all, input]).pipe(
                  Effect.as({
                    taskId: NodeId.make("task:1"),
                    childThreadId: ThreadId.make("thread:child"),
                  } as never),
                ),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              // Callers run in `auto`, narrower than full-access and broader than the builder's mode.
              getThreadShell: () => Effect.succeed({ runtimeMode: "auto" } as never),
              sendToThread: (input) =>
                Ref.update(sent, (all) => [...all, input]).pipe(Effect.as({} as never)),
            }),
            NodeCrypto.layer,
          ),
        ),
      ),
    );
    return {
      service: Context.get(context, BotMcpService.BotMcpService),
      recorded,
      delegated,
      sent,
    };
  });

const homeOf = (bot: Bot): BotThreadIdentity => ({ kind: "home", bot, depth: 0 });
const taskOf = (bot: Bot, depth: number): BotThreadIdentity =>
  ({ kind: "task", bot, depth, task: {} as never }) satisfies BotThreadIdentity;

const reviewerHome = ThreadId.make("thread:reviewer-home");
const deepTask = ThreadId.make("thread:deep-task");
const shallowTask = ThreadId.make("thread:shallow-task");
const identities = new Map<ThreadId, BotThreadIdentity>([
  [reviewerHome, homeOf(reviewer)],
  [deepTask, taskOf(reviewer, BOT_MAX_DELEGATION_DEPTH)],
  [shallowTask, taskOf(reviewer, 1)],
]);

describe("BotMcpService.sendMessage", () => {
  it.effect("refuses self-sends, unknown teammates, deep tasks and threads that are not bots", () =>
    Effect.gen(function* () {
      const { service, delegated, sent } = yield* harness(identities);
      const self = yield* Effect.flip(
        service.sendMessage(scopeFor(reviewerHome), { to: "@reviewer", text: "hi" }),
      );
      assert.include(self.message, "That is you");
      const unknown = yield* Effect.flip(
        service.sendMessage(scopeFor(reviewerHome), { to: "@ghost", text: "hi" }),
      );
      assert.equal(unknown.code, "invalid_request");
      assert.include(unknown.message, "Teammates: @lead, @builder.");
      const deep = yield* Effect.flip(
        service.sendMessage(scopeFor(deepTask), { to: "builder", text: "hi" }),
      );
      assert.include(deep.message, `${BOT_MAX_DELEGATION_DEPTH} hand-offs`);
      const stranger = yield* Effect.flip(
        service.sendMessage(scopeFor(ThreadId.make("thread:plain")), { to: "builder", text: "hi" }),
      );
      assert.equal(stranger.code, "capability_denied");
      const toDispatcher = yield* Effect.flip(
        service.sendMessage(scopeFor(shallowTask), { to: "@lead", text: "Done." }),
      );
      assert.include(toDispatcher.message, "Tasks report to whoever asked");
      assert.deepEqual(yield* Ref.get(delegated), []);
      assert.deepEqual(yield* Ref.get(sent), []);
    }).pipe(Effect.scoped),
  );

  it.effect("queues a message to the dispatcher in its own chat instead of delegating", () =>
    Effect.gen(function* () {
      const { service, delegated, sent, recorded } = yield* harness(identities);
      const result = yield* service.sendMessage(scopeFor(reviewerHome), {
        to: "@lead",
        text: "Done with the review.",
        title: "Review",
      });
      assert.equal(result.to, "lead");
      assert.equal(result.threadId, "thread:bot:lead-home");
      assert.isUndefined(result.taskId);
      const [message] = yield* Ref.get(sent);
      assert.equal(message?.threadId, "thread:bot:lead-home");
      assert.equal(message?.mode, "queue");
      assert.equal(message?.senderThreadId, reviewerHome);
      assert.equal(message?.text, "[Message from @reviewer: Review]\n\nDone with the review.");
      assert.deepEqual(yield* Ref.get(delegated), []);
      assert.deepEqual(yield* Ref.get(recorded), []);
    }).pipe(Effect.scoped),
  );

  it.effect("delegates to a member on its own model and records the task one level deeper", () =>
    Effect.gen(function* () {
      const { service, delegated, recorded, sent } = yield* harness(identities);
      const result = yield* service.sendMessage(scopeFor(shallowTask), {
        to: "Builder",
        text: "Fix the build.",
      });
      assert.equal(result.taskId, "task:1");
      assert.equal(result.threadId, "thread:child");
      const [input] = (yield* Ref.get(delegated)) as ReadonlyArray<{
        readonly task: string;
        readonly title: string;
        readonly target: unknown;
        readonly runtimeMode?: string;
      }>;
      assert.equal(input?.runtimeMode, "approval-required");
      assert.deepEqual(input?.target, {
        providerInstanceId: "claude",
        model: "claude-haiku",
        options: [{ id: "effort", value: "low" }],
      });
      assert.equal(input?.title, "Builder: Fix the build.");
      assert.include(input?.task ?? "", "task @reviewer handed you");
      assert.include(input?.task ?? "", "Task from @reviewer:\n\nFix the build.");
      assert.deepEqual(yield* Ref.get(recorded), [
        {
          threadId: ThreadId.make("thread:child"),
          taskId: NodeId.make("task:1"),
          botId: builder.id,
          requesterThreadId: shallowTask,
          requesterBotId: reviewer.id,
          title: "Builder: Fix the build.",
          depth: 2,
        },
      ]);
      assert.deepEqual(yield* Ref.get(sent), []);
    }).pipe(Effect.scoped),
  );
});
