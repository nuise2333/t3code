import {
  type LaunchRoutingRequest,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RouteDecision,
  type RouteGroupDecision,
  type RouteModelDecision,
  ProviderDriverKind,
  RoutingSkipReason,
  type RoutingEffort,
  type RoutingTaskClass,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { isReasoningSelect } from "@t3tools/shared/model";
import {
  chooseAutoModel,
  classifyTask,
  isFrontendPrompt,
  isSecurityPrompt,
  modelVendor,
  resolveRoutingGroup,
  routeFor,
} from "@t3tools/shared/routing";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  normalizeClaudeCatalogEffort,
  resolveClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

const BELOW_HIGH: ReadonlySet<string> = new Set(["none", "off", "minimal", "low", "medium"]);

const vendorOf = (providers: ReadonlyArray<ServerProvider>, selection: ModelSelection) => {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) return null;
  const model = provider.models.find(
    (candidate) =>
      candidate.slug === selection.model || candidate.aliases?.includes(selection.model) === true,
  );
  return modelVendor(provider.driver, model?.slug ?? selection.model);
};

const SKIP_REASON_TEXT: Record<RoutingSkipReason, string> = {
  instance_missing: "provider instance not found",
  instance_disabled: "provider disabled",
  not_ready: "provider not ready",
  project_disabled: "provider off for this project",
  model_unavailable: "model not offered",
  usage_exhausted: "usage limit reached",
  runtime_mode: "runtime mode unsupported",
  plan_unsupported: "plan mode unsupported",
};

export class RoutingGroupUnavailableError extends Schema.TaggedError<RoutingGroupUnavailableError>()(
  "RoutingGroupUnavailableError",
  {
    groupId: Schema.String,
    /** Null when no group has this id. */
    groupName: Schema.NullOr(Schema.String),
    skipped: Schema.Array(
      Schema.Struct({
        index: Schema.Number,
        instanceId: ProviderInstanceId,
        model: Schema.String,
        reason: RoutingSkipReason,
      }),
    ),
  },
) {
  override get message(): string {
    if (this.groupName === null) return `Routing group "${this.groupId}" no longer exists.`;
    const members = this.skipped
      .map(
        (skip) =>
          `${skip.index + 1} ${skip.instanceId}/${skip.model}: ${SKIP_REASON_TEXT[skip.reason]}`,
      )
      .join("; ");
    return `Routing group "${this.groupName}" has no usable member: ${members}.`;
  }
}

export interface RoutingPolicyInput {
  readonly modelSelection: ModelSelection;
  readonly prompt: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly projectId: ProjectId | null;
  /** The first message attaches an image. */
  readonly hasImage: boolean;
  /** Only a client in its Auto effort state, or one that picked a group, asks. */
  readonly requested: LaunchRoutingRequest | undefined;
}

export interface RoutingGroupInput {
  readonly groupId: string;
  readonly via: RouteGroupDecision["via"];
  readonly prompt: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly projectId: ProjectId | null;
  /** Only these instances can run the launch; members outside it are not ready. */
  readonly runnableInstanceIds?: ReadonlySet<ProviderInstanceId>;
}

export interface RoutingDelegationInput {
  readonly role: "research" | "review";
  readonly parentSelection: ModelSelection;
  readonly prompt: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly projectId: ProjectId | null;
  readonly runnableInstanceIds: ReadonlySet<ProviderInstanceId>;
}

export interface RoutedSelection {
  readonly selection: ModelSelection;
  readonly decision: RouteDecision;
}

export class RoutingPolicy extends Context.Service<
  RoutingPolicy,
  {
    /** Null when no decision can be made. Effort routing never fails a launch; a group can. */
    readonly decide: (
      input: RoutingPolicyInput,
    ) => Effect.Effect<RoutedSelection | null, RoutingGroupUnavailableError>;
    readonly resolveGroup: (
      input: RoutingGroupInput,
    ) => Effect.Effect<RoutedSelection, RoutingGroupUnavailableError>;
    /** Null when Auto is off or routing fails; the task then keeps the parent's model. */
    readonly routeDelegation: (
      input: RoutingDelegationInput,
    ) => Effect.Effect<RoutedSelection | null>;
  }
>()("t3/routing/RoutingPolicy") {}

