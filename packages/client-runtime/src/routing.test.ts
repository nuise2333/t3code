import { ProviderInstanceId, type RouteDecision, type RoutingGroup } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoEffortOffered,
  autoEffortSupported,
  describeRoutingReasons,
  launchRoutingRequest,
  moveListItem,
  newRoutingGroupId,
  pickerRoutingGroups,
  routedEffortDisplay,
  routedGroupDisplay,
  routingGroupProblems,
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
        launchRoutingRequest({ offered, effortManual: manual, multiModel: multi }),
      ).toStrictEqual(auto ? { mode: "auto" } : undefined);
    },
  );

  it("asks for a picked group, even with Auto off, but not for a multi-model send", () => {
    const base = { offered: false, effortManual: true, routingGroupId: "fast" };
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
