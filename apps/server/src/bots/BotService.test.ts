import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  BotMemoryId,
  type BotUpsertInput,
  MAX_BOT_MEMORIES,
  MAX_BOTS,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as BotService from "./BotService.ts";

describe("handleFromName", () => {
  it.each([
    ["Builder", "builder"],
    ["Code Reviewer 2", "code-reviewer-2"],
    ["Ana María", "ana-maria"],
    ["  --Ops!!  ", "ops"],
    ["设计师", "bot"],
    ["设计师 Lin", "lin"],
    ["a".repeat(40), "a".repeat(32)],
    [`${"a".repeat(31)} b`, "a".repeat(31)],
  ])("%j -> %j", (name, handle) => {
    assert.equal(BotService.handleFromName(name), handle);
  });
});

describe("uniqueHandle", () => {
  it.each([
    ["builder", [], "builder"],
    ["builder", ["builder"], "builder-2"],
    ["builder", ["builder", "builder-2", "builder-3"], "builder-4"],
    ["a".repeat(32), ["a".repeat(32)], `${"a".repeat(30)}-2`],
  ] as const)("%s taken by %j -> %s", (base, taken, handle) => {
    assert.equal(BotService.uniqueHandle(base, new Set(taken)), handle);
  });
});

describe("previewText", () => {
  it.each([
    ["  Fix\n\nthe   build  ", "Fix the build"],
    ["a".repeat(140), "a".repeat(140)],
    ["a".repeat(141), `${"a".repeat(139)}…`],
  ])("%j", (text, preview) => {
    assert.equal(BotService.previewText(text), preview);
  });
});

describe("taskStatusForRun", () => {
  it.each([
    ["preparing", "working"],
    ["queued", "working"],
    ["starting", "working"],
    ["running", "working"],
    ["waiting", "waiting"],
    ["completed", "done"],
    ["failed", "failed"],
    ["cancelled", "stopped"],
    ["interrupted", "stopped"],
    ["rolled_back", "stopped"],
  ] as const)("%s -> %s", (run, task) => {
    assert.equal(BotService.taskStatusForRun(run), task);
  });
});

describe("watchdogAction", () => {
  const quiet = BotService.BOT_TASK_QUIET_MS;
  const now = 10 * quiet;
  it.each([
    ["not working", "done", null, now - 2 * quiet, "none"],
    ["waiting on the user", "waiting", null, now - 2 * quiet, "none"],
    ["quiet under the limit", "working", null, now - quiet + 1, "none"],
    ["quiet at the limit, never nudged", "working", null, now - quiet, "nudge"],
    ["nudged before the last activity", "working", now - 3 * quiet, now - 2 * quiet, "nudge"],
    ["nudged a full window ago", "working", now - quiet, now - 2 * quiet, "stop"],
    // The nudge's own message lands just after it and is not progress.
    ["only the nudge landed since", "working", now - quiet - 1_000, now - quiet, "stop"],
    ["nudged recently", "working", now - quiet + 1, now - 2 * quiet, "none"],
  ] as const)("%s", (_label, status, nudgedAtMs, lastActivityMs, action) => {
    assert.equal(
      BotService.watchdogAction({ status, nudgedAtMs, lastActivityMs, nowMs: now }),
      action,
    );
  });
});

const scratchProject = ProjectId.make("project:scratch");
const otherProject = ProjectId.make("project:other");

const botInput = (overrides: Partial<BotUpsertInput> = {}): BotUpsertInput => ({
  name: "Builder",
  title: "Engineer",
  instructions: "",
  dispatcher: false,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  avatar: "",
  color: "blue",
  ...overrides,
});

interface DomainEventStep {
  readonly event: OrchestrationV2DomainEvent;
  readonly handled: Deferred.Deferred<void>;
}

