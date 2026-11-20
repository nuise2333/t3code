import { assert, describe, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  type BotMemory,
  BotMemoryId,
  BOT_MAX_DELEGATION_DEPTH,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { botBrief, identityOf, identityOrNull } from "./BotDirectory.ts";

const at = "2026-01-01T00:00:00.000Z";

const makeBot = (id: string, overrides: Partial<Bot> = {}): Bot => ({
  id: BotId.make(id),
  name: id,
  handle: id,
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

const memory = (index: number, text: string): BotMemory => ({
  id: BotMemoryId.make(`m${index}`),
  botId: BotId.make("lead"),
  text,
  source: "bot",
  createdAt: at,
});

const DISPATCHER_TEXT = "You are the team's dispatcher.";
const NO_DELEGATION = "Handing work to teammates is not available here.";

describe("botBrief", () => {
  const lead = makeBot("lead", { dispatcher: true, title: "Lead", instructions: "Be brief." });
  const builder = makeBot("builder", { title: "Engineer" });

  it.each([
    [
      "a dispatcher with teammates",
      [lead, builder],
      null,
      [DISPATCHER_TEXT, "bot_send_message"],
      [NO_DELEGATION],
    ],
    ["a dispatcher alone", [lead], null, [NO_DELEGATION], [DISPATCHER_TEXT]],
    [
      "a task under the depth limit",
      [lead, builder],
      { requester: "@builder", depth: BOT_MAX_DELEGATION_DEPTH - 1 },
      ["task @builder handed you", "bot_send_message"],
      [DISPATCHER_TEXT, NO_DELEGATION],
    ],
    [
      "a task at the depth limit",
      [lead, builder],
      { requester: "@builder", depth: BOT_MAX_DELEGATION_DEPTH },
      ["task @builder handed you", NO_DELEGATION],
      [DISPATCHER_TEXT, "bot_send_message`"],
    ],
  ] as const)("%s", (_label, bots, task, present, absent) => {
    const brief = botBrief({ bot: lead, bots, memories: [], task });
    assert.include(brief, "You are lead (@lead), Lead");
    assert.include(brief, "Be brief.");
    for (const text of present) assert.include(brief, text);
    for (const text of absent) assert.notInclude(brief, text);
  });

  it("lists teammates but not the bot itself", () => {
    const brief = botBrief({ bot: builder, bots: [lead, builder], memories: [], task: null });
    assert.include(brief, "- @lead: lead, Lead (dispatcher; a message to it gets no reply)");
    assert.notInclude(brief, "- @builder");
    assert.include(brief, "This is your own chat with the user.");
  });

  it("keeps the newest memories within the budget, oldest first", () => {
    const filler = "x".repeat(490);
    const memories = Array.from({ length: 30 }, (_, index) => memory(index, `${index} ${filler}`));
    const brief = botBrief({ bot: lead, bots: [lead], memories, task: null });
    const listed = [...brief.matchAll(/- \[m(\d+)\]/g)].map((match) => Number(match[1]));
    assert.isAbove(listed.length, 0);
    assert.isBelow(listed.length, 30);
    assert.deepEqual(
      listed,
      Array.from({ length: listed.length }, (_, i) => 30 - listed.length + i),
    );
    assert.include(botBrief({ bot: lead, bots: [lead], memories: [], task: null }), "None yet.");
  });
});

const insertBot = (sql: SqlClient.SqlClient, bot: Bot) =>
  sql`INSERT INTO bots ${sql.insert({
    bot_id: bot.id,
    name: bot.name,
    handle: bot.handle,
    title: bot.title,
    instructions: bot.instructions,
    dispatcher: bot.dispatcher ? 1 : 0,
    model_selection_json: JSON.stringify(bot.modelSelection),
    runtime_mode: bot.runtimeMode,
    project_id: bot.projectId,
    home_thread_id: bot.homeThreadId,
    avatar: bot.avatar,
    color: bot.color,
    created_at: bot.createdAt,
    updated_at: bot.updatedAt,
  })}`;

describe("identityOf", () => {
  it.effect("tells a bot's home chat from a task thread and anything else", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const home = ThreadId.make("thread:home");
      yield* insertBot(
        sql,
        makeBot("builder", {
          title: "Engineer",
          homeThreadId: home,
          createdAt: "2026-02-01T00:00:00.000Z",
        }),
      );
      yield* sql`INSERT INTO bot_tasks ${sql.insert({
        thread_id: "thread:task",
        task_id: "task:1",
        bot_id: "builder",
        requester_thread_id: "thread:lead",
        requester_bot_id: "lead",
        title: "Fix the build",
        depth: 2,
        status: "waiting",
        nudged_at: null,
        created_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      })}`;

      const homeIdentity = yield* identityOf(sql, home);
      assert.equal(homeIdentity?.kind, "home");
      assert.equal(homeIdentity?.depth, 0);
      assert.equal(homeIdentity?.bot.handle, "builder");

      const taskIdentity = yield* identityOf(sql, ThreadId.make("thread:task"));
      assert.equal(taskIdentity?.kind, "task");
      if (taskIdentity?.kind !== "task") return;
      assert.equal(taskIdentity.depth, 2);
      // Task and bot share column names; each keeps its own.
      assert.equal(taskIdentity.task.title, "Fix the build");
      assert.equal(taskIdentity.bot.title, "Engineer");
      assert.equal(taskIdentity.bot.createdAt, "2026-02-01T00:00:00.000Z");
      assert.equal(taskIdentity.task.createdAt, "2026-03-01T00:00:00.000Z");
      assert.equal(taskIdentity.task.status, "waiting");
      assert.equal(taskIdentity.task.requesterBotId, "lead");

      assert.isNull(yield* identityOf(sql, ThreadId.make("thread:other")));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("answers null when the bot tables do not exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.isNull(yield* identityOrNull(sql, ThreadId.make("thread:any")));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
