import type {
  ModelSelection,
  ProviderInstanceId,
  RoutingGroup,
  ServerProviderModel,
} from "@t3tools/contracts";
import { isReasoningSelect } from "@t3tools/shared/model";

type PresetEffort = "low" | "medium" | "high";

interface PresetMember {
  readonly label: string;
  /** Canonical slug first; the rest are spellings other providers use for the same model. */
  readonly slugs: ReadonlyArray<string>;
  /** Only instances of this driver, where the model's own harness matters (such as search). */
  readonly driver?: string;
  readonly effort?: PresetEffort;
}

export interface RoutingGroupPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly members: ReadonlyArray<PresetMember>;
}

const OPUS = ["claude-opus-5-5", "claude-opus-5.5"];
const HAIKU = ["claude-haiku-5-5", "claude-haiku-5.5"];

export const ROUTING_GROUP_PRESETS: ReadonlyArray<RoutingGroupPreset> = [
  // Bilibili creator reviews and Every's writing tests, 2026-09 to 2026-11; Chinese effort per Bilibili, 2026-11-16.
  {
    id: "chinese-writing",
    name: "Chinese writing",
    description:
      "Chinese prose, copy and rewrites. Opus 5.5 first; Gemini 4 Argon tends to overstate, so have another model check its drafts; GPT-6 Astra suits tidy writing from supplied material. Medium effort, since reviewers found high overthinks Chinese drafts. Not for official documents (公文): where their data may go comes first, so use a group you pick yourself.",
    members: [
      { label: "Opus 5.5", slugs: OPUS, effort: "medium" },
      { label: "Gemini 4 Argon", slugs: ["gemini-4-argon"], effort: "medium" },
      { label: "GPT-6 Astra", slugs: ["gpt-6-astra"], effort: "medium" },
    ],
  },
  // Reviewer majority view on bulk translation, no single named test behind it, 2026-11-15.
  {
    id: "batch-translation",
    name: "Batch translation",
    description:
      "Bulk translation on cheap models at their default effort. Use a stronger model for alignment and the final proofread.",
    members: [
      { label: "DeepSeek V4.1 Flash", slugs: ["deepseek-v4.1-flash"] },
      { label: "GPT-6 Luna", slugs: ["gpt-6-luna"] },
      { label: "Haiku 5.5", slugs: HAIKU },
    ],
  },
  // Creator reviews of code-made video (Remotion, HyperFrames, Manim), 2026-09 to 2026-11-15.
  {
    id: "video-quality",
    name: "Video and motion (quality)",
    description:
      "Code-made launch films, explainers and motion where quality comes first. GPT-6.1 Sol is left out after three independent reviews panned its motion work. The agent checks rendered stills, so every model needs image input; T3 does not know which models accept images, so check yours do.",
    members: [
      { label: "Opus 5.5", slugs: OPUS, effort: "high" },
      { label: "GPT-6 Astra", slugs: ["gpt-6-astra"], effort: "high" },
    ],
  },
  // Creator reviews of code-made video: Astra on Codex about twice as fast, 2026-11-15.
  {
    id: "video-speed",
    name: "Video and motion (speed)",
    description:
      "Short trailers that need to ship fast. The agent checks rendered stills, so every model needs image input; T3 does not know which models accept images, so check yours do.",
    members: [
      { label: "GPT-6 Astra", slugs: ["gpt-6-astra"], effort: "high" },
      { label: "Opus 5.5", slugs: OPUS, effort: "high" },
    ],
  },
  // Parallel and Firecrawl search leaderboards and the OpenDS-World paper, 2026-11-10 to 2026-11-14.
  {
    id: "research",
    name: "Research",
    description:
      "Web research. GPT-6.1 Sol on Codex goes first: it scores close to Opus 5.5 on search benchmarks at a fraction of the cost. Opus 5.5 on Claude follows; move it up when the judgement matters more than the cost. Search tools and enough search rounds matter more than the model, so check the thread can search the live web. Chinese topics do not need a domestic model; what matters is which platform holds the content.",
    members: [
      { label: "GPT-6.1 Sol on Codex", slugs: ["gpt-6.1-sol"], driver: "codex" },
      { label: "Opus 5.5 on Claude", slugs: OPUS, driver: "claudeAgent" },
    ],
  },
  // Artificial Analysis, Vals and Design Arena results for Qwen4-Max at launch, 2026-11-16.
  {
    id: "office-knowledge",
    name: "Office and knowledge work",
    description:
      "Documents, spreadsheets, cross-system office tasks and finance analysis. Qwen4-Max first where you have it, at high effort; its independent scores were measured at xhigh, which you can set by editing the group. Opus 5.5 and GPT-6.1 Sol follow at medium, since Qwen4-Max has a single upstream. Avoid a Token Plan personal key for scheduled or automated runs.",
    members: [
      { label: "Qwen4-Max", slugs: ["qwen4-max"], effort: "high" },
      { label: "Opus 5.5", slugs: OPUS, effort: "medium" },
      { label: "GPT-6.1 Sol", slugs: ["gpt-6.1-sol"], effort: "medium" },
    ],
  },
];

