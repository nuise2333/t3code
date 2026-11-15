import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type RoutingTable,
} from "@t3tools/contracts";

import { classifyTask, routeFor } from "./routing.ts";

const table: RoutingTable = {
  version: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  sources: { bench: { url: "https://example.test/bench", dataDate: "2026-01-01" } },
  defaultEffortByClass: {
    readonly: "low",
    quick_edit: "medium",
    implement: "medium",
    hard: "high",
  },
  rows: [
    { driver: ProviderDriverKind.make("codex"), model: "*", sourceIds: ["bench"] },
    {
      driver: ProviderDriverKind.make("codex"),
      model: "model-steady",
      effortByClass: { readonly: "high" },
      sourceIds: ["bench"],
    },
    {
      driver: ProviderDriverKind.make("antigravity"),
      model: "*",
      effortByClass: {
        readonly: "medium",
        quick_edit: "medium",
        implement: "medium",
        hard: "medium",
      },
      sourceIds: ["bench"],
    },
    { driver: ProviderDriverKind.make("pi"), model: "*", sourceIds: ["bench"] },
    { driver: ProviderDriverKind.make("claudeAgent"), model: "*", sourceIds: ["bench"] },
    { driver: ProviderDriverKind.make("acpRegistry"), model: "*", sourceIds: ["bench"] },
  ],
};

const effortSelect = (
  id: string,
  levels: ReadonlyArray<string>,
  extra: Partial<Extract<ProviderOptionDescriptor, { type: "select" }>> = {},
): ProviderOptionDescriptor => ({
  id,
  label: "Reasoning",
  type: "select",
  options: levels.map((level) => ({ id: level, label: level })),
  ...extra,
});

const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"];

const selection = (model = "model-any", options?: ModelSelection["options"]): ModelSelection => ({
  instanceId: ProviderInstanceId.make("primary"),
  model,
  ...(options === undefined ? {} : { options }),
});

const PLAN = "Plan the new checkout flow.";
const QUESTION = "Why does the sidebar flicker?";

