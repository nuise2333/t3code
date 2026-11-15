import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type RoutingGroup,
  type RoutingSkipReason,
  type RoutingTable,
  type RoutingTaskClass,
  type RoutingTier,
  type RuntimeMode,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

import { chooseAutoModel, classifyTask, resolveRoutingGroup, routeFor } from "./routing.ts";

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
    {
      name: "a level the adapter sends as max counts as above high",
      driver: "claudeAgent",
      levels: CLAUDE_LEVELS,
      prompt: PLAN,
      mode: "plan",
      effort: "medium",
      nearest: true,
      emitted: { high: "max" },
    },
    {
      name: "a level the adapter sends as nothing is skipped",
      driver: "claudeAgent",
      levels: CLAUDE_LEVELS,
      prompt: QUESTION,
      mode: "default",
      effort: "medium",
      nearest: true,
      emitted: { low: null },
    },
  ] as const)("$name", ({ driver, levels, prompt, mode, effort, ...rest }) => {
    const emitted: Readonly<Record<string, string | null>> | undefined =
      "emitted" in rest ? rest.emitted : undefined;
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
      emittedLevel: emitted === undefined ? undefined : (id) => emitted[id],
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

describe("resolveRoutingGroup", () => {
  const NOW = Date.parse("2026-06-01T00:00:00Z");
  const codexId = ProviderInstanceId.make("codex_fake");
  const claudeId = ProviderInstanceId.make("claude_fake");
  const kiroId = ProviderInstanceId.make("kiro_fake");
  const museId = ProviderInstanceId.make("muse_fake");
  const acpId = ProviderInstanceId.make("acp_fake");
  const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
    effortSelect("reasoningEffort", ["low", "medium", "high", "xhigh"]),
    { id: "fastMode", label: "Fast", type: "boolean" },
  ];
  const provider = (
    instanceId: ProviderInstanceId,
    driver: string,
    overrides: Partial<ServerProvider> = {},
  ): ServerProvider =>
    ({
      instanceId,
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        {
          slug: "model-a",
          name: "Model A",
          aliases: ["model-a-alias"],
          isCustom: false,
          capabilities: { optionDescriptors: descriptors },
        },
      ],
      ...overrides,
    }) as unknown as ServerProvider;
  const providers = (overrides: Partial<Record<string, Partial<ServerProvider>>> = {}) => [
    provider(codexId, "codex", { showInteractionModeToggle: true, ...overrides.codex }),
    provider(claudeId, "claudeAgent", { showInteractionModeToggle: true, ...overrides.claude }),
    provider(kiroId, "kiro", {
      showInteractionModeToggle: false,
      supportedRuntimeModes: ["approval-required", "full-access"],
      ...overrides.kiro,
    }),
    provider(museId, "muse", {
      showInteractionModeToggle: false,
      supportedRuntimeModes: ["approval-required", "full-access"],
      ...overrides.muse,
    }),
    provider(acpId, "acpRegistry", overrides.acp),
  ];
  const settings = (
    overrides: Partial<Pick<ServerSettings, "projectSettingsOverrides">> = {},
  ): Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> =>
    ({
      providerInstances: Object.fromEntries(
        [
          [codexId, "codex"],
          [claudeId, "claudeAgent"],
          [kiroId, "kiro"],
          [museId, "muse"],
          [acpId, "acpRegistry"],
        ].map(([id, driver]) => [id, { driver, enabled: true }]),
      ),
      projectSettingsOverrides: {},
      ...overrides,
    }) as unknown as Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
  const member = (instanceId: ProviderInstanceId, extra: Partial<ModelSelection> = {}) => ({
    instanceId,
    model: "model-a",
    ...extra,
  });
  const group = (members: ReadonlyArray<ModelSelection>): RoutingGroup => ({
    id: "fast",
    name: "Fast",
    members,
    strategy: "order",
  });
  const projectId = ProjectId.make("project-fake");
  const resolve = (input: {
    readonly members: ReadonlyArray<ModelSelection>;
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly settings?: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly runnableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  }) =>
    resolveRoutingGroup({
      group: group(input.members),
      providers: input.providers ?? providers(),
      settings: input.settings ?? settings(),
      projectId,
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      runnableInstanceIds: input.runnableInstanceIds,
      now: NOW,
    });
  const exhausted = (resetsAt: string) =>
    ({
      usageLimits: {
        windows: [{ id: "primary", kind: "session", label: "5h", usedPercent: 100, resetsAt }],
      },
    }) as unknown as Partial<ServerProvider>;

  it.each<{
    readonly name: string;
    readonly skipped: ModelSelection;
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly settings?: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly runnableInstanceIds?: ReadonlySet<ProviderInstanceId>;
    readonly reason: RoutingSkipReason;
  }>([
    {
      name: "a missing instance",
      skipped: member(ProviderInstanceId.make("gone")),
      reason: "instance_missing",
    },
    {
      name: "a disabled instance",
      skipped: member(codexId),
      providers: providers({ codex: { enabled: false } }),
      reason: "instance_disabled",
    },
    {
      name: "an unauthenticated instance",
      skipped: member(codexId),
      providers: providers({ codex: { auth: { status: "unauthenticated" } } }),
      reason: "not_ready",
    },
    {
      name: "an uninstalled instance",
      skipped: member(codexId),
      providers: providers({ codex: { installed: false } }),
      reason: "not_ready",
    },
    {
      name: "an unavailable instance",
      skipped: member(codexId),
      providers: providers({ codex: { availability: "unavailable" } }),
      reason: "not_ready",
    },
    {
      name: "an instance whose probe failed",
      skipped: member(codexId),
      providers: providers({ codex: { status: "error" } }),
      reason: "not_ready",
    },
    {
      name: "an instance the caller cannot run",
      skipped: member(codexId),
      runnableInstanceIds: new Set([claudeId]),
      reason: "not_ready",
    },
    {
      name: "an instance the project turns off",
      skipped: member(codexId),
      settings: settings({
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [codexId]: { enabled: false } } },
        } as unknown as ServerSettings["projectSettingsOverrides"],
      }),
      reason: "project_disabled",
    },
    {
      name: "a model the instance does not list",
      skipped: member(codexId, { model: "model-retired" }),
      reason: "model_unavailable",
    },
    {
      name: "an exhausted usage window",
      skipped: member(codexId),
      providers: providers({ codex: exhausted("2026-06-01T03:00:00Z") }),
      reason: "usage_exhausted",
    },
    {
      name: "a runtime mode the provider would downgrade",
      skipped: member(kiroId),
      runtimeMode: "auto",
      reason: "runtime_mode",
    },
    {
      name: "plan mode on a provider without plan",
      skipped: member(museId),
      interactionMode: "plan",
      reason: "plan_unsupported",
    },
    {
      name: "plan mode on an ACP Registry agent that states no toggle",
      skipped: member(acpId),
      interactionMode: "plan",
      reason: "plan_unsupported",
    },
  ])("skips $name and takes the next member", (row) => {
    const result = resolve({
      members: [row.skipped, member(claudeId)],
      ...(row.providers === undefined ? {} : { providers: row.providers }),
      ...(row.settings === undefined ? {} : { settings: row.settings }),
      ...(row.runtimeMode === undefined ? {} : { runtimeMode: row.runtimeMode }),
      ...(row.interactionMode === undefined ? {} : { interactionMode: row.interactionMode }),
      ...(row.runnableInstanceIds === undefined
        ? {}
        : { runnableInstanceIds: row.runnableInstanceIds }),
    });
    expect(result).toEqual({
      ok: true,
      index: 1,
      selection: member(claudeId),
      skipped: [
        {
          index: 0,
          instanceId: row.skipped.instanceId,
          model: row.skipped.model,
          reason: row.reason,
        },
      ],
    });
  });

  it("takes the first usable member in order", () => {
    expect(resolve({ members: [member(codexId), member(claudeId)] })).toMatchObject({
      ok: true,
      index: 0,
      selection: member(codexId),
      skipped: [],
    });
  });

  it("matches a member's model by alias and keeps a window that has reset", () => {
    expect(
      resolve({
        members: [member(codexId, { model: "model-a-alias" })],
        providers: providers({ codex: exhausted("2026-05-31T23:00:00Z") }),
      }),
    ).toMatchObject({ ok: true, index: 0 });
  });

  it("does not skip instances that report no quota", () => {
    expect(resolve({ members: [member(kiroId)], runtimeMode: "approval-required" })).toMatchObject({
      ok: true,
      index: 0,
      skipped: [],
    });
  });

  it("keeps valid explicit options, even above high, and drops stale or invalid ones", () => {
    const result = resolve({
      members: [
        member(codexId, {
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "fastMode", value: "yes" },
            { id: "retiredOption", value: true },
          ],
        }),
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      selection: { ...member(codexId), options: [{ id: "reasoningEffort", value: "xhigh" }] },
    });
    expect(
      resolve({
        members: [member(codexId, { options: [{ id: "reasoningEffort", value: "ludicrous" }] })],
      }),
    ).toMatchObject({ ok: true, selection: member(codexId) });
  });

  it("lists every member's reason when none can run", () => {
    expect(
      resolve({
        members: [member(codexId), member(museId), member(ProviderInstanceId.make("gone"))],
        providers: providers({ codex: exhausted("2026-06-01T03:00:00Z") }),
        interactionMode: "plan",
      }),
    ).toEqual({
      ok: false,
      skipped: [
        { index: 0, instanceId: codexId, model: "model-a", reason: "usage_exhausted" },
        { index: 1, instanceId: museId, model: "model-a", reason: "plan_unsupported" },
        {
          index: 2,
          instanceId: ProviderInstanceId.make("gone"),
          model: "model-a",
          reason: "instance_missing",
        },
      ],
    });
  });
});

