import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2RunStatus,
  type ProviderOptionDescriptor,
  type RouteDecision,
  type RoutingGroup,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  autoEffortOffered,
  autoEffortSupported,
  autoRoutingNote,
  describeRoutingReasons,
  higherEffortRetry,
  launchRoutingRequest,
  moveListItem,
  newRoutingGroupId,
  pickerRoutingGroups,
  routedEffortDisplay,
  routedGroupDisplay,
  routedModelDisplay,
  routingGroupProblems,
  routingProviderSource,
} from "./routing.ts";

const instanceId = ProviderInstanceId.make("codex");
const routed: RouteDecision = {
  taskClass: "hard",
  effort: "high",
  optionId: "reasoningEffort",
  baseline: "xhigh",
  applied: true,
  reasons: ["plan_mode", "nearest_level", "no_row"],
};
const selection = (effort: string) => ({
  instanceId,
  model: "gpt-6",
  options: [
    { id: "fastMode", value: true },
    { id: "reasoningEffort", value: effort },
  ],
});

describe("launchRoutingRequest", () => {
  it.each([
    { capability: true, setting: true, manual: false, multi: false, auto: true },
    { capability: true, setting: true, manual: true, multi: false, auto: false },
    { capability: true, setting: true, manual: false, multi: true, auto: false },
    { capability: undefined, setting: true, manual: false, multi: false, auto: false },
    { capability: true, setting: false, manual: false, multi: false, auto: false },
  ])(
    "capability $capability, setting $setting, manual $manual, multi $multi",
    ({ capability, setting, manual, multi, auto }) => {
      const offered = autoEffortOffered({ capability, settingEnabled: setting });
      expect(
        launchRoutingRequest({
          offered,
          effortManual: manual,
          multiModel: multi,
          modelExplicit: true,
        }),
      ).toStrictEqual(auto ? { mode: "auto" } : undefined);
    },
  );

  it("lets Auto choose the model only when the draft's user did not pick one", () => {
    const base = { offered: true, effortManual: false, multiModel: false };
    expect(launchRoutingRequest({ ...base, modelExplicit: false })).toStrictEqual({
      mode: "auto",
      model: "auto",
    });
    expect(launchRoutingRequest({ ...base, modelExplicit: true })).toStrictEqual({ mode: "auto" });
  });

  it("asks for a picked group, even with Auto off, but not for a multi-model send", () => {
    const base = {
      offered: false,
      effortManual: true,
      modelExplicit: false,
      routingGroupId: "fast",
    };
    expect(launchRoutingRequest({ ...base, multiModel: false })).toStrictEqual({
      mode: "group",
      groupId: "fast",
    });
    expect(launchRoutingRequest({ ...base, multiModel: true })).toBeUndefined();
  });
});

