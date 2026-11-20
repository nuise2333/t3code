import {
  BotId,
  MAX_BOTS,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BotTask,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOT_TEAM_TEMPLATES,
  botDraftErrors,
  botSchedules,
  botUpsertInputFromDraft,
  emptyBotDraft,
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