/**
 * How well a provider's model id serves this slug, lower is better, null when it doesn't name it.
 * Qwen Code reports ids as `<id>(<auth type>)`. A gateway route (`auto/<slug>`, then a
 * `group/<slug>` that may mix models) beats the bare id beside it, which can be a personal key
 * whose terms forbid automated use, such as a Qwen Token Plan.
 */
export function modelIdMatchRank(id: string, slug: string): number | null {
  const bare = id.replace(/\([^()]*\)$/, "");
  if (bare === slug) return 2;
  if (!bare.includes("/") || bare.slice(bare.lastIndexOf("/") + 1) !== slug) return null;
  return bare.startsWith("group/") ? 1 : 0;
}

export interface PresetProviderSource {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly models: ReadonlyArray<
    Pick<ServerProviderModel, "slug" | "capabilities"> & {
      readonly aliases?: ReadonlyArray<string> | undefined;
    }
  >;
}

type SourceModel = PresetProviderSource["models"][number];

/** The target if offered, else the nearest lower level, else the nearest higher one up to high. */
function effortOptions(model: SourceModel, target: PresetEffort | undefined) {
  if (target === undefined) return undefined;
  const descriptor = model.capabilities?.optionDescriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return undefined;
  const offered = new Set(
    descriptor.options
      .map((option) => option.id)
      .filter((id) => !descriptor.promptInjectedValues?.includes(id)),
  );
  // A missing level falls back to the model's default: writing must not land on high or low.
  return offered.has(target) ? [{ id: descriptor.id, value: target }] : undefined;
}

function findMember(
  member: PresetMember,
  providers: ReadonlyArray<PresetProviderSource>,
): ModelSelection | null {
  for (const provider of providers) {
    if (member.driver !== undefined && provider.driver !== member.driver) continue;
    const rank = (model: SourceModel) => {
      const ranks = [model.slug, ...(model.aliases ?? [])].flatMap((id) =>
        member.slugs.flatMap((slug) => modelIdMatchRank(id, slug) ?? []),
      );
      return ranks.length === 0 ? null : Math.min(...ranks);
    };
    const model = provider.models
      .flatMap((candidate) => {
        const order = rank(candidate);
        return order === null ? [] : [{ candidate, order }];
      })
      .sort((left, right) => left.order - right.order)[0]?.candidate;
    if (model === undefined) continue;
    const options = effortOptions(model, member.effort);
    return options === undefined
      ? { instanceId: provider.instanceId, model: model.slug }
      : { instanceId: provider.instanceId, model: model.slug, options };
  }
  return null;
}

export interface ResolvedRoutingGroupPreset {
  readonly preset: RoutingGroupPreset;
  /** A new, unsaved group; the id is assigned when it is saved. */
  readonly group: RoutingGroup | null;
  /** Labels of members none of the providers offer. */
  readonly skipped: ReadonlyArray<string>;
  readonly disabledReason: string | null;
}

/** Each member on the first provider, in the given order, that offers its model. */
export function resolveRoutingGroupPreset(
  preset: RoutingGroupPreset,
  providers: ReadonlyArray<PresetProviderSource>,
): ResolvedRoutingGroupPreset {
  const members: ModelSelection[] = [];
  const skipped: string[] = [];
  for (const member of preset.members) {
    const selection = findMember(member, providers);
    if (selection === null) skipped.push(member.label);
    else members.push(selection);
  }
  if (members.length === 0) {
    return {
      preset,
      group: null,
      skipped,
      disabledReason: `None of your ready providers offer ${preset.members.map((member) => member.label).join(", ")}`,
    };
  }
  return {
    preset,
    group: { id: "", name: preset.name, strategy: "order", members },
    skipped,
    disabledReason: null,
  };
}
