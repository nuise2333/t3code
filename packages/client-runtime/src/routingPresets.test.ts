import { ProviderInstanceId, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  modelIdMatchRank,
  type PresetProviderSource,
  resolveRoutingGroupPreset,
  ROUTING_GROUP_PRESETS,
  type RoutingGroupPreset,
} from "./routingPresets.ts";

const effort = (levels: ReadonlyArray<string>): ProviderOptionDescriptor => ({
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: levels.map((id) => ({ id, label: id })),
});

const source = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<string | { slug: string; levels?: ReadonlyArray<string> }>,
): PresetProviderSource => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver,
  models: models.map((model) => {
    const entry = typeof model === "string" ? { slug: model } : model;
    return {
      slug: entry.slug,
      capabilities: entry.levels ? { optionDescriptors: [effort(entry.levels)] } : null,
    };
  }),
});

const preset = (id: string): RoutingGroupPreset => {
  const found = ROUTING_GROUP_PRESETS.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found;
};

describe("modelIdMatchRank", () => {
  it.each([
    ["auto/gpt-6-astra", "gpt-6-astra", 0],
    ["bailian-token-plan/qwen4-max", "qwen4-max", 0],
    ["group/qwen4-max(openai)", "qwen4-max", 1],
    ["gpt-6-astra", "gpt-6-astra", 2],
    ["qwen4-max(openai)", "qwen4-max", 2],
    ["group/gpt-6-astra-high", "gpt-6-astra", null],
    ["gpt-6-astra-mini", "gpt-6-astra", null],
  ])("%s names %s at %s", (id, slug, expected) => {
    expect(modelIdMatchRank(id, slug)).toBe(expected);
  });
});

describe("resolveRoutingGroupPreset", () => {
  it.each([
    {
      name: "exact slugs, in the preset's order",
      preset: "video-speed",
      providers: [
        source("claude", "claudeAgent", ["claude-opus-5-5"]),
        source("codex", "codex", ["gpt-6-astra"]),
      ],
      members: ["codex:gpt-6-astra", "claude:claude-opus-5-5"],
      skipped: [],
    },
    {
      name: "a magpie auto/ id, never its group/ variants",
      preset: "video-speed",
      providers: [
        source("magpie", "codex", [
          "group/gpt-6-astra-high",
          "group/gpt-6-astra",
          "auto/gpt-6-astra",
        ]),
      ],
      members: ["magpie:auto/gpt-6-astra"],
      skipped: ["Opus 5.5"],
    },
    {
      name: "the first instance in provider order, gateway before exact within one",
      preset: "batch-translation",
      providers: [
        source("work", "codex", ["gpt-6-luna", "auto/gpt-6-luna"]),
        source("personal", "codex", ["gpt-6-luna"]),
      ],
      members: ["work:auto/gpt-6-luna"],
      skipped: ["DeepSeek V4.1 Flash", "Haiku 5.5"],
    },
    {
      name: "a Qwen Code gateway group before the Token Plan key beside it",
      preset: "office-knowledge",
      providers: [source("qwen", "acpRegistry", ["qwen4-max(openai)", "group/qwen4-max(openai)"])],
      members: ["qwen:group/qwen4-max(openai)"],
      skipped: ["Opus 5.5", "GPT-6.1 Sol"],
    },
    {
      name: "a member restricted to its driver",
      preset: "research",
      providers: [
        source("magpie", "claudeAgent", ["auto/gpt-6.1-sol", "claude-opus-5-5"]),
        source("codex", "codex", ["gpt-6.1-sol"]),
      ],
      members: ["codex:gpt-6.1-sol", "magpie:claude-opus-5-5"],
      skipped: [],
    },
  ])("$name", ({ preset: id, providers, members, skipped }) => {
    const resolved = resolveRoutingGroupPreset(preset(id), providers);
    expect(resolved.disabledReason).toBeNull();
    expect(resolved.group?.members.map((member) => `${member.instanceId}:${member.model}`)).toEqual(
      members,
    );
    expect(resolved.skipped).toEqual(skipped);
  });

  it("is disabled with a reason when no member resolves", () => {
    const resolved = resolveRoutingGroupPreset(preset("video-quality"), [
      source("codex", "codex", ["gpt-6.1-sol"]),
    ]);
    expect(resolved.group).toBeNull();
    expect(resolved.disabledReason).toBe(
      "None of your ready providers offer Opus 5.5, GPT-6 Astra",
    );
  });

  it.each([
    {
      name: "offered level",
      preset: "chinese-writing",
      levels: ["low", "medium", "high"],
      value: "medium",
    },
    {
      name: "model default when the level is missing below",
      preset: "video-speed",
      levels: ["low", "medium"],
      value: undefined,
    },
    {
      name: "model default when the level is missing above",
      preset: "chinese-writing",
      levels: ["low", "high", "xhigh"],
      value: undefined,
    },
    { name: "no reasoning control", preset: "video-speed", levels: undefined, value: undefined },
  ])("effort: $name", ({ preset: id, levels, value }) => {
    const slug = preset(id).members[0]?.slugs[0] ?? "";
    const resolved = resolveRoutingGroupPreset(preset(id), [
      source("one", preset(id).members[0]?.driver ?? "codex", [levels ? { slug, levels } : slug]),
    ]);
    expect(resolved.group?.members[0]?.options).toEqual(
      value === undefined ? undefined : [{ id: "reasoningEffort", value }],
    );
  });

  it("leaves options empty for a member with no preset effort", () => {
    const resolved = resolveRoutingGroupPreset(preset("batch-translation"), [
      source("codex", "codex", [{ slug: "gpt-6-luna", levels: ["low", "medium", "high"] }]),
    ]);
    expect(resolved.group?.members).toEqual([{ instanceId: "codex", model: "gpt-6-luna" }]);
  });
});
