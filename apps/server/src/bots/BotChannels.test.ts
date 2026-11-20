import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  type BotChannelDetail,
  type BotChannelId,
  BotId,
  type BotUpsertInput,
  type MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { assignmentText, cleanChannelName, postStatus, routeRecipients } from "./BotChannels.ts";
import * as BotService from "./BotService.ts";

const a = BotId.make("bot:a");
const b = BotId.make("bot:b");
const c = BotId.make("bot:c");

describe("routeRecipients", () => {
  it.each([
    ["no mention goes to the lead", [], { recipients: [a] }],
    ["one mention", [b], { recipients: [b] }],
    ["two mentions run in parallel", [a, b], { recipients: [a, b] }],
    ["three mentions", [a, b, c], { error: "Mention up to two bots in one post." }],
    ["a non-member", [BotId.make("bot:x")], { error: "Choose bots that belong to this channel." }],
  ] as const)("%s", (_label, requested, expected) => {
    assert.deepEqual(routeRecipients([a, b, c], a, requested), expected);
  });

  it("needs a lead when nothing is mentioned", () => {
    assert.deepEqual(routeRecipients([], null, []), {
      error: "Add a bot in channel settings before posting.",
    });
  });
});

describe("postStatus", () => {
  it.each([
    ["no assignments", [], "stopped"],
    ["one running", [["in_progress", 1]], "in_progress"],
    [
      "queued behind a finished sibling",
      [
        ["completed", 1],
        ["queued", 1],
      ],
      "queued",
    ],
    [
      "a failed sibling",
      [
        ["completed", 1],
        ["failed", 1],
      ],
      "failed",
    ],
    ["stopped", [["stopped", 1]], "stopped"],
    [
      "a retry supersedes the stop",
      [
        ["stopped", 1],
        ["completed", 2],
      ],
      "completed",
    ],
    [
      "a retry supersedes the failure",
      [
        ["failed", 1],
        ["in_progress", 2],
      ],
      "in_progress",
    ],
    [
      "the retry's own failure counts",
      [
        ["stopped", 1],
        ["failed", 2],
      ],
      "failed",
    ],
  ] as const)("%s", (_label, rows, expected) => {
    assert.equal(postStatus(rows.map(([status, attempt]) => ({ status, attempt }))), expected);
  });
});

describe("cleanChannelName", () => {
  it.each([
    ["launch", "launch"],
    ["  #launch ", "launch"],
    ["##ops", "ops"],
    ["", null],
    ["#", null],
    ["a".repeat(48), "a".repeat(48)],
    ["a".repeat(49), null],
    ["two\nlines", null],
  ])("%j -> %j", (raw, name) => {
    assert.equal(cleanChannelName(raw), name);
  });
});

describe("assignmentText", () => {
  it("adds the channel's recent messages, flattened and clipped", () => {
    assert.equal(assignmentText("launch", "Ship it", []), "Work requested in #launch:\n\nShip it");
    assert.equal(
      assignmentText("launch", "Ship it", [
        { author: "You", text: "Plan\n\nthe  launch" },
        { author: "Builder", text: "x".repeat(601) },
      ]),
      `Work requested in #launch:\n\nShip it\n\nRecent messages in #launch (context, oldest first):\n- You: Plan the launch\n- Builder: ${"x".repeat(600)}…`,
    );
  });
});

const scratchProject = ProjectId.make("project:scratch");

const botInput = (name: string): BotUpsertInput => ({
  name,
  title: "Engineer",
  instructions: "",
  dispatcher: false,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  avatar: "",
  color: "blue",
});

interface DomainEventStep {
  readonly event: OrchestrationV2DomainEvent;
  readonly handled: Deferred.Deferred<void>;
}

type FakeRun = Pick<
  OrchestrationV2Run,
  "id" | "threadId" | "userMessageId" | "status" | "manualContinuationOfRunId"
>;