describe("routing groups", () => {
  const claude = ProviderInstanceId.make("claude");
  const providers = [
    { instanceId, models: [{ slug: "gpt-6", name: "GPT-6", shortName: "GPT 6" }] },
    { instanceId: claude, models: [{ slug: "opus", name: "Claude Opus" }] },
  ];
  const group: RoutingGroup = {
    id: "fast",
    name: "Fast",
    strategy: "order",
    members: [
      { instanceId: claude, model: "opus" },
      { instanceId, model: "gpt-6" },
    ],
  };
  const routing: RouteDecision = {
    ...routed,
    group: {
      id: "fast",
      name: "Fast",
      via: "picker",
      chosen: 1,
      member: { instanceId, model: "gpt-6" },
      skipped: [{ index: 0, instanceId: claude, model: "opus", reason: "usage_exhausted" }],
    },
  };

  it("names the group, the chosen model and the skipped members as launched", () => {
    expect(routedGroupDisplay({ routing, selection: group.members[1], providers })).toStrictEqual({
      groupName: "Fast",
      label: "Fast → GPT 6",
      skipped: "Skipped: Claude Opus (usage limit)",
    });
  });

  it("drops the label after a manual pick", () => {
    expect(routedGroupDisplay({ routing, selection: group.members[0], providers })).toBeNull();
    expect(
      routedGroupDisplay({ routing: routed, selection: group.members[1], providers }),
    ).toBeNull();
  });

  it("offers groups only to a new single-model thread on a server that resolves them", () => {
    const offered = (input: { newThread: boolean; multiModel?: boolean; capability?: boolean }) =>
      pickerRoutingGroups({
        newThread: input.newThread,
        multiModel: input.multiModel ?? false,
        capability: input.capability ?? true,
        groups: [group],
        providers,
      });
    expect(offered({ newThread: true })).toStrictEqual([
      { id: "fast", name: "Fast", summary: "Claude Opus, GPT 6", placeholder: group.members[0] },
    ]);
    expect(offered({ newThread: false })).toStrictEqual([]);
    expect(offered({ newThread: true, multiModel: true })).toStrictEqual([]);
    expect(offered({ newThread: true, capability: false })).toStrictEqual([]);
  });

  it("holds the first member that looks runnable, so a stopped first member does not block sending", () => {
    const placeholder = (runnable: (instance: string, model: string) => boolean) =>
      pickerRoutingGroups({
        newThread: true,
        multiModel: false,
        capability: true,
        groups: [group],
        providers: providers.map((provider) => ({
          ...provider,
          runnable: (model: string) => runnable(provider.instanceId, model),
        })),
      })[0]?.placeholder;
    expect(placeholder((instance) => instance !== claude)).toStrictEqual(group.members[1]);
    expect(placeholder(() => true)).toStrictEqual(group.members[0]);
    // With nothing runnable the server reports every member's reason, so the draft keeps the first.
    expect(placeholder(() => false)).toStrictEqual(group.members[0]);
  });

  it("finds rules naming a deleted group and members on a removed provider", () => {
    const problems = routingGroupProblems({
      groups: [group],
      rules: { hard: "fast", readonly: "gone" },
      providers: [{ instanceId }],
    });
    expect(problems.missingRuleGroups).toStrictEqual(["readonly"]);
    expect([...problems.missingMembers]).toStrictEqual([["fast", [0]]]);
  });

  it("makes a unique id from a name", () => {
    expect(newRoutingGroupId("Cheap & Fast!", [])).toBe("cheap-fast");
    expect(newRoutingGroupId("Cheap fast", ["cheap-fast", "cheap-fast-2"])).toBe("cheap-fast-3");
    expect(newRoutingGroupId("快速", [])).toBe("group");
  });

  it("moves a member within bounds only", () => {
    expect(moveListItem(["a", "b", "c"], 2, -1)).toStrictEqual(["a", "c", "b"]);
    expect(moveListItem(["a", "b"], 0, -1)).toStrictEqual(["a", "b"]);
  });
});

describe("routedEffortDisplay", () => {
  it("names the routed level and its reasons while the thread still uses it", () => {
    expect(
      routedEffortDisplay({
        routing: routed,
        selection: selection("high"),
        descriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "high", label: "High effort" }],
          },
        ],
      }),
    ).toStrictEqual({
      levelLabel: "High effort",
      reason: "Plan mode, Closest level this model offers",
      summary: "Auto picked High effort: Plan mode, Closest level this model offers",
    });
  });

  it.each([
    { name: "a manual pick replaced the level", routing: routed, effort: "medium" },
    {
      name: "the decision was shadow only",
      routing: { ...routed, applied: false },
      effort: "high",
    },
    {
      name: "routing left the selection alone",
      routing: { ...routed, effort: null },
      effort: "high",
    },
    { name: "the thread has no decision", routing: null, effort: "high" },
  ])("is null when $name", ({ routing, effort }) => {
    expect(routedEffortDisplay({ routing, selection: selection(effort) })).toBeNull();
  });
});

