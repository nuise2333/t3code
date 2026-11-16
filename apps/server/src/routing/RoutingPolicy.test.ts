import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CrossVendorModelResult,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RoutingPolicy from "./RoutingPolicy.ts";

const claudeId = ProviderInstanceId.make("claude_fake");
const codexId = ProviderInstanceId.make("codex_fake");
const antigravityId = ProviderInstanceId.make("antigravity_fake");

const provider = (
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
): ServerProvider =>
  ({
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: models.map((model) => ({ ...model, isCustom: false })),
  }) as unknown as ServerProvider;

const claude = provider(claudeId, "claudeAgent", [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
]);
const codex = provider(codexId, "codex", [
  { slug: "magpie-luna-group", name: "GPT-5.6 Luna · routing group" },
  { slug: "gpt-6-luna", name: "GPT-6 Luna" },
  { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
]);
const antigravity = provider(antigravityId, "antigravity", [
  { slug: "gemini-4-carbon", name: "Gemini 4 Carbon" },
]);

describe("RoutingPolicy.crossVendorModel", () => {
  it.effect.each<{
    readonly name: string;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly failing: { readonly instanceId: ProviderInstanceId; readonly model: string };
    readonly expected: CrossVendorModelResult;
  }>([
    {
      name: "an Opus failure gets Sol with Auto and its switches off",
      providers: [codex, antigravity, claude],
      failing: { instanceId: claudeId, model: "claude-opus-5-5" },
      expected: {
        selection: { instanceId: codexId, model: "gpt-6.1-sol" },
        modelName: "GPT-6.1 Sol",
      },
    },
    {
      name: "an Opus failure gets a gateway-prefixed Sol under the gateway's id and name",
      providers: [
        provider(codexId, "codex", [
          { slug: "group/gpt-6.1-sol-high", name: "GPT-6.1 Sol High" },
          { slug: "auto/gpt-6.1-sol", name: "GPT-6.1 Sol · routing group" },
        ]),
        claude,
      ],
      failing: { instanceId: claudeId, model: "claude-opus-5-5" },
      expected: {
        selection: { instanceId: codexId, model: "auto/gpt-6.1-sol" },
        modelName: "GPT-6.1 Sol · routing group",
      },
    },
    {
      name: "a Sol failure gets nothing when Gemini 4 is the only other vendor",
      providers: [codex, antigravity],
      failing: { instanceId: codexId, model: "gpt-6.1-sol" },
      expected: null,
    },
  ])("$name", ({ providers, failing, expected }) =>
    Effect.gen(function* () {
      const policy = yield* RoutingPolicy.RoutingPolicy;
      expect(yield* policy.crossVendorModel({ failing, projectId: null })).toEqual(expected);
    }).pipe(
      Effect.provide(
        RoutingPolicy.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ModelManifest.layerTest,
              ProviderRegistryMock.layer(providers),
              ServerSettings.layerTest({
                providerInstances: Object.fromEntries(
                  providers.map((entry) => [entry.instanceId, { driver: entry.driver }]),
                ),
                autoRouting: {
                  enabled: false,
                  allowModelSwitch: false,
                  allowProviderSwitch: false,
                },
              }),
              Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                list: () => Effect.succeed(providers.map((entry) => entry.instanceId)),
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