const runEvent = (run: FakeRun) =>
  ({
    type: "run.updated",
    threadId: run.threadId,
    occurredAt: DateTime.makeUnsafe(0),
    payload: run,
  }) as unknown as OrchestrationV2DomainEvent;

/** BotService over an in-memory database; runs and their replies live in refs the test drives. */
const harness = Effect.gen(function* () {
  const launches = yield* Ref.make(0);
  const events = yield* Queue.unbounded<DomainEventStep>();
  const runs = yield* Ref.make<ReadonlyArray<FakeRun>>([]);
  const replies = yield* Ref.make<ReadonlyMap<RunId, string>>(new Map());
  const sent = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
    [],
  );
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const interrupts = yield* Ref.make<ReadonlyArray<RunId | undefined>>([]);
  const deps = Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: () =>
        Ref.updateAndGet(launches, (n) => n + 1).pipe(
          Effect.map((n) => ({ threadId: ThreadId.make(`thread:chat-${n}`) }) as never),
        ),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ projectId: scratchProject, deletedAt: null, archivedAt: null } as never),
      getThreadRecords: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const all = (yield* Ref.get(runs)).filter((run) => run.threadId === threadId);
          const replyMap = yield* Ref.get(replies);
          return {
            runs: all,
            messages: all.flatMap((run) => {
              const text = replyMap.get(run.id);
              return text === undefined
                ? []
                : [
                    {
                      id: `message:${run.id}`,
                      runId: run.id,
                      role: "assistant",
                      text,
                      createdAt: DateTime.makeUnsafe(0),
                    },
                  ];
            }),
            turnItems: [],
          } as never;
        }),
      sendToThread: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(sent, (all) => [...all, input]);
          const run: FakeRun = {
            id: RunId.make(`run:${input.messageId}`),
            threadId: input.threadId,
            userMessageId: input.messageId,
            status: "queued",
          };
          yield* Ref.update(runs, (all) => [...all, run]);
          return { run } as never;
        }),
      dispatch: (command) =>
        Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({} as never)),
      interruptThread: (input) =>
        Ref.update(interrupts, (all) => [...all, input.runId]).pipe(Effect.as({} as never)),
    }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks: [] } as never),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      ensureScratchProject: Effect.succeed({ projectId: scratchProject }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
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

  /** Moves the run a thread message started to `status`, as its domain event would. */
  const moveRun = Effect.fn("test.moveRun")(function* (
    messageId: MessageId,
    status: OrchestrationV2Run["status"],
    reply?: string,
  ) {
    const all = yield* Ref.get(runs);
    const run = all.find((candidate) => candidate.userMessageId === messageId);
    assert.isDefined(run);
    const moved: FakeRun = { ...run, status };
    yield* Ref.set(
      runs,
      all.map((candidate) => (candidate.id === run.id ? moved : candidate)),
    );
    if (reply !== undefined) yield* Ref.update(replies, (map) => new Map(map).set(run.id, reply));
    const handled = yield* Deferred.make<void>();
    yield* Queue.offer(events, { event: runEvent(moved), handled });
    yield* Deferred.await(handled);
  });
  const detail = (id: BotChannelId, limit?: number) =>
    service
      .subscribeChannel(limit === undefined ? { id } : { id, limit })
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
  return { service, runs, sent, dispatched, interrupts, moveRun, detail };
});

/** Rows written in one tick share a timestamp; a tick orders posts and retries. */
const tick = TestClock.adjust("1 second");

const withDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory));

/** Kind, author and status of each row, for compact assertions. */
const rows = (detail: BotChannelDetail) =>
  detail.messages.map(
    (message) =>
      [message.kind, message.authorBotId ?? "you", message.status ?? "-", message.text] as const,
  );

const setup = Effect.gen(function* () {
  const h = yield* harness;
  const builder = (yield* h.service.upsert(botInput("Builder"))).bot;
  const reviewer = (yield* h.service.upsert(botInput("Reviewer"))).bot;
  const writer = (yield* h.service.upsert(botInput("Writer"))).bot;
  const { channel } = yield* h.service.createChannel({
    name: "#launch",
    memberIds: [builder.id, reviewer.id, writer.id],
  });
  return { ...h, builder, reviewer, writer, channel };
});