describe("routedModelDisplay", () => {
  const claude = ProviderInstanceId.make("claude");
  const providers = [
    {
      instanceId: claude,
      subscription: "Claude · Max",
      models: [
        { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", shortName: "Haiku 5.5" },
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", shortName: "Opus 5.5" },
      ],
    },
    {
      instanceId,
      subscription: "Codex · ChatGPT Plus",
      models: [{ slug: "gpt-6-luna", name: "GPT-6 Luna" }],
    },
  ];
  const decision = (model: Partial<NonNullable<RouteDecision["model"]>>): RouteDecision => ({
    ...routed,
    effort: "low",
    reasons: ["question", "model_row"],
    model: {
      instanceId: claude,
      model: "claude-haiku-5-5",
      tier: "C",
      switched: "model",
      applied: true,
      skipped: 0,
      from: { instanceId: claude, model: "claude-opus-5-5" },
      ...model,
    },
  });
  const haiku = { instanceId: claude, model: "claude-haiku-5-5" };

  it.each([
    {
      name: "a model switch while the thread keeps it",
      routing: decision({}),
      summary: "Auto → Haiku 5.5 on Claude · Max (Question, no edits), instead of Opus 5.5",
    },
    {
      name: "a provider switch",
      routing: decision({ instanceId, model: "gpt-6-luna", switched: "provider" }),
      selection: { instanceId, model: "gpt-6-luna" },
      summary:
        "Auto → GPT-6 Luna on Codex · ChatGPT Plus (Question, no edits), instead of Opus 5.5",
    },
    {
      name: "a shadow model choice",
      routing: decision({ applied: false }),
      selection: { instanceId: claude, model: "claude-opus-5-5" },
      summary:
        "With model switching on, Auto would have used Haiku 5.5 on Claude · Max (Question, no edits)",
    },
    {
      name: "a shadow provider choice",
      routing: decision({ instanceId, model: "gpt-6-luna", switched: "provider", applied: false }),
      selection: { instanceId: claude, model: "claude-opus-5-5" },
      summary:
        "With provider switching on, Auto would have used GPT-6 Luna on Codex · ChatGPT Plus (Question, no edits)",
    },
    {
      name: "a manual pick after the switch",
      routing: decision({}),
      selection: { instanceId: claude, model: "claude-opus-5-5" },
      summary: null,
    },
    { name: "Auto kept the model", routing: decision({ switched: "none" }), summary: null },
    { name: "no model decision", routing: routed, summary: null },
  ])("describes $name", ({ routing, selection = haiku, summary }) => {
    expect(routedModelDisplay({ routing, selection, providers })).toBe(summary);
  });

  it.each([
    {
      displayName: "Codex",
      label: "ChatGPT Plus Subscription",
      subscription: "Codex · ChatGPT Plus",
    },
    { displayName: "Codex", label: "dev@example.com", subscription: "Codex" },
    { displayName: undefined, label: "OpenAI API Key", subscription: "OpenAI API Key" },
    { displayName: undefined, label: undefined, subscription: undefined },
  ])(
    "names the instance that pays: $displayName, $label",
    ({ displayName, label, subscription }) => {
      const snapshot = {
        instanceId,
        driver: "codex",
        ...(displayName === undefined ? {} : { displayName }),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated", email: "dev@example.com", ...(label ? { label } : {}) },
        models: [],
      } as unknown as ServerProvider;
      expect(routingProviderSource(snapshot, 0).subscription).toBe(subscription);
    },
  );
});

it.each([
  {
    model: false,
    provider: false,
    explicit: false,
    note: "Picks a level up to High from your first message.",
  },
  {
    model: true,
    provider: false,
    explicit: false,
    note: "Picks a level up to High, and may switch to a cheaper or stronger model on this provider, from your first message.",
  },
  {
    model: false,
    provider: true,
    explicit: false,
    note: "Picks a level up to High, and may switch to a model on another of your providers, from your first message.",
  },
  {
    model: true,
    provider: true,
    explicit: false,
    note: "Picks a level up to High, and may switch model or provider, from your first message.",
  },
  {
    model: true,
    provider: true,
    explicit: true,
    note: "Picks a level up to High from your first message. Keeps the model you picked.",
  },
])(
  "Auto's note with model $model, provider $provider, picked $explicit",
  ({ model, provider, explicit, note }) => {
    expect(
      autoRoutingNote({
        capability: true,
        settings: { allowModelSwitch: model, allowProviderSwitch: provider },
        modelExplicit: explicit,
      }),
    ).toBe(note);
  },
);

it("ignores the switches on a server that cannot honor them", () => {
  expect(
    autoRoutingNote({
      capability: undefined,
      settings: { allowModelSwitch: true, allowProviderSwitch: true },
      modelExplicit: false,
    }),
  ).toBe("Picks a level up to High from your first message.");
});

it("skips reason codes it has no words for", () => {
  expect(describeRoutingReasons(["no_effort_control", "question"])).toBe("Question, no edits");
});

it.each([
  { driver: "codex", ids: ["minimal", "low", "xhigh"], supported: true },
  { driver: "codex", ids: ["xhigh", "max"], supported: false },
  { driver: "acpRegistry", ids: ["low", "high"], supported: false },
  { driver: "claudeAgent", ids: ["low", "high"], ultrathink: true, supported: false },
  { driver: "claudeAgent", ids: ["low", "high"], ultracode: true, supported: false },
] as const)(
  "Auto supports $driver with $ids: $supported",
  ({ driver, ids, supported, ...rest }) => {
    const descriptors = [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [...ids, "ultrathink"].map((id) => ({ id, label: id })),
        promptInjectedValues: ["ultrathink"],
      },
      { id: "ultracode", label: "Ultracode", type: "boolean" as const },
    ];
    const selection = {
      instanceId: ProviderInstanceId.make("primary"),
      model: "model",
      options: "ultracode" in rest ? [{ id: "ultracode", value: true }] : [],
    };
    expect(
      autoEffortSupported({
        driver,
        descriptors,
        selection,
        ultrathinkPrompt: "ultrathink" in rest,
      }),
    ).toBe(supported);
  },
);