const harness = Effect.gen(function* () {
  const launches = yield* Ref.make(0);
  // Threads getThreadShell knows about; absent means the thread is gone.
  const shells = yield* Ref.make<ReadonlyMap<ThreadId, { archivedAt: string | null }>>(new Map());
  const events = yield* Queue.unbounded<DomainEventStep>();
  const runs = yield* Ref.make<
    ReadonlyMap<ThreadId, ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status">>>
  >(new Map());
  const nudged = yield* Deferred.make<ThreadManagementService.ThreadManagementSendInput>();
  const interrupted = yield* Deferred.make<ThreadId>();
  const interrupts = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const schedules = yield* Ref.make<
    ReadonlyArray<{ id: ScheduledTaskId; threadId: ThreadId | null; enabled: boolean }>
  >([]);
  const scheduleToggles = yield* Ref.make<ReadonlyArray<readonly [ScheduledTaskId, boolean]>>([]);
  const deps = Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: () =>
        Ref.updateAndGet(launches, (n) => n + 1).pipe(
          Effect.map((n) => {
            const threadId = ThreadId.make(`thread:chat-${n}`);
            return { threadId } as never;
          }),
          Effect.tap((result: { threadId: ThreadId }) =>
            Ref.update(shells, (map) => new Map(map).set(result.threadId, { archivedAt: null })),
          ),
        ),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId: ThreadId) =>
        Ref.get(shells).pipe(
          Effect.map((map) => {
            const shell = map.get(threadId);
            return (
              shell === undefined
                ? null
                : { projectId: scratchProject, deletedAt: null, archivedAt: shell.archivedAt }
            ) as never;
          }),
        ),
      // Runs each thread's projection shows; tasks without an entry have not started.
      getThreadRecords: (threadId: ThreadId) =>
        Ref.get(runs).pipe(Effect.map((map) => ({ runs: map.get(threadId) ?? [] }) as never)),
      sendToThread: (input) => Deferred.succeed(nudged, input).pipe(Effect.as({} as never)),
      interruptThread: (input) =>
        Ref.update(interrupts, (all) => [...all, input.threadId]).pipe(
          Effect.andThen(Deferred.succeed(interrupted, input.threadId)),
          Effect.as({} as never),
        ),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Ref.get(schedules).pipe(Effect.map((tasks) => ({ tasks }) as never)),
      setEnabled: (input) =>
        Ref.update(scheduleToggles, (all) => [...all, [input.id, input.enabled] as const]).pipe(
          Effect.andThen(
            Ref.update(schedules, (all) =>
              all.map((task) =>
                task.id === input.id ? { ...task, enabled: input.enabled } : task,
              ),
            ),
          ),
          Effect.as({} as never),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      ensureScratchProject: Effect.succeed({ projectId: scratchProject }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      // Each step resolves `handled` once the service has processed its event.
      streamDomainEvents: Stream.fromQueue(events).pipe(
        Stream.flatMap((step) =>
          Stream.make(step.event).pipe(
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(step.handled, undefined)).pipe(Stream.drain),
            ),
          ),
        ),
      ),
    }),
    NodeCrypto.layer,
    Scheduler.layer,
  );
  const context = yield* Layer.build(BotService.layer.pipe(Layer.provide(deps)));
  const service = Context.get(context, BotService.BotService);
  const emit = Effect.fn("test.emit")(function* (event: OrchestrationV2DomainEvent) {
    const handled = yield* Deferred.make<void>();
    yield* Queue.offer(events, { event, handled });
    yield* Deferred.await(handled);
  });
  return {
    service,
    launches,
    shells,
    emit,
    nudged,
    interrupted,
    runs,
    interrupts,
    schedules,
    scheduleToggles,
  };
});

const runEvent = (threadId: ThreadId, status: OrchestrationV2Run["status"]) =>
  ({
    type: "run.updated",
    threadId,
    occurredAt: DateTime.makeUnsafe(0),
    payload: { threadId, status },
  }) as unknown as OrchestrationV2DomainEvent;

const taskInput = (botId: BotId, threadId: ThreadId): BotService.BotTaskRecordInput => ({
  threadId,
  taskId: NodeId.make(`task:${threadId}`),
  botId,
  requesterThreadId: ThreadId.make("thread:requester"),
  requesterBotId: null,
  title: "Fix the build",
  depth: 1,
});

const withDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory));