describe("BotService channels", () => {
  it.effect("routes a post to the lead and turns the finished run into a reply", () =>
    withDb(
      Effect.gen(function* () {
        const { service, sent, moveRun, detail, builder, channel } = yield* setup;
        assert.equal(channel.name, "launch");
        assert.equal(channel.leadBotId, builder.id);

        yield* service.postToChannel({ id: channel.id, text: "Plan the launch", recipientIds: [] });
        const [first] = yield* Ref.get(sent);
        assert.isDefined(first);
        assert.equal(first.mode, "queue");
        assert.equal(first.text, "Work requested in #launch:\n\nPlan the launch");
        assert.deepEqual(rows(yield* detail(channel.id)), [
          ["user", "you", "queued", "Plan the launch"],
          ["assigned", builder.id, "queued", "Assigned to Builder"],
        ]);

        yield* moveRun(first.messageId, "running");
        const running = yield* detail(channel.id);
        assert.deepEqual(running.activeBotIds, [builder.id]);
        assert.equal(running.messages[0]?.status, "in_progress");

        yield* moveRun(first.messageId, "completed", "Here is the plan.");
        const done = yield* detail(channel.id);
        assert.deepEqual(rows(done), [
          ["user", "you", "completed", "Plan the launch"],
          ["assigned", builder.id, "completed", "Assigned to Builder"],
          ["reply", builder.id, "-", "Here is the plan."],
        ]);
        assert.deepEqual(done.activeBotIds, []);

        // The next post carries the earlier ones as context.
        yield* service.postToChannel({ id: channel.id, text: "Go", recipientIds: [] });
        assert.include(
          (yield* Ref.get(sent))[1]?.text ?? "",
          "Recent messages in #launch (context, oldest first):\n- You: Plan the launch\n- Builder: Here is the plan.",
        );
      }),
    ),
  );

  it.effect("runs two mentioned members in parallel and rejects bad recipients", () =>
    withDb(
      Effect.gen(function* () {
        const { service, sent, moveRun, detail, builder, reviewer, writer, channel } = yield* setup;
        yield* service.postToChannel({
          id: channel.id,
          text: "Review this",
          recipientIds: [reviewer.id, writer.id],
        });
        const [toReviewer, toWriter] = yield* Ref.get(sent);
        assert.isDefined(toReviewer);
        assert.isDefined(toWriter);
        yield* moveRun(toReviewer.messageId, "completed", "Looks good.");
        assert.equal((yield* detail(channel.id)).messages[0]?.status, "queued");
        yield* moveRun(toWriter.messageId, "failed");
        assert.equal((yield* detail(channel.id)).messages[0]?.status, "failed");

        const tooMany = yield* Effect.flip(
          service.postToChannel({
            id: channel.id,
            text: "All of you",
            recipientIds: [builder.id, reviewer.id, writer.id],
          }),
        );
        assert.equal(tooMany.message, "Mention up to two bots in one post.");
        const outsider = (yield* service.upsert(botInput("Outsider"))).bot;
        const notMember = yield* Effect.flip(
          service.postToChannel({ id: channel.id, text: "Hi", recipientIds: [outsider.id] }),
        );
        assert.equal(notMember.message, "Choose bots that belong to this channel.");
        yield* service.setPaused({ id: writer.id, paused: true });
        const paused = yield* Effect.flip(
          service.postToChannel({ id: channel.id, text: "Hi", recipientIds: [writer.id] }),
        );
        assert.equal(paused.message, "Writer is paused. Resume it to assign work.");
        assert.equal((yield* Ref.get(sent)).length, 2);
      }),
    ),
  );

  it.effect("stops queued and running work, then continues or reassigns as a new attempt", () =>
    withDb(
      Effect.gen(function* () {
        const { service, sent, dispatched, interrupts, moveRun, detail, reviewer, channel } =
          yield* setup;
        yield* service.postToChannel({ id: channel.id, text: "One", recipientIds: [] });
        yield* tick;
        yield* service.postToChannel({ id: channel.id, text: "Two", recipientIds: [reviewer.id] });
        const [one, two] = yield* Ref.get(sent);
        assert.isDefined(one);
        assert.isDefined(two);
        yield* moveRun(two.messageId, "running");
        assert.equal((yield* detail(channel.id)).busyBotIds.length, 2);

        yield* service.stopChannel({ id: channel.id });
        // The queued one leaves the queue; only the running one is interrupted, by its run id.
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) =>
            command.type === "queued-run.cancel" ? command.runId : command.type,
          ),
          [`run:${one.messageId}`],
        );
        assert.deepEqual(yield* Ref.get(interrupts), [RunId.make(`run:${two.messageId}`)]);
        // The interrupted turn ending does not undo the stop.
        yield* moveRun(two.messageId, "interrupted");
        const stopped = yield* detail(channel.id);
        assert.deepEqual(stopped.busyBotIds, []);
        const posts = stopped.messages.filter((message) => message.kind === "user");
        assert.deepEqual(
          posts.map((message) => message.status),
          ["stopped", "stopped"],
        );

        const [postOne, postTwo] = posts;
        assert.isDefined(postOne);
        assert.isDefined(postTwo);
        yield* tick;
        yield* service.continueChannelPost({ id: channel.id, messageId: postOne.id });
        yield* tick;
        yield* service.reassignChannelPost({
          id: channel.id,
          messageId: postTwo.id,
          botId: reviewer.id,
        });
        const retries = (yield* Ref.get(sent)).slice(2);
        assert.equal(retries.length, 2);
        assert.equal(
          retries[0]?.text,
          "Work requested in #launch:\n\nOne\n\nRecent messages in #launch (context, oldest first):\n- You: Two",
        );
        yield* moveRun(retries[0]!.messageId, "completed", "Done.");
        const after = yield* detail(channel.id);
        // The old attempt stays in the history; the retry's result replaces the stop.
        assert.deepEqual(
          after.messages.filter((message) => message.kind === "assigned").map((m) => m.status),
          ["stopped", "stopped", "completed", "queued"],
        );
        assert.deepEqual(
          after.messages.filter((message) => message.kind === "user").map((m) => m.status),
          ["completed", "queued"],
        );
        const again = yield* Effect.flip(
          service.continueChannelPost({ id: channel.id, messageId: postOne.id }),
        );
        assert.equal(again.message, "This message is no longer stopped.");
      }),
    ),
  );

  it.effect("archived channels reject posts and settings until restored", () =>
    withDb(
      Effect.gen(function* () {
        const { service, sent, dispatched, detail, builder, channel } = yield* setup;
        yield* service.postToChannel({ id: channel.id, text: "Pending", recipientIds: [] });
        const archived = yield* service.archiveChannel({ id: channel.id, archived: true });
        assert.isTrue(archived.channel.archived);
        assert.equal((yield* Ref.get(dispatched)).length, 1);
        assert.equal((yield* detail(channel.id)).messages[0]?.status, "stopped");

        const post = yield* Effect.flip(
          service.postToChannel({ id: channel.id, text: "Hi", recipientIds: [] }),
        );
        assert.equal(post.message, "This channel is deleted. Restore it to post.");
        const edit = yield* Effect.flip(
          service.updateChannel({
            id: channel.id,
            name: "renamed",
            memberIds: [builder.id],
            leadBotId: null,
          }),
        );
        assert.equal(edit.message, "This channel is deleted. Restore it to change it.");
        assert.isTrue((yield* service.list()).channels[0]?.archived);

        yield* service.archiveChannel({ id: channel.id, archived: false });
        yield* service.postToChannel({ id: channel.id, text: "Back", recipientIds: [] });
        assert.equal((yield* Ref.get(sent)).length, 2);
      }),
    ),
  );

  it.effect("removing a member stops its pending work there and moves the lead", () =>
    withDb(
      Effect.gen(function* () {
        const { service, dispatched, detail, builder, reviewer, writer, channel } = yield* setup;
        yield* service.postToChannel({
          id: channel.id,
          text: "Both",
          recipientIds: [builder.id, reviewer.id],
        });
        const lead = yield* Effect.flip(
          service.updateChannel({
            id: channel.id,
            name: "launch",
            memberIds: [reviewer.id],
            leadBotId: writer.id,
          }),
        );
        assert.equal(lead.message, "Choose a lead from the channel members.");
        const updated = yield* service.updateChannel({
          id: channel.id,
          name: "launch-2",
          memberIds: [reviewer.id, writer.id],
          leadBotId: null,
        });
        assert.equal(updated.channel.leadBotId, reviewer.id);
        assert.equal(updated.channel.name, "launch-2");
        assert.equal((yield* Ref.get(dispatched)).length, 1);
        const assigned = (yield* detail(channel.id)).messages.filter(
          (message) => message.kind === "assigned",
        );
        assert.deepEqual(
          new Map(assigned.map((message) => [message.authorBotId, message.status] as const)),
          new Map<string | null, string | null>([
            [builder.id, "stopped"],
            [reviewer.id, "queued"],
          ]),
        );
      }),
    ),
  );

  it.effect("pausing or deleting a bot settles its unfinished work as stopped", () =>
    withDb(
      Effect.gen(function* () {
        const { service, detail, builder, reviewer, channel } = yield* setup;
        yield* service.postToChannel({ id: channel.id, text: "A", recipientIds: [builder.id] });
        yield* tick;
        yield* service.postToChannel({ id: channel.id, text: "B", recipientIds: [reviewer.id] });
        yield* service.setPaused({ id: builder.id, paused: true });
        yield* service.delete({ id: reviewer.id });
        const after = yield* detail(channel.id);
        assert.deepEqual(
          after.messages.filter((message) => message.kind === "user").map((m) => m.status),
          ["stopped", "stopped"],
        );
        assert.isFalse(after.channel.memberIds.includes(reviewer.id));
        assert.equal(
          after.messages.find((message) => message.authorBotId === reviewer.id)?.text,
          "Assigned to a removed bot",
        );
      }),
    ),
  );

  it.effect("pages history: the latest 100 rows, with more on request", () =>
    withDb(
      Effect.gen(function* () {
        const { detail, channel } = yield* setup;
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < 150; index++) {
          const id = `bot-channel-message:${String(index).padStart(3, "0")}`;
          yield* sql`
            INSERT INTO bot_channel_messages (message_id, channel_id, kind, author_bot_id, text,
              status, created_at)
            VALUES (${id}, ${channel.id}, 'user', NULL, ${`post ${index}`}, 'completed',
              ${DateTime.formatIso(DateTime.makeUnsafe(index * 1000))})
          `;
        }
        const page = yield* detail(channel.id);
        assert.isTrue(page.hasMore);
        assert.equal(page.messages.length, 100);
        assert.equal(page.messages[0]?.text, "post 50");
        assert.equal(page.messages.at(-1)?.text, "post 149");
        const all = yield* detail(channel.id, 200);
        assert.isFalse(all.hasMore);
        assert.equal(all.messages.length, 150);
      }),
    ),
  );

  it.effect("at startup, assignments whose run is gone fail and can be continued", () =>
    withDb(
      Effect.gen(function* () {
        const first = yield* setup;
        yield* first.service.postToChannel({
          id: first.channel.id,
          text: "Interrupted",
          recipientIds: [],
        });
        // A restarted server whose thread no longer has the run.
        const restarted = yield* harness;
        const failed = yield* restarted.service.subscribeChannel({ id: first.channel.id }).pipe(
          Stream.filter((detail) => detail.messages[0]?.status === "failed"),
          Stream.runHead,
        );
        assert.equal(failed._tag, "Some");
      }),
    ),
  );
});