describe("higherEffortRetry", () => {
  const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: ["low", "medium", "high", "xhigh", "ultrathink"].map((id) => ({
        id,
        label: id.toUpperCase(),
      })),
      promptInjectedValues: ["ultrathink"],
    },
  ];
  const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, minute));
  const run = (
    n: number,
    status: OrchestrationV2RunStatus = "completed",
    extra: { readonly model?: string; readonly instance?: string; readonly unstarted?: true } = {},
  ) => ({
    id: RunId.make(`run-${n}`),
    ordinal: n,
    status,
    startedAt: extra.unstarted ? null : at(n),
    completedAt: at(n),
    rootNodeId: NodeId.make(`root-${n}`),
    userMessageId: MessageId.make(`msg-${n}`),
    modelSelection: {
      ...selection("medium"),
      model: extra.model ?? "gpt-6",
      ...(extra.instance === undefined
        ? {}
        : { instanceId: ProviderInstanceId.make(extra.instance) }),
    },
  });
  const command = (
    n: number,
    input: string,
    exitCode: number | undefined,
    extra: { readonly ordinal?: number; readonly node?: string; readonly flagged?: true } = {},
  ) => ({
    type: "command_execution" as const,
    runId: RunId.make(`run-${n}`),
    nodeId: NodeId.make(extra.node ?? `root-${n}`),
    ordinal: extra.ordinal ?? 0,
    input,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(extra.flagged ? { outputIndicatesFailure: true } : {}),
  });
  const node = (id: string, parent: string, kind: "tool_call" | "subagent") => ({
    id: NodeId.make(id),
    parentNodeId: NodeId.make(parent),
    kind,
  });
  const offered = { key: "run-2", messageId: "msg-1", effort: "high" };

  it.each([
    {
      name: "the same command failed in both runs",
      runs: [run(1), run(2)],
      turnItems: [command(1, "vp test", 1), command(2, " vp test ", 2)],
      expected: offered,
    },
    {
      name: "Claude commands in tool call nodes under the root",
      runs: [run(1), run(2)],
      nodes: [node("tool-1", "root-1", "tool_call"), node("tool-2", "root-2", "tool_call")],
      turnItems: [
        command(1, "vp test", 1, { node: "tool-1" }),
        command(2, "vp test", 1, { node: "tool-2" }),
      ],
      expected: offered,
    },
    {
      name: "different commands failed",
      runs: [run(1), run(2)],
      turnItems: [command(1, "vp test", 1), command(2, "vp lint", 1)],
      expected: null,
    },
    {
      name: "a later pass in the same run",
      runs: [run(1), run(2)],
      turnItems: [
        command(1, "vp test", 1),
        command(2, "vp test", 1, { ordinal: 1 }),
        command(2, "vp test", 0, { ordinal: 2 }),
      ],
      expected: null,
    },
    {
      name: "a missing exit code",
      runs: [run(1), run(2)],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", undefined)],
      expected: null,
    },
    {
      name: "failed output from a provider with no exit codes",
      runs: [run(1), run(2)],
      turnItems: [
        command(1, "vp test", undefined, { flagged: true }),
        command(2, "vp test", undefined, { flagged: true }),
      ],
      expected: offered,
    },
    {
      name: "an exit code of 0 outranks failed-looking output",
      runs: [run(1), run(2)],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 0, { flagged: true })],
      expected: null,
    },
    {
      name: "a single run",
      runs: [run(2)],
      turnItems: [command(2, "vp test", 1)],
      expected: null,
    },
    {
      name: "the latest run failed",
      runs: [run(1), run(2, "failed")],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: null,
    },
    {
      name: "the earlier run failed",
      runs: [run(1, "failed"), run(2)],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: null,
    },
    {
      name: "only the last two runs count",
      runs: [run(1), run(2), run(3)],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 0), command(3, "vp test", 1)],
      expected: null,
    },
    {
      name: "runs listed out of order",
      runs: [run(2), run(1)],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: offered,
    },
    {
      name: "different models",
      runs: [run(1, "completed", { model: "gpt-6-mini" }), run(2)],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: null,
    },
    {
      name: "the same model on another instance",
      runs: [run(1, "completed", { instance: "codex_work" }), run(2)],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: null,
    },
    {
      name: "only subagent failures",
      runs: [run(1), run(2)],
      nodes: [
        node("sub-1", "root-1", "subagent"),
        node("sub-2", "root-2", "subagent"),
        node("sub-tool-2", "sub-2", "tool_call"),
      ],
      turnItems: [
        command(1, "vp test", 1, { node: "sub-1" }),
        command(2, "vp test", 1, { node: "sub-tool-2" }),
      ],
      expected: null,
    },
    {
      name: "an intervening rolled back run",
      runs: [run(1), run(2, "rolled_back"), run(3)],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 0), command(3, "vp test", 1)],
      expected: { ...offered, key: "run-3" },
    },
    {
      name: "an intervening run that never started",
      runs: [run(1), run(2, "failed", { unstarted: true }), run(3)],
      turnItems: [command(1, "vp test", 1), command(3, "vp test", 1)],
      expected: { ...offered, key: "run-3" },
    },
    {
      name: "a requeued run after the failures",
      runs: [run(1), run(2), run(3, "queued")],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: offered,
    },
    {
      name: "an Ultrathink prompt",
      runs: [run(1), run(2)],
      messages: [{ id: MessageId.make("msg-1"), text: "ultrathink about this" }],
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: null,
    },
    {
      name: "the level after one the composer already raised",
      runs: [run(1), run(2)],
      composer: selection("high"),
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: { ...offered, effort: "xhigh" },
    },
    {
      name: "a composer on another model",
      runs: [run(1), run(2)],
      composer: { ...selection("medium"), model: "gpt-6-mini" },
      turnItems: [command(1, "vp test", 1), command(2, "vp test", 1)],
      expected: null,
    },
  ])("$name", ({ runs, turnItems, expected, ...row }) => {
    const result = higherEffortRetry({
      runs,
      turnItems,
      nodes: "nodes" in row ? row.nodes : [],
      messages: "messages" in row ? row.messages : [],
      descriptors,
      selection: "composer" in row ? row.composer : selection("medium"),
    });
    expect(
      result && { key: result.key, messageId: result.messageId, effort: result.effort.value },
    ).toStrictEqual(expected);
  });
});
