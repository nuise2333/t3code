import { ProviderInstanceId, type RouteDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoEffortOffered,
  autoEffortSupported,
  describeRoutingReasons,
  launchRoutingRequest,
  routedEffortDisplay,
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
