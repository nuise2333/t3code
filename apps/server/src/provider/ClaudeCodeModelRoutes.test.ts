import { assert, describe, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import { makeClaudeCodeModelRoutes } from "./ClaudeCodeModelRoutes.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogApiModelId,
} from "./ClaudeModelCatalog.ts";

describe("Claude Code model routes", () => {
  it.effect("a turn sends only effort levels Claude Code reports for the model", () =>
    Effect.gen(function* () {
      const routes = yield* makeClaudeCodeModelRoutes(
        () => Effect.succeed("same settings"),
        "/state",
      );
      yield* routes.record([
        {
          value: "claude-opus-4-7",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ]);
      yield* routes.settle;
      const catalog = yield* routes.route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project");
      const opus = (effort?: string) =>
        ({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-7",
          ...(effort ? { options: [{ id: "effort", value: effort }] } : {}),
        }) satisfies ModelSelection;
      // The bundled default (xhigh) and a stored xhigh both fall to the highest live level.
      assert.strictEqual(compileClaudeModelSelection(opus(), catalog).effort, "high");
      assert.strictEqual(compileClaudeModelSelection(opus("xhigh"), catalog).effort, "high");
      assert.strictEqual(compileClaudeModelSelection(opus("low"), catalog).effort, "low");
      // Settings that differ from the probe's drop the model routes but never the live levels.
      const launched = yield* routes.route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project", {
        env: { AWS_REGION: "us-west-2" },
      });
      assert.strictEqual(compileClaudeModelSelection(opus("xhigh"), launched).effort, "high");
      const otherSettings = yield* makeClaudeCodeModelRoutes(
        (cwd) => Effect.succeed(cwd === "/state" ? "probe settings" : "project settings"),
        "/state",
      );
      yield* otherSettings.record([
        {
          // A routed alias makes the cwd's settings decide, the last branch of route().
          value: "opus",
          resolvedModel: "us.anthropic.claude-opus-4-7-v1:0",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ]);
      yield* otherSettings.settle;
      const project = yield* otherSettings.route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project");
      assert.strictEqual(compileClaudeModelSelection(opus(), project).effort, "high");
    }),
  );

  it.effect(
    "a turn that starts before the first probe settles waits and then gets its routes",
    () =>
      Effect.gen(function* () {
        const haiku = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
        } satisfies ModelSelection;
        const routes = yield* makeClaudeCodeModelRoutes(
          () => Effect.succeed("same settings"),
          "/state",
        );
        const early = yield* routes
          .route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* routes.record([
          { value: "haiku", resolvedModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
        ]);
        yield* routes.settle;
        assert.strictEqual(
          resolveClaudeCatalogApiModelId(yield* Fiber.join(early), haiku),
          "haiku",
        );

        // A first check that never reaches the probe still releases waiting turns.
        const unprobed = yield* makeClaudeCodeModelRoutes(
          () => Effect.succeed("same settings"),
          "/state",
        );
        const waiting = yield* unprobed
          .route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* unprobed.settle;
        assert.strictEqual(yield* Fiber.join(waiting), BUNDLED_CLAUDE_MODEL_CATALOG);

        const stuck = yield* makeClaudeCodeModelRoutes(
          () => Effect.succeed("same settings"),
          "/state",
        );
        const fallback = yield* stuck
          .route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* Fiber.join(fallback), BUNDLED_CLAUDE_MODEL_CATALOG);
        // Later turns, steers and effort changes do not wait for the stuck probe again.
        const later = yield* stuck
          .route(BUNDLED_CLAUDE_MODEL_CATALOG, "/project")
          .pipe(Effect.timeoutOption("1 second"), Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        assert.deepStrictEqual(yield* Fiber.join(later), Option.some(BUNDLED_CLAUDE_MODEL_CATALOG));
      }),
  );
});