describe("classifyTask", () => {
  it.each([
    { prompt: "rename foo to bar", mode: "plan", taskClass: "hard", reason: "plan_mode" },
    {
      prompt: "Look at src/a.ts, src/b.ts and lib/c.ts and tidy them",
      mode: "default",
      taskClass: "implement",
      reason: ["many_paths", "default_class"],
    },
    {
      prompt: "Refactor the session store into services",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt: "Refactor src/session/store.ts and src/session/cache.ts into services",
      mode: "default",
      taskClass: "hard",
      reason: "hard_keyword",
    },
    {
      prompt: "Refactor the auth checks across the server packages",
      mode: "default",
      taskClass: "hard",
      reason: "hard_keyword",
    },
    {
      prompt: "Upgrade React to the latest version",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt: "把数据库层迁移到新驱动",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt: "Migrate the session store to the new database driver",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    { prompt: "重构登录模块", mode: "default", taskClass: "implement", reason: "default_class" },
    {
      prompt: "重构登录模块，跨 server 和 web 两个包",
      mode: "default",
      taskClass: "hard",
      reason: "hard_keyword",
    },
    {
      prompt: "跨模块统一错误处理",
      mode: "default",
      taskClass: "hard",
      reason: "hard_keyword",
    },
    {
      prompt: "升级依赖到最新版",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt: "Fix the typo in README.md",
      mode: "default",
      taskClass: "quick_edit",
      reason: "quick_keyword",
    },
    {
      prompt: "change the button label to Save",
      mode: "default",
      taskClass: "quick_edit",
      reason: "quick_keyword",
    },
    {
      prompt: "把标题改成 Settings",
      mode: "default",
      taskClass: "quick_edit",
      reason: "quick_keyword",
    },
    {
      prompt: "把 fetchUser 改名为 loadUser",
      mode: "default",
      taskClass: "quick_edit",
      reason: "quick_keyword",
    },
    {
      prompt: "修正 README.md 里的拼写",
      mode: "default",
      taskClass: "quick_edit",
      reason: "quick_keyword",
    },
    { prompt: QUESTION, mode: "default", taskClass: "readonly", reason: "question" },
    { prompt: "这个函数为什么慢", mode: "default", taskClass: "readonly", reason: "question" },
    { prompt: "怎么启动开发服务器", mode: "default", taskClass: "readonly", reason: "question" },
    {
      prompt: "说明一下 routing.ts 的作用",
      mode: "default",
      taskClass: "readonly",
      reason: "question",
    },
    {
      prompt: "Why is this test failing?",
      mode: "default",
      taskClass: "hard",
      reason: "debug_keyword",
    },
    {
      prompt: "Why is login broken? Fix it.",
      mode: "default",
      taskClass: "hard",
      reason: "debug_keyword",
    },
    {
      prompt: "Find the root cause of the flaky upload test",
      mode: "default",
      taskClass: "hard",
      reason: "debug_keyword",
    },
    { prompt: "为什么构建报错", mode: "default", taskClass: "hard", reason: "debug_keyword" },
    { prompt: "排查一下这个崩溃", mode: "default", taskClass: "hard", reason: "debug_keyword" },
    { prompt: "为什么页面不刷新", mode: "default", taskClass: "hard", reason: "debug_keyword" },
    {
      prompt: "Why does login crash when I change the locale to fr?",
      mode: "default",
      taskClass: "hard",
      reason: "debug_keyword",
    },
    {
      prompt: "Why doesn't login work?",
      mode: "default",
      taskClass: "hard",
      reason: "debug_keyword",
    },
    {
      prompt: "Why won't the build work on CI",
      mode: "default",
      taskClass: "hard",
      reason: "debug_keyword",
    },
    {
      prompt: "Update packages/debug/README.md with the new flag",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt: "Add a regression test for the parser",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    { prompt: "为什么不用 zod？", mode: "default", taskClass: "readonly", reason: "question" },
    {
      prompt: "解释一下这个项目的架构",
      mode: "default",
      taskClass: "readonly",
      reason: "question",
    },
    {
      prompt: "更新 README 的安装说明",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt: "写一份 routing 的使用说明",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt: "重构跨域请求处理",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    { prompt: "重写整个同步层", mode: "default", taskClass: "hard", reason: "hard_keyword" },
    {
      prompt: "Add a retry button to the error banner",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt:
        "Why does this print undefined?\n```ts\nimport a from 'src/a.ts';\nimport b from 'src/b.ts';\nimport c from 'lib/c.ts';\n```",
      mode: "default",
      taskClass: "readonly",
      reason: "question",
    },
    {
      prompt:
        'Explain this output\n    at render (src/a.tsx:10:5)\n    at commit (src/b.tsx:20:3)\n  File "app/main.py", line 3, in <module>',
      mode: "default",
      taskClass: "readonly",
      reason: "question",
    },
  ] as const)("$prompt in $mode mode is $taskClass", ({ prompt, mode, taskClass, reason }) => {
    expect(classifyTask({ prompt, interactionMode: mode })).toEqual({
      taskClass,
      reasons: [reason].flat(),
    });
  });

  it("does not count a URL as a file path", () => {
    expect(
      classifyTask({
        prompt: "Explain https://a.test/x/y https://b.test/x/y https://c.test/x/y",
        interactionMode: "default",
      }).taskClass,
    ).toBe("readonly");
  });
});

describe("routeFor", () => {
  it.each([
    {
      name: "a hard task gets high, never xhigh or max",
      driver: "claudeAgent",
      levels: CLAUDE_LEVELS,
      prompt: PLAN,
      mode: "plan",
      effort: "high",
    },
    {
      name: "a hard task on a ladder above high stops at high",
      driver: "codex",
      levels: ["minimal", "low", "medium", "high", "xhigh"],
      prompt: PLAN,
      mode: "plan",
      effort: "high",
    },
    {
      name: "a missing level falls to the nearest lower one",
      driver: "codex",
      levels: ["low", "high", "xhigh"],
      prompt: "Add a retry button",
      mode: "default",
      effort: "low",
      nearest: true,
    },
    {
      name: "a missing level rises when the lower one is below the model's default",
      driver: "codex",
      levels: ["low", "high", "max"],
      defaultLevel: "high",
      prompt: "Fix the typo in README.md",
      mode: "default",
      effort: "high",
      nearest: true,
    },
    {
      name: "no signal keeps the model's default level",
      driver: "codex",
      levels: ["low", "medium", "high"],
      defaultLevel: "high",
      prompt: "Add a retry button",
      mode: "default",
      effort: "high",
    },
    {
      name: "no signal on a default above high stops at high",
      driver: "codex",
      levels: ["low", "medium", "high", "xhigh"],
      defaultLevel: "xhigh",
      prompt: "Add a retry button",
      mode: "default",
      effort: "high",
    },
    {
      name: "a question still lowers a high default",
      driver: "codex",
      levels: ["low", "medium", "high"],
      defaultLevel: "high",
      prompt: QUESTION,
      mode: "default",
      effort: "low",
    },
    {
      name: "with no lower level it rises, but not past high",
      driver: "codex",
      levels: ["high", "xhigh", "max"],
      prompt: QUESTION,
      mode: "default",
      effort: "high",
      nearest: true,
    },
    {
      name: "no low, medium or high leaves the selection unchanged",
      driver: "codex",
      levels: ["xhigh", "max", "ultra"],
      prompt: PLAN,
      mode: "plan",
      effort: null,
    },
  ] as const)("$name", ({ driver, levels, prompt, mode, effort, ...rest }) => {
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make(driver),
      selection: selection(),
      descriptors: [
        effortSelect(
          driver === "claudeAgent" ? "effort" : "reasoningEffort",
          levels,
          "defaultLevel" in rest ? { currentValue: rest.defaultLevel } : {},
        ),
      ],
      prompt,
      interactionMode: mode,
      apply: true,
    });
    expect(result.decision.effort).toBe(effort);
    expect(result.decision.reasons.includes("nearest_level")).toBe("nearest" in rest);
    if (effort === null) expect(result.selection).toEqual(selection());
  });

  it("skips levels the provider injects into the prompt", () => {
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make("codex"),
      selection: selection(),
      descriptors: [
        effortSelect("reasoningEffort", ["low", "medium", "high"], {
          promptInjectedValues: ["high"],
        }),
      ],
      prompt: PLAN,
      interactionMode: "plan",
      apply: true,
    });
    expect(result.decision.effort).toBe("medium");
  });

  it("applies the effort and keeps every other option", () => {
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make("codex"),
      selection: selection("model-any", [
        { id: "fastMode", value: true },
        { id: "reasoningEffort", value: "xhigh" },
        { id: "contextWindow", value: "1m" },
      ]),
      descriptors: [
        { id: "fastMode", label: "Fast", type: "boolean" },
        effortSelect("reasoningEffort", ["low", "medium", "high", "xhigh"]),
      ],
      prompt: QUESTION,
      interactionMode: "default",
      apply: true,
    });
    expect(result.selection.options).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "low" },
      { id: "contextWindow", value: "1m" },
    ]);
    expect(result.decision).toEqual({
      taskClass: "readonly",
      effort: "low",
      optionId: "reasoningEffort",
      baseline: "xhigh",
      applied: true,
      reasons: ["question"],
      tableUpdatedAt: table.updatedAt,
    });
  });

  it("records a shadow decision without changing the selection", () => {
    const original = selection("model-any", [{ id: "reasoningEffort", value: "medium" }]);
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make("codex"),
      selection: original,
      descriptors: [effortSelect("reasoningEffort", ["low", "medium", "high"])],
      prompt: PLAN,
      interactionMode: "plan",
      apply: false,
    });
    expect(result.selection).toBe(original);
    expect(result.decision).toMatchObject({ effort: "high", applied: false, baseline: "medium" });
  });

  it("prefers an exact model row over the driver's wildcard row", () => {
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make("codex"),
      selection: selection("model-steady"),
      descriptors: [effortSelect("reasoningEffort", ["low", "medium", "high"])],
      prompt: QUESTION,
      interactionMode: "default",
      apply: true,
    });
    expect(result.decision.effort).toBe("high");
    expect(result.decision.reasons).toEqual(["question", "model_row"]);
    // A selection may name an alias; the row matches the model it resolves to.
    const aliased = routeFor({
      table,
      driver: ProviderDriverKind.make("codex"),
      selection: selection("steady"),
      modelSlug: "model-steady",
      descriptors: [effortSelect("reasoningEffort", ["low", "medium", "high"])],
      prompt: QUESTION,
      interactionMode: "default",
      apply: true,
    });
    expect(aliased.decision.reasons).toEqual(["question", "model_row"]);
    expect(aliased.selection.model).toBe("steady");
  });

  it.each([
    { name: "Ultrathink in the prompt", prompt: "ultrathink: why is login slow?", options: [] },
    {
      name: "Ultracode turned on",
      prompt: QUESTION,
      options: [{ id: "ultracode", value: true }],
    },
    {
      name: "the legacy Ultracode level",
      prompt: QUESTION,
      options: [{ id: "effort", value: "ultracode" }],
    },
  ] as const)("keeps the level set by $name", ({ prompt, options }) => {
    const original = selection("model-any", options);
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make("claudeAgent"),
      selection: original,
      descriptors: [
        effortSelect("effort", ["low", "medium", "high", "xhigh", "ultrathink"], {
          promptInjectedValues: ["ultrathink"],
        }),
        { id: "ultracode", label: "Ultracode", type: "boolean" },
      ],
      prompt,
      interactionMode: "default",
      apply: true,
    });
    expect(result.selection).toBe(original);
    expect(result.decision).toMatchObject({ effort: null, applied: false });
    expect(result.decision.reasons.at(-1)).toBe("user_choice");
  });

  it("routes Antigravity to medium through its reasoning-role control", () => {
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make("antigravity"),
      selection: selection(),
      descriptors: [
        effortSelect("thought_level", ["low", "medium", "high"], { role: "reasoning" }),
      ],
      prompt: PLAN,
      interactionMode: "plan",
      apply: true,
    });
    expect(result.selection.options).toEqual([{ id: "thought_level", value: "medium" }]);
  });

  it("routes Pi through its thinking control", () => {
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make("pi"),
      selection: selection(),
      descriptors: [effortSelect("thinking", ["off", "minimal", "low", "medium", "high", "xhigh"])],
      prompt: PLAN,
      interactionMode: "plan",
      apply: true,
    });
    expect(result.selection.options).toEqual([{ id: "thinking", value: "high" }]);
  });

  it.each([
    { name: "ACP Registry, even with a table row", driver: "acpRegistry", reason: "no_row" },
    { name: "a driver with no row", driver: "kiro", reason: "no_row" },
  ])("leaves $name unchanged", ({ driver, reason }) => {
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make(driver),
      selection: selection(),
      descriptors: [
        effortSelect("thought_level", ["low", "medium", "high"], { role: "reasoning" }),
      ],
      prompt: PLAN,
      interactionMode: "plan",
      apply: true,
    });
    expect(result.selection).toEqual(selection());
    expect(result.decision).toMatchObject({ effort: null, applied: false });
    expect(result.decision.reasons.at(-1)).toBe(reason);
  });

  it("leaves a model without a reasoning control unchanged", () => {
    const result = routeFor({
      table,
      driver: ProviderDriverKind.make("codex"),
      selection: selection(),
      descriptors: [{ id: "fastMode", label: "Fast", type: "boolean" }],
      prompt: PLAN,
      interactionMode: "plan",
      apply: true,
    });
    expect(result.decision).toMatchObject({
      effort: null,
      applied: false,
      reasons: ["plan_mode", "no_effort_control"],
    });
  });
});
