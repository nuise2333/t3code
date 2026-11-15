import {
  type LaunchRoutingRequest,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RouteDecision,
  type RouteGroupDecision,
  RoutingSkipReason,
  type RuntimeMode,
} from "@t3tools/contracts";
import { isReasoningSelect } from "@t3tools/shared/model";
import { classifyTask, resolveRoutingGroup, routeFor } from "@t3tools/shared/routing";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

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
      return routeFor({
        table: ModelManifest.resolveRoutingTable(yield* manifest.current),
        driver: provider.driver,
        selection: input.selection,
        modelSlug: model?.slug,
        descriptors,
        prompt: input.prompt,
        interactionMode: input.interactionMode,
        apply: input.apply,
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
    const auto = input.requested?.mode === "auto" && settings.autoRoutingEnabled;
    if (auto) {
      const groupId = settings.routingGroupRules[classifyTask(input).taskClass];
      if (groupId !== undefined) return yield* resolveGroup({ ...input, groupId, via: "rule" });
    }
    return yield* routeEffort({
      selection: input.modelSelection,
      prompt: input.prompt,
      interactionMode: input.interactionMode,
      apply: auto,
      keepExplicitEffort: false,
    });
  });

  return RoutingPolicy.of({ decide, resolveGroup });
});

export const layer = Layer.effect(RoutingPolicy, make);
