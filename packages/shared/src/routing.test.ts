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
      taskClass: "hard",
      reason: "many_paths",
    },
    {
      prompt: "Refactor the session store into services",
      mode: "default",
      taskClass: "hard",
      reason: "hard_keyword",
    },
    {
      prompt: "把数据库层迁移到新驱动",
      mode: "default",
      taskClass: "hard",
      reason: "hard_keyword",
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
    { prompt: QUESTION, mode: "default", taskClass: "readonly", reason: "question" },
    { prompt: "这个函数为什么慢", mode: "default", taskClass: "readonly", reason: "question" },
    {
      prompt: "Why is login broken? Fix it.",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
    {
      prompt: "Add a retry button to the error banner",
      mode: "default",
      taskClass: "implement",
      reason: "default_class",
    },
  ] as const)("$prompt in $mode mode is $taskClass", ({ prompt, mode, taskClass, reason }) => {
    expect(classifyTask({ prompt, interactionMode: mode })).toEqual({
      taskClass,
      reasons: [reason],
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
      descriptors: [effortSelect(driver === "claudeAgent" ? "effort" : "reasoningEffort", levels)],
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
