import {
  BotId,
  EnvironmentId,
  MAX_BOTS,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Bot,
  type BotTask,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import {
  BOT_TEAM_TEMPLATES,
  activeBotId,
  botDraftErrors,
  botSchedules,
  botUpsertInputFromDraft,
  emptyBotDraft,
  resolveBotsEnvironmentId,
  tasksByBot,
  templateUpsertInputs,
} from "./botsPage.logic";

const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };

function task(botId: string, threadId: string): BotTask {
  return {
    threadId: ThreadId.make(threadId),
    taskId: NodeId.make(`node-${threadId}`),
    botId: BotId.make(botId),
    requesterThreadId: ThreadId.make("home"),
    requesterBotId: null,
    title: threadId,
    depth: 1,
    status: "working",
    nudgedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("botUpsertInputFromDraft", () => {
  it("trims fields and leaves handle and project to the server when blank", () => {
    const input = botUpsertInputFromDraft({
      ...emptyBotDraft(model),
      name: "  Builder ",
      handle: " ",
      title: " Engineer ",
      instructions: " Ship it. ",
      avatar: " ",
    });
    expect(input).toEqual({
      name: "Builder",
      title: "Engineer",
      instructions: "Ship it.",
      dispatcher: false,
      modelSelection: model,
      runtimeMode: "full-access",
      avatar: "🤖",
      color: "blue",
    });
  });

  it("keeps the id, handle and project of an edited bot", () => {
    const input = botUpsertInputFromDraft({
      ...emptyBotDraft(model),
      id: BotId.make("bot-1"),
      name: "Builder",
      handle: "build-2",
      projectId: ProjectId.make("project-1"),
    });
    expect(input).toMatchObject({ id: "bot-1", handle: "build-2", projectId: "project-1" });
  });

  it("moves an edited bot back to No project when its project is cleared", () => {
    const input = botUpsertInputFromDraft({
      ...emptyBotDraft(model),
      id: BotId.make("bot-1"),
      name: "Builder",
    });
    expect(input?.projectId).toBeNull();
  });

  it("refuses an invalid draft", () => {
    expect(botUpsertInputFromDraft({ ...emptyBotDraft(model), name: "  " })).toBeNull();
    expect(botUpsertInputFromDraft({ ...emptyBotDraft(null), name: "Builder" })).toBeNull();
  });
});

describe("botDraftErrors", () => {
  it.each([
    ["Builder", "builder", 0],
    ["Builder", "", 0],
    ["", "builder", 1],
    ["Builder", "Builder", 1],
    ["Builder", "-builder", 1],
    ["Builder", "build_er", 1],
    ["Builder", "a".repeat(33), 1],
  ])("name %j, handle %j has %i errors", (name, handle, count) => {
    expect(botDraftErrors({ ...emptyBotDraft(model), name, handle })).toHaveLength(count);
  });
});

describe("templateUpsertInputs", () => {
  it("builds valid inputs with exactly one dispatcher per template", () => {
    for (const template of BOT_TEAM_TEMPLATES) {
      const result = templateUpsertInputs(template, model, 0);
      if (!result.ok) throw new Error(result.error);
      expect(result.inputs.filter((input) => input.dispatcher)).toHaveLength(1);
      for (const input of result.inputs) {
        expect(input.modelSelection).toBe(model);
        expect(input.handle).toBeUndefined();
        expect(input.instructions.length).toBeGreaterThan(0);
      }
    }
  });

  it("refuses without a model or past the bot limit", () => {
    const template = BOT_TEAM_TEMPLATES[0]!;
    expect(templateUpsertInputs(template, null, 0).ok).toBe(false);
    expect(templateUpsertInputs(template, model, MAX_BOTS - template.bots.length).ok).toBe(true);
    expect(templateUpsertInputs(template, model, MAX_BOTS - template.bots.length + 1).ok).toBe(
      false,
    );
  });
});

describe("tasksByBot", () => {
  it("groups tasks per bot and keeps their order", () => {
    const grouped = tasksByBot([task("a", "t1"), task("b", "t2"), task("a", "t3")]);
    expect(grouped.get(BotId.make("a"))?.map((entry) => entry.threadId)).toEqual(["t1", "t3"]);
    expect(grouped.get(BotId.make("b"))?.map((entry) => entry.threadId)).toEqual(["t2"]);
  });
});

describe("botSchedules", () => {
  const scheduled = [
    { threadId: ThreadId.make("home-a") },
    { threadId: null },
    { threadId: ThreadId.make("other") },
  ] as unknown as ReadonlyArray<ScheduledTask>;

  it("picks the schedules bound to the bot's home thread", () => {
    expect(botSchedules(scheduled, { homeThreadId: ThreadId.make("home-a") })).toEqual([
      scheduled[0],
    ]);
  });

  it("has none before the bot's chat exists", () => {
    expect(botSchedules(scheduled, { homeThreadId: null })).toEqual([]);
  });
});

function bot(id: string, name: string, handle: string, title: string, home: string | null): Bot {
  return {
    id: BotId.make(id),
    name,
    handle,
    title,
    instructions: "",
    dispatcher: false,
    modelSelection: model,
    runtimeMode: "full-access",
    projectId: ProjectId.make("project-1"),
    homeThreadId: home === null ? null : ThreadId.make(home),
    avatar: "🤖",
    color: "blue",
    paused: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const builder = bot("b1", "Builder", "builder", "Software engineer", "home-1");
const reviewer = bot("b2", "Reviewer", "rev", "Code reviewer", null);

describe("activeBotId", () => {
  const env = EnvironmentId.make("env-1");

  it("finds the bot whose chat is open in the same environment", () => {
    const bots = [builder, reviewer];
    expect(activeBotId(bots, env, scopeThreadRef(env, ThreadId.make("home-1")))).toBe("b1");
    expect(activeBotId(bots, env, scopeThreadRef(env, ThreadId.make("other")))).toBeNull();
    const elsewhere = scopeThreadRef(EnvironmentId.make("env-2"), ThreadId.make("home-1"));
    expect(activeBotId(bots, env, elsewhere)).toBeNull();
    expect(activeBotId(bots, env, null)).toBeNull();
  });
});

describe("resolveBotsEnvironmentId", () => {
  const [a, b, c] = ["a", "b", "c"].map((id) => EnvironmentId.make(id)) as [
    EnvironmentId,
    EnvironmentId,
    EnvironmentId,
  ];

  it.each([
    [b, a, [a, b], b],
    [c, a, [a, b], a],
    [null, c, [a, b], a],
    [null, null, [], null],
  ] as const)("picked %j, primary %j, connected %j gives %j", (picked, primary, connected, id) => {
    expect(resolveBotsEnvironmentId(picked, primary, connected)).toBe(id);
  });
});