const make = Effect.gen(function* () {
  const manifest = yield* ModelManifest.ModelManifest;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const routeEffort = Effect.fn("RoutingPolicy.routeEffort")(
    function* (input: {
      readonly selection: ModelSelection;
      readonly prompt: string;
      readonly interactionMode: ProviderInteractionMode;
      readonly apply: boolean;
      /** A group member's own effort is the user's choice; an Auto draft's is only a default. */
      readonly keepExplicitEffort: boolean;
      readonly taskClass?: RoutingTaskClass | undefined;
      readonly minEffort?: RoutingEffort | undefined;
    }) {
      const providers = yield* providerRegistry.getProviders;
      const provider = providers.find(
        (candidate) => candidate.instanceId === input.selection.instanceId,
      );
      if (provider === undefined) return null;
      const model = provider.models.find(
        (candidate) =>
          candidate.slug === input.selection.model ||
          candidate.aliases?.includes(input.selection.model) === true,
      );
      const descriptors = model?.capabilities?.optionDescriptors;
      const reasoning = descriptors?.find(isReasoningSelect);
      // routeFor would overwrite it.
      if (
        input.keepExplicitEffort &&
        reasoning !== undefined &&
        input.selection.options?.some((option) => option.id === reasoning.id) === true
      ) {
        const classified = classifyTask(input);
        return {
          selection: input.selection,
          decision: {
            taskClass: classified.taskClass,
            effort: null,
            applied: false,
            reasons: [...classified.reasons, "user_choice"],
          },
        } satisfies RoutedSelection;
      }
      const data = yield* manifest.current;
      const modelSlug = model?.slug ?? input.selection.model;
      // Claude remaps effort labels before sending them; the high cap applies to what it sends.
      const claudeCatalog =
        provider.driver === CLAUDE
          ? resolveClaudeModelCatalog(
              ModelManifest.resolveProviderCatalog(data, CLAUDE) ?? undefined,
            )
          : undefined;
      return routeFor({
        table: ModelManifest.resolveRoutingTable(data),
        driver: provider.driver,
        ...(claudeCatalog === undefined
          ? {}
          : {
              emittedLevel: (id: string) =>
                normalizeClaudeCatalogEffort(claudeCatalog, id, modelSlug) ?? null,
            }),
        selection: input.selection,
        modelSlug: model?.slug,
        descriptors,
        prompt: input.prompt,
        interactionMode: input.interactionMode,
        apply: input.apply,
        taskClass: input.taskClass,
        minEffort: input.minEffort,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Effort routing failed; the launch keeps its selection.", cause).pipe(
        Effect.as(null),
      ),
    ),
  );

  const resolveGroup = Effect.fn("RoutingPolicy.resolveGroup")(function* (
    input: RoutingGroupInput,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const group = settings.routingGroups.find((candidate) => candidate.id === input.groupId);
    if (group === undefined) {
      return yield* new RoutingGroupUnavailableError({
        groupId: input.groupId,
        groupName: null,
        skipped: [],
      });
    }
    const resolution = resolveRoutingGroup({
      group,
      providers: yield* providerRegistry.getProviders,
      settings,
      projectId: input.projectId,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      runnableInstanceIds: input.runnableInstanceIds,
      now: DateTime.toEpochMillis(yield* DateTime.now),
    });
    if (!resolution.ok) {
      return yield* new RoutingGroupUnavailableError({
        groupId: group.id,
        groupName: group.name,
        skipped: resolution.skipped,
      });
    }
    const groupDecision: RouteGroupDecision = {
      id: group.id,
      name: group.name,
      via: input.via,
      ...(group.rank === "quota" ? { rank: "quota" as const } : {}),
      chosen: resolution.index,
      member: { instanceId: resolution.selection.instanceId, model: resolution.selection.model },
      skipped: resolution.skipped,
    };
    const routed = yield* routeEffort({
      selection: resolution.selection,
      prompt: input.prompt,
      interactionMode: input.interactionMode,
      // Only a rule comes from an Auto request; a picked group keeps its members' options.
      apply: input.via === "rule",
      keepExplicitEffort: true,
    });
    if (routed !== null) {
      return {
        selection: routed.selection,
        decision: { ...routed.decision, group: groupDecision },
      };
    }
    const classified = classifyTask(input);
    return {
      selection: resolution.selection,
      decision: {
        taskClass: classified.taskClass,
        effort: null,
        applied: false,
        reasons: [...classified.reasons],
        group: groupDecision,
      },
    } satisfies RoutedSelection;
  });

  const routeModel = Effect.fn("RoutingPolicy.routeModel")(
    function* (
      input: RoutingPolicyInput,
      switches: { readonly allowModelSwitch: boolean; readonly allowProviderSwitch: boolean },
      settings: Parameters<typeof chooseAutoModel>[0]["settings"],
      delegation?: Pick<RoutingDelegationInput, "role" | "runnableInstanceIds">,
    ) {
      const providers = yield* providerRegistry.getProviders;
      const review =
        delegation?.role === "review"
          ? { parentVendor: vendorOf(providers, input.modelSelection) }
          : undefined;
      // A review always changes vendor, so only the cross-provider switch lets it move.
      const { allowModelSwitch, allowProviderSwitch } =
        review === undefined
          ? switches
          : {
              allowModelSwitch: switches.allowProviderSwitch,
              allowProviderSwitch: switches.allowProviderSwitch,
            };
      const classified =
        delegation === undefined
          ? classifyTask(input)
          : { taskClass: "readonly" as const, reasons: [] as ReadonlyArray<never> };
      // A shadow uses the widest scope, to show the most Auto could have done.
      const choice = chooseAutoModel({
        table: ModelManifest.resolveRoutingTable(yield* manifest.current),
        taskClass: classified.taskClass,
        current: input.modelSelection,
        scope:
          allowModelSwitch === allowProviderSwitch
            ? "any"
            : allowModelSwitch
              ? "instance"
              : "provider",
        providers,
        settings,
        projectId: input.projectId,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        imageFrontend: input.hasImage && isFrontendPrompt(input.prompt),
        securityPrompt: isSecurityPrompt(input.prompt),
        runnableInstanceIds: delegation?.runnableInstanceIds,
        review,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      });
      yield* Effect.annotateCurrentSpan({
        switched: choice.switched,
        skippedByReason: choice.skippedByReason,
      });
      const applied =
        choice.switched === "none"
          ? allowModelSwitch || allowProviderSwitch
          : choice.switched === "model"
            ? allowModelSwitch
            : allowProviderSwitch;
      const switching = applied && choice.switched !== "none";
      const modelDecision: RouteModelDecision = {
        instanceId: choice.selection.instanceId,
        model: choice.selection.model,
        tier: choice.tier,
        switched: choice.switched,
        applied,
        skipped: choice.skipped,
        ...(choice.skippedByReason.image_frontend === undefined
          ? {}
          : { reason: "image_frontend" as const }),
        ...(switching
          ? {
              from: {
                instanceId: input.modelSelection.instanceId,
                model: input.modelSelection.model,
              },
            }
          : {}),
      };
      const selection = switching ? choice.selection : input.modelSelection;
      const routed = yield* routeEffort({
        selection,
        prompt: input.prompt,
        interactionMode: input.interactionMode,
        apply: true,
        keepExplicitEffort: false,
        ...(delegation === undefined
          ? {}
          : {
              taskClass: classified.taskClass,
              minEffort: review === undefined ? undefined : "high",
            }),
      });
      const role = delegation === undefined ? {} : { role: delegation.role };
      const kept = choice.reason === undefined ? [] : [choice.reason];
      // A review on the parent's own model only lifts an effort below high, never lowers one.
      const keepsEffort =
        review !== undefined &&
        !switching &&
        routed?.decision.baseline !== undefined &&
        !BELOW_HIGH.has(routed.decision.baseline);
      if (routed !== null) {
        return {
          selection: keepsEffort ? selection : routed.selection,
          decision: {
            ...routed.decision,
            ...(keepsEffort ? { applied: false } : {}),
            reasons: [...routed.decision.reasons, ...kept],
            ...role,
            model: modelDecision,
          },
        };
      }
      return {
        selection,
        decision: {
          taskClass: classified.taskClass,
          ...role,
          effort: null,
          applied: false,
          reasons: [...classified.reasons, ...kept],
          model: modelDecision,
        },
      } satisfies RoutedSelection;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Model routing failed; Auto keeps the launch's model.", cause).pipe(
        Effect.as(null),
      ),
    ),
  );

  const decide = Effect.fn("RoutingPolicy.decide")(function* (input: RoutingPolicyInput) {
    if (input.requested?.mode === "group") {
      return yield* resolveGroup({ ...input, groupId: input.requested.groupId, via: "picker" });
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Effort routing failed; the launch keeps its selection.", cause).pipe(
          Effect.as(null),
        ),
      ),
    );
    if (settings === null) return null;
    const auto = input.requested?.mode === "auto" && settings.autoRouting.enabled;
    if (auto) {
      const groupId = settings.routingGroupRules[classifyTask(input).taskClass];
      if (groupId !== undefined) return yield* resolveGroup({ ...input, groupId, via: "rule" });
      // Only a draft whose model the user did not pick asks Auto to choose one.
      if (input.requested?.mode === "auto" && input.requested.model === "auto") {
        const routed = yield* routeModel(input, settings.autoRouting, settings);
        if (routed !== null) return routed;
      }
    }
    return yield* routeEffort({
      selection: input.modelSelection,
      prompt: input.prompt,
      interactionMode: input.interactionMode,
      apply: auto,
      keepExplicitEffort: false,
    });
  });

  const routeDelegation = Effect.fn("RoutingPolicy.routeDelegation")(
    function* (input: RoutingDelegationInput) {
      const settings = yield* serverSettings.getSettings;
      if (!settings.autoRouting.enabled) return null;
      return yield* routeModel(
        {
          modelSelection: input.parentSelection,
          prompt: input.prompt,
          interactionMode: input.interactionMode,
          runtimeMode: input.runtimeMode,
          projectId: input.projectId,
          hasImage: false,
          requested: undefined,
        },
        settings.autoRouting,
        settings,
        input,
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "Delegation routing failed; the task keeps the parent's model.",
        cause,
      ).pipe(Effect.as(null)),
    ),
  );

  return RoutingPolicy.of({ decide, resolveGroup, routeDelegation });
});

export const layer = Layer.effect(RoutingPolicy, make);