describe("chooseAutoModel", () => {
  const NOW = Date.parse("2026-06-01T00:00:00Z");
  const hoursFromNow = (hours: number) =>
    DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
  const claudeId = ProviderInstanceId.make("claude_fake");
  const claudeTwoId = ProviderInstanceId.make("claude_two_fake");
  const codexId = ProviderInstanceId.make("codex_fake");
  const codexTwoId = ProviderInstanceId.make("codex_two_fake");
  const codexThreeId = ProviderInstanceId.make("codex_three_fake");
  const cursorId = ProviderInstanceId.make("cursor_fake");
  const kiroId = ProviderInstanceId.make("kiro_fake");
  const museId = ProviderInstanceId.make("muse_fake");
  const piId = ProviderInstanceId.make("pi_fake");
  const acpId = ProviderInstanceId.make("acp_fake");
  const effort = effortSelect("effort", ["low", "medium", "high", "xhigh", "max"]);

  const row = (driver: string, model: string, tier?: RoutingTier, verified = true) => ({
    driver: ProviderDriverKind.make(driver),
    model,
    ...(tier === undefined ? {} : { tier }),
    verified,
    sourceIds: ["bench"],
  });
  const ROWS = [
    row("claudeAgent", "*", "B"),
    row("claudeAgent", "model-opus", "S"),
    row("claudeAgent", "model-sonnet", "A"),
    row("claudeAgent", "model-haiku", "C"),
    row("claudeAgent", "model-guess", "C", false),
    row("codex", "model-sol", "A"),
    row("codex", "model-luna", "C"),
    row("cursor", "auto", "C"),
    row("kiro", "default", "C"),
    row("kiro", "model-kiro", "C"),
    row("muse", "model-muse", "S"),
    row("pi", "model-pi", "C"),
    row("acpRegistry", "model-acp", "C"),
  ];
  const tableOf = (rows: RoutingTable["rows"]): RoutingTable => ({ ...table, rows });

  const provider = (
    instanceId: ProviderInstanceId,
    driver: string,
    models: ReadonlyArray<string>,
    overrides: Partial<ServerProvider> = {},
    descriptors: ReadonlyArray<ProviderOptionDescriptor> = [effort],
  ): ServerProvider =>
    ({
      instanceId,
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      showInteractionModeToggle: driver !== "muse" && driver !== "kiro",
      ...(driver === "kiro" || driver === "muse"
        ? { supportedRuntimeModes: ["approval-required", "full-access"] }
        : {}),
      models: models.map((slug) => ({
        slug,
        name: slug,
        aliases: [`${slug}-alias`],
        isCustom: false,
        capabilities: { optionDescriptors: descriptors },
      })),
      ...overrides,
    }) as unknown as ServerProvider;
  const quota = (usedPercent: number, resetsAt?: string) =>
    ({
      usageLimits: {
        windows: [
          {
            id: "primary",
            kind: "session",
            label: "5h",
            usedPercent,
            ...(resetsAt === undefined ? {} : { resetsAt }),
          },
        ],
      },
    }) as unknown as Partial<ServerProvider>;
  const CLAUDE_MODELS = ["model-opus", "model-sonnet", "model-haiku", "model-guess"];
  const claude = (overrides: Partial<ServerProvider> = {}) =>
    provider(claudeId, "claudeAgent", CLAUDE_MODELS, overrides);
  const codex = (overrides: Partial<ServerProvider> = {}) =>
    provider(codexId, "codex", ["model-sol", "model-luna"], overrides);
  const settingsFor = (providers: ReadonlyArray<ServerProvider>) =>
    ({
      providerInstances: Object.fromEntries(
        providers.map((entry) => [entry.instanceId, { driver: entry.driver, enabled: true }]),
      ),
      projectSettingsOverrides: {},
    }) as unknown as Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">;

  const choose = (input: {
    readonly current: ModelSelection;
    readonly taskClass: RoutingTaskClass;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly scope?: "instance" | "provider" | "any";
    readonly rows?: RoutingTable["rows"];
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
  }) =>
    chooseAutoModel({
      table: tableOf(input.rows ?? ROWS),
      taskClass: input.taskClass,
      current: input.current,
      scope: input.scope ?? "any",
      providers: input.providers,
      settings: settingsFor(input.providers),
      projectId: null,
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      now: NOW,
    });
  const on = (instanceId: ProviderInstanceId, model: string): ModelSelection => ({
    instanceId,
    model,
  });

  it.each<{
    readonly name: string;
    readonly current: ModelSelection;
    readonly taskClass: RoutingTaskClass;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly scope?: "instance" | "provider" | "any";
    readonly rows?: RoutingTable["rows"];
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly picks: ModelSelection;
    readonly switched: "none" | "model" | "provider";
    readonly tier: RoutingTier | null;
    readonly skipped?: number;
  }>([
    {
      name: "readonly moves to the C tier on the same instance",
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      providers: [claude(), codex()],
      picks: on(claudeId, "model-haiku"),
      switched: "model",
      tier: "C",
    },
    {
      name: "implement takes the A tier",
      current: on(claudeId, "model-opus"),
      taskClass: "implement",
      providers: [claude(), codex()],
      picks: on(claudeId, "model-sonnet"),
      switched: "model",
      tier: "A",
    },
    {
      name: "hard takes the S tier",
      current: on(claudeId, "model-haiku"),
      taskClass: "hard",
      providers: [claude(), codex()],
      picks: on(claudeId, "model-opus"),
      switched: "model",
      tier: "S",
    },
    {
      name: "quick_edit with no B candidate takes the next tier up",
      current: on(claudeId, "model-opus"),
      taskClass: "quick_edit",
      providers: [claude(), codex()],
      picks: on(claudeId, "model-sonnet"),
      switched: "model",
      tier: "A",
    },
    {
      name: "the current model stays when it sits in the chosen tier",
      current: on(claudeId, "model-sonnet"),
      taskClass: "implement",
      providers: [claude(), codex()],
      picks: on(claudeId, "model-sonnet"),
      switched: "none",
      tier: "A",
    },
    {
      name: "the current model matched by alias stays",
      current: on(claudeId, "model-sonnet-alias"),
      taskClass: "implement",
      providers: [claude(), codex()],
      picks: on(claudeId, "model-sonnet-alias"),
      switched: "none",
      tier: "A",
    },
    {
      name: "no candidate at or above the tier keeps the selection",
      current: on(codexId, "model-luna"),
      taskClass: "hard",
      providers: [codex()],
      picks: on(codexId, "model-luna"),
      switched: "none",
      tier: "C",
    },
    {
      name: "a model without a verified row reports no tier",
      current: on(codexId, "model-other"),
      taskClass: "hard",
      providers: [provider(codexId, "codex", ["model-other", "model-luna"])],
      picks: on(codexId, "model-other"),
      switched: "none",
      tier: null,
    },
    {
      name: "unverified, wildcard, opaque router, Pi and ACP rows are never candidates",
      current: on(codexId, "model-sol"),
      taskClass: "readonly",
      providers: [
        codex({}),
        provider(claudeId, "claudeAgent", ["model-guess", "model-any"]),
        provider(cursorId, "cursor", ["auto"]),
        provider(kiroId, "kiro", ["default"]),
        provider(piId, "pi", ["model-pi"]),
        provider(acpId, "acpRegistry", ["model-acp"]),
      ],
      rows: ROWS.filter((entry) => entry.model !== "model-luna"),
      picks: on(codexId, "model-sol"),
      switched: "none",
      tier: "A",
      skipped: 0,
    },
    {
      name: "a user's own opaque router keeps its model",
      current: on(cursorId, "auto"),
      taskClass: "readonly",
      providers: [provider(cursorId, "cursor", ["auto"]), claude()],
      picks: on(cursorId, "auto"),
      switched: "none",
      tier: null,
    },
    {
      name: "instance scope never leaves the thread's instance",
      current: on(codexId, "model-sol"),
      taskClass: "readonly",
      scope: "instance",
      providers: [provider(codexId, "codex", ["model-sol"]), claude()],
      picks: on(codexId, "model-sol"),
      switched: "none",
      tier: "A",
    },
    {
      name: "provider scope never moves to another model on the thread's instance",
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      scope: "provider",
      providers: [claude(), codex()],
      picks: on(codexId, "model-luna"),
      switched: "provider",
      tier: "C",
    },
    {
      name: "provider scope keeps the current model when it ties another instance",
      current: on(claudeId, "model-haiku"),
      taskClass: "readonly",
      scope: "provider",
      providers: [claude(), codex()],
      picks: on(claudeId, "model-haiku"),
      switched: "none",
      tier: "C",
    },
    {
      name: "provider scope moves to another driver",
      current: on(codexId, "model-sol"),
      taskClass: "readonly",
      providers: [provider(codexId, "codex", ["model-sol"]), claude()],
      picks: on(claudeId, "model-haiku"),
      switched: "provider",
      tier: "C",
    },
    {
      name: "provider scope moves to a second instance of the same driver",
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      providers: [
        provider(claudeId, "claudeAgent", ["model-opus"]),
        provider(claudeTwoId, "claudeAgent", ["model-haiku"]),
      ],
      picks: on(claudeTwoId, "model-haiku"),
      switched: "provider",
      tier: "C",
    },
    {
      name: "an exhausted current instance loses its preference",
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      providers: [claude(quota(100, hoursFromNow(3))), codex()],
      picks: on(codexId, "model-luna"),
      switched: "provider",
      tier: "C",
      skipped: 3,
    },
    {
      name: "a runtime mode the target would downgrade is skipped",
      current: on(kiroId, "model-x"),
      taskClass: "readonly",
      runtimeMode: "auto",
      providers: [provider(kiroId, "kiro", ["model-x", "model-kiro"]), codex()],
      picks: on(codexId, "model-luna"),
      switched: "provider",
      tier: "C",
      skipped: 1,
    },
    {
      name: "a plan thread skips a provider without plan",
      current: on(claudeId, "model-haiku"),
      taskClass: "hard",
      interactionMode: "plan",
      providers: [
        provider(claudeId, "claudeAgent", ["model-haiku"]),
        provider(museId, "muse", ["model-muse"]),
      ],
      picks: on(claudeId, "model-haiku"),
      switched: "none",
      tier: "C",
      skipped: 1,
    },
    {
      name: "a target whose default turns Ultracode on is skipped",
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      providers: [
        provider(claudeId, "claudeAgent", ["model-opus"]),
        provider(claudeTwoId, "claudeAgent", ["model-haiku"], {}, [
          effort,
          { id: "ultracode", label: "Ultracode", type: "boolean", currentValue: true },
        ]),
        codex(),
      ],
      picks: on(codexId, "model-luna"),
      switched: "provider",
      tier: "C",
      skipped: 1,
    },
    {
      name: "a target whose default turns Fast mode on is skipped",
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      providers: [
        provider(claudeId, "claudeAgent", ["model-opus"]),
        provider(claudeTwoId, "claudeAgent", ["model-haiku"], {}, [
          effort,
          { id: "fastMode", label: "Fast", type: "boolean", currentValue: true },
        ]),
        codex(),
      ],
      picks: on(codexId, "model-luna"),
      switched: "provider",
      tier: "C",
      skipped: 1,
    },
    {
      name: "a target whose default context is not the smallest is skipped",
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      providers: [
        provider(claudeId, "claudeAgent", ["model-opus"]),
        provider(claudeTwoId, "claudeAgent", ["model-haiku"], {}, [
          effort,
          {
            id: "contextWindow",
            label: "Context",
            type: "select",
            options: [
              { id: "200k", label: "200k" },
              { id: "1m", label: "1M", isDefault: true },
            ],
          },
        ]),
        codex(),
      ],
      picks: on(codexId, "model-luna"),
      switched: "provider",
      tier: "C",
      skipped: 1,
    },
  ])("$name", (row) => {
    const choice = choose(row);
    expect(choice.selection).toEqual(row.picks);
    expect(choice.switched).toBe(row.switched);
    expect(choice.tier).toBe(row.tier);
    if (row.skipped !== undefined) expect(choice.skipped).toBe(row.skipped);
  });

  it("drops the old selection's options and keeps them when it stays", () => {
    const current: ModelSelection = {
      instanceId: claudeId,
      model: "model-opus",
      options: [
        { id: "fastMode", value: true },
        { id: "effort", value: "max" },
      ],
    };
    const providers = [claude(), codex()];
    expect(choose({ current, taskClass: "readonly", providers }).selection).toEqual(
      on(claudeId, "model-haiku"),
    );
    expect(choose({ current, taskClass: "hard", providers }).selection).toEqual(current);
  });

  it("prefers the current instance over another with more quota", () => {
    const choice = choose({
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      providers: [codex(quota(0, hoursFromNow(1))), claude(quota(80, hoursFromNow(100)))],
    });
    expect(choice.selection).toEqual(on(claudeId, "model-haiku"));
  });

  it.each<{
    readonly name: string;
    readonly windows: ReadonlyArray<Partial<ServerProvider>>;
    readonly picks: ProviderInstanceId;
  }>([
    {
      name: "known quota above the reserve beats unknown quota",
      windows: [{}, quota(50, hoursFromNow(5)), quota(90, hoursFromNow(1))],
      picks: codexTwoId,
    },
    {
      name: "unknown quota beats quota inside the 15% reserve",
      windows: [{}, quota(90, hoursFromNow(1)), quota(86, hoursFromNow(1))],
      picks: codexId,
    },
    {
      name: "remaining share that resets soonest wins",
      windows: [
        quota(20, hoursFromNow(100)),
        quota(40, hoursFromNow(2)),
        quota(10, hoursFromNow(50)),
      ],
      picks: codexTwoId,
    },
    {
      name: "unknown quota is still picked when it is all there is",
      windows: [{}, quota(100, hoursFromNow(2)), quota(100, hoursFromNow(2))],
      picks: codexId,
    },
  ])("ranks equal-tier candidates: $name", ({ windows, picks }) => {
    const ids = [codexId, codexTwoId, codexThreeId];
    const choice = choose({
      current: on(claudeId, "model-opus"),
      taskClass: "readonly",
      providers: [
        provider(claudeId, "claudeAgent", ["model-opus"]),
        ...ids.map((id, index) => provider(id, "codex", ["model-luna"], windows[index])),
      ],
    });
    expect(choice.selection).toEqual(on(picks, "model-luna"));
    expect(choice.switched).toBe("provider");
  });
});