describe("BotService", () => {
  it.effect(
    "derives unique handles, rejects a taken explicit handle and keeps one dispatcher",
    () =>
      withDb(
        Effect.gen(function* () {
          const { service } = yield* harness;
          const first = (yield* service.upsert(botInput({ dispatcher: true }))).bot;
          const second = (yield* service.upsert(botInput({ dispatcher: true }))).bot;
          assert.equal(first.handle, "builder");
          assert.equal(second.handle, "builder-2");
          assert.equal(first.projectId, scratchProject);

          const clash = yield* Effect.flip(service.upsert(botInput({ handle: "builder" })));
          assert.include(clash.message, "@builder");
          // Re-saving a bot with its own handle is not a clash.
          yield* service.upsert(botInput({ id: first.id, handle: "builder", name: "Renamed" }));

          const { bots } = yield* service.list();
          assert.deepEqual(
            bots.map((bot) => [bot.handle, bot.name, bot.dispatcher]),
            [
              ["builder-2", "Builder", true],
              ["builder", "Renamed", false],
            ],
          );
          const missing = yield* Effect.flip(
            service.upsert(botInput({ id: BotId.make("bot:missing") })),
          );
          assert.equal(missing.message, "Bot not found.");
        }),
      ),
  );

  it.effect("holds at most MAX_BOTS bots", () =>
    withDb(
      Effect.gen(function* () {
        const { service } = yield* harness;
        for (let index = 0; index < MAX_BOTS; index++) {
          yield* service.upsert(botInput({ name: `Bot ${index}` }));
        }
        const error = yield* Effect.flip(service.upsert(botInput({ name: "One more" })));
        assert.include(error.message, `${MAX_BOTS}`);
        assert.equal((yield* service.list()).bots.length, MAX_BOTS);
      }),
    ),
  );

  it.effect(
    "opens the home chat once, reuses it while live and relaunches when gone or archived",
    () =>
      withDb(
        Effect.gen(function* () {
          const { service, launches, shells } = yield* harness;
          const bot = (yield* service.upsert(botInput())).bot;
          const opened = yield* service.openChat({ id: bot.id });
          assert.equal(opened.threadId, "thread:chat-1");
          assert.equal(opened.projectId, scratchProject);
          assert.equal((yield* service.openChat({ id: bot.id })).threadId, "thread:chat-1");
          assert.equal(yield* Ref.get(launches), 1);
          const identity = yield* service.identityOf(opened.threadId);
          assert.equal(identity?.kind, "home");

          yield* Ref.update(shells, (map) =>
            new Map(map).set(opened.threadId, { archivedAt: "2026-01-01T00:00:00.000Z" }),
          );
          assert.equal((yield* service.openChat({ id: bot.id })).threadId, "thread:chat-2");
          yield* Ref.set(shells, new Map());
          assert.equal((yield* service.openChat({ id: bot.id })).threadId, "thread:chat-3");
          assert.equal(yield* Ref.get(launches), 3);

          // Same project keeps the chat; moving the bot drops it.
          const kept = yield* service.upsert(botInput({ id: bot.id, projectId: scratchProject }));
          assert.equal(kept.bot.homeThreadId, "thread:chat-3");
          const moved = yield* service.upsert(botInput({ id: bot.id, projectId: otherProject }));
          assert.isNull(moved.bot.homeThreadId);
          assert.equal(moved.bot.projectId, otherProject);
          const reloaded = (yield* service.list()).bots[0];
          assert.isNull(reloaded?.homeThreadId);
          // Omitting the project keeps it; null moves the bot back to "No project".
          const unchanged = yield* service.upsert(botInput({ id: bot.id }));
          assert.equal(unchanged.bot.projectId, otherProject);
          const cleared = yield* service.upsert(botInput({ id: bot.id, projectId: null }));
          assert.equal(cleared.bot.projectId, scratchProject);
        }),
      ),
  );

  it.effect("caps memories, refuses forgetting another bot's memory and cascades on delete", () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { service } = yield* harness;
        const bot = (yield* service.upsert(botInput())).bot;
        const other = (yield* service.upsert(botInput({ name: "Other" }))).bot;

        const added = yield* service.addMemory({ botId: bot.id, text: "Prefers pnpm" });
        assert.equal(added.count, 1);
        assert.equal(added.memory.source, "user");

        const refused = yield* Effect.flip(
          service.deleteMemory({ id: added.memory.id, botId: other.id }),
        );
        assert.equal(refused.message, "Memory not found.");
        const unknown = yield* Effect.flip(
          service.deleteMemory({ id: BotMemoryId.make("bot-memory:missing") }),
        );
        assert.equal(unknown.message, "Memory not found.");
        const forgotten = yield* service.deleteMemory({ id: added.memory.id, botId: bot.id });
        assert.equal(forgotten.count, 0);

        for (let index = 0; index < MAX_BOT_MEMORIES; index++) {
          yield* sql`INSERT INTO bot_memories ${sql.insert({
            memory_id: `bot-memory:${index}`,
            bot_id: bot.id,
            text: `fact ${index}`,
            source: "bot",
            created_at: "2026-01-01T00:00:00.000Z",
          })}`;
        }
        const full = yield* Effect.flip(service.addMemory({ botId: bot.id, text: "One more" }));
        assert.include(full.message, `${MAX_BOT_MEMORIES}`);
        const noBot = yield* Effect.flip(
          service.addMemory({ botId: BotId.make("bot:missing"), text: "x" }),
        );
        assert.equal(noBot.message, "Bot not found.");

        yield* service.recordTask(taskInput(bot.id, ThreadId.make("thread:task")));
        yield* service.addMemory({ botId: other.id, text: "Keeps this" });
        yield* service.delete({ id: bot.id });
        const listed = yield* service.list();
        assert.deepEqual(
          listed.bots.map((entry) => entry.id),
          [other.id],
        );
        assert.deepEqual(
          listed.memories.map((memory) => memory.botId),
          [other.id],
        );
        assert.deepEqual(listed.tasks, []);
      }),
    ),
  );

  it.effect("follows a recorded task's runs and ignores threads that are not tasks", () =>
    withDb(
      Effect.gen(function* () {
        const { service, emit, runs } = yield* harness;
        const bot = (yield* service.upsert(botInput())).bot;
        const taskThread = ThreadId.make("thread:task");
        yield* service.recordTask(taskInput(bot.id, taskThread));
        // Recording twice keeps the first row.
        yield* service.recordTask({ ...taskInput(bot.id, taskThread), title: "Other title" });

        const statusOf = service
          .list()
          .pipe(Effect.map((list) => list.tasks.map((task) => [task.title, task.status])));
        assert.deepEqual(yield* statusOf, [["Fix the build", "working"]]);
        yield* emit(runEvent(taskThread, "waiting"));
        assert.deepEqual(yield* statusOf, [["Fix the build", "waiting"]]);
        yield* emit(runEvent(taskThread, "completed"));
        assert.deepEqual(yield* statusOf, [["Fix the build", "done"]]);
        yield* emit(runEvent(taskThread, "interrupted"));
        assert.deepEqual(yield* statusOf, [["Fix the build", "stopped"]]);

        yield* emit(runEvent(ThreadId.make("thread:unrelated"), "completed"));
        assert.equal((yield* service.list()).tasks.length, 1);
        assert.equal((yield* service.identityOf(taskThread))?.kind, "task");

        // A child that finished before its row existed is recorded as it ended.
        const quickThread = ThreadId.make("thread:quick");
        yield* Ref.set(
          runs,
          new Map([
            [
              quickThread,
              [
                { ordinal: 1, status: "failed" },
                { ordinal: 2, status: "completed" },
              ],
            ],
          ]),
        );
        yield* service.recordTask({ ...taskInput(bot.id, quickThread), title: "Quick" });
        const quick = (yield* service.list()).tasks.find((task) => task.threadId === quickThread);
        assert.equal(quick?.status, "done");
      }),
    ),
  );

  it.effect("nudges a quiet working task, then stops it after another quiet window", () =>
    withDb(
      Effect.gen(function* () {
        const { service, shells, nudged, interrupted } = yield* harness;
        const bot = (yield* service.upsert(botInput())).bot;
        const taskThread = ThreadId.make("thread:quiet-task");
        yield* Ref.update(shells, (map) => new Map(map).set(taskThread, { archivedAt: null }));
        yield* service.recordTask(taskInput(bot.id, taskThread));

        yield* TestClock.adjust("25 minutes");
        const nudge = yield* Deferred.await(nudged);
        assert.equal(nudge.threadId, taskThread);
        assert.equal(nudge.mode, "steer");
        const task = (yield* service.list()).tasks[0];
        assert.isNotNull(task?.nudgedAt);
        assert.equal(task?.status, "working");

        yield* TestClock.adjust("25 minutes");
        assert.equal(yield* Deferred.await(interrupted), taskThread);
      }),
    ),
  );
  it.effect(
    "pauses by stopping the chat and working tasks and its enabled schedules, and resumes only those",
    () =>
      withDb(
        Effect.gen(function* () {
          const { service, shells, interrupts, schedules, scheduleToggles } = yield* harness;
          const bot = (yield* service.upsert(botInput())).bot;
          assert.isFalse(bot.paused);
          const home = (yield* service.openChat({ id: bot.id })).threadId;
          const working = ThreadId.make("thread:working-task");
          const finished = ThreadId.make("thread:finished-task");
          yield* Ref.update(shells, (map) =>
            new Map(map).set(working, { archivedAt: null }).set(finished, { archivedAt: null }),
          );
          yield* service.recordTask(taskInput(bot.id, working));
          yield* service.recordTask({ ...taskInput(bot.id, finished), title: "Done already" });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE bot_tasks SET status = 'done' WHERE thread_id = ${finished}`;
          const on = ScheduledTaskId.make("schedule:on");
          const off = ScheduledTaskId.make("schedule:off");
          const elsewhere = ScheduledTaskId.make("schedule:elsewhere");
          yield* Ref.set(schedules, [
            { id: on, threadId: home, enabled: true },
            { id: off, threadId: home, enabled: false },
            { id: elsewhere, threadId: ThreadId.make("thread:other"), enabled: true },
          ]);

          const paused = yield* service.setPaused({ id: bot.id, paused: true });
          assert.isTrue(paused.bot.paused);
          assert.isTrue((yield* service.list()).bots[0]?.paused);
          assert.deepEqual(yield* Ref.get(interrupts), [home, working]);
          assert.deepEqual(yield* Ref.get(scheduleToggles), [[on, false]]);
          // Saving the bot keeps it paused; pausing again changes nothing.
          assert.isTrue((yield* service.upsert(botInput({ id: bot.id }))).bot.paused);
          yield* service.setPaused({ id: bot.id, paused: true });
          assert.equal((yield* Ref.get(scheduleToggles)).length, 1);

          const resumed = yield* service.setPaused({ id: bot.id, paused: false });
          assert.isFalse(resumed.bot.paused);
          assert.deepEqual(yield* Ref.get(scheduleToggles), [
            [on, false],
            [on, true],
          ]);
          yield* service.setPaused({ id: bot.id, paused: true });
          yield* service.setPaused({ id: bot.id, paused: false });
          assert.deepEqual((yield* Ref.get(scheduleToggles)).slice(2), [
            [on, false],
            [on, true],
          ]);
        }),
      ),
  );

  it.effect("previews the newest message the user or the bot wrote in its chat", () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { service } = yield* harness;
        const bot = (yield* service.upsert(botInput())).bot;
        const quiet = (yield* service.upsert(botInput({ name: "Quiet" }))).bot;
        const home = (yield* service.openChat({ id: bot.id })).threadId;
        yield* service.openChat({ id: quiet.id });
        const message = (
          id: string,
          role: string,
          createdAt: string,
          payload: Record<string, unknown>,
          streaming = 0,
        ) =>
          sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: id,
            thread_id: home,
            run_id: null,
            node_id: null,
            role,
            streaming,
            created_at: createdAt,
            updated_at: createdAt,
            payload_json: JSON.stringify(payload),
          })}`;
        yield* message("m1", "user", "2026-01-01T00:00:01.000Z", { text: "Fix  the\nbuild" });
        const lastMessages = () => service.list().pipe(Effect.map((list) => list.lastMessages));
        assert.deepEqual(yield* lastMessages(), [
          { botId: bot.id, role: "user", text: "Fix the build", at: "2026-01-01T00:00:01.000Z" },
        ]);
        yield* message("m2", "assistant", "2026-01-01T00:00:02.000Z", { text: "Fixed." });
        // Still streaming, a note from another bot, and an empty reply are not previews.
        yield* message("m3", "assistant", "2026-01-01T00:00:03.000Z", { text: "Work" }, 1);
        yield* message("m4", "user", "2026-01-01T00:00:04.000Z", {
          text: "[Message from @lead]",
          createdBy: "agent",
        });
        yield* message("m5", "assistant", "2026-01-01T00:00:05.000Z", { text: "" });
        assert.deepEqual(yield* lastMessages(), [
          { botId: bot.id, role: "assistant", text: "Fixed.", at: "2026-01-01T00:00:02.000Z" },
        ]);
      }),
    ),
  );

  it.effect("republishes the list when a turn starts or ends in a bot's chat", () =>
    withDb(
      Effect.gen(function* () {
        const { service, emit } = yield* harness;
        const bot = (yield* service.upsert(botInput())).bot;
        const home = (yield* service.openChat({ id: bot.id })).threadId;
        const updates = yield* Queue.unbounded<void>();
        const fiber = yield* Stream.runForEach(service.subscribeList(), () =>
          Queue.offer(updates, undefined),
        ).pipe(Effect.forkChild);
        yield* Queue.take(updates);
        yield* emit(runEvent(home, "running"));
        yield* emit(runEvent(ThreadId.make("thread:unrelated"), "completed"));
        assert.equal(yield* Queue.size(updates), 0);
        yield* emit(runEvent(home, "completed"));
        yield* Queue.take(updates);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
});
