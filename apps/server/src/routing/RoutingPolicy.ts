import type { ModelSelection, ProviderInteractionMode, RouteDecision } from "@t3tools/contracts";
import { routeFor } from "@t3tools/shared/routing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

export interface RoutingPolicyInput {
  readonly modelSelection: ModelSelection;
  readonly prompt: string;
  readonly interactionMode: ProviderInteractionMode;
  /** Only a client in its Auto effort state asks; every other launch keeps its selection. */
  readonly requested: "auto" | undefined;
}

export interface RoutedSelection {
  readonly selection: ModelSelection;
  readonly decision: RouteDecision;
}

export class RoutingPolicy extends Context.Service<
  RoutingPolicy,
  {
    /** Null when no decision can be made; routing never fails a launch. */
    readonly decide: (input: RoutingPolicyInput) => Effect.Effect<RoutedSelection | null>;
  }
>()("t3/routing/RoutingPolicy") {}

const make = Effect.gen(function* () {
  const manifest = yield* ModelManifest.ModelManifest;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const decide = Effect.fn("RoutingPolicy.decide")(
    function* (input: RoutingPolicyInput) {
      const providers = yield* providerRegistry.getProviders;
      const provider = providers.find(
        (candidate) => candidate.instanceId === input.modelSelection.instanceId,
      );
      if (provider === undefined) return null;
      const model = provider.models.find(
        (candidate) =>
          candidate.slug === input.modelSelection.model ||
          candidate.aliases?.includes(input.modelSelection.model) === true,
      );
      const settings = yield* serverSettings.getSettings;
      return routeFor({
        table: ModelManifest.resolveRoutingTable(yield* manifest.current),
        driver: provider.driver,
        selection: input.modelSelection,
        modelSlug: model?.slug,
        descriptors: model?.capabilities?.optionDescriptors,
        prompt: input.prompt,
        interactionMode: input.interactionMode,
        apply: input.requested === "auto" && settings.autoRoutingEnabled,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Effort routing failed; the launch keeps its selection.", cause).pipe(
        Effect.as(null),
      ),
    ),
  );

  return RoutingPolicy.of({ decide });
});

export const layer = Layer.effect(RoutingPolicy, make);
