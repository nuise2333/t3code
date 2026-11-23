import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  TextGenerationError,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThoughtTranslationService from "./ThoughtTranslationService.ts";

const TEST_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
};

const makeTestLayer = (
  generate: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"],
  options?: { readonly maxCacheEntries?: number },
) =>
  Layer.effect(
    ThoughtTranslationService.ThoughtTranslationService,
    ThoughtTranslationService.make(options),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.ServerSettingsService.layerTest({
          ...DEFAULT_SERVER_SETTINGS,
          textGenerationModelSelection: TEST_MODEL_SELECTION,
        }),
        Layer.succeed(
          TextGeneration.TextGeneration,
          TextGeneration.TextGeneration.of({
            generateCommitMessage: () => Effect.die("unused"),
            generatePrContent: () => Effect.die("unused"),
            generateBranchName: () => Effect.die("unused"),
            generateThreadTitle: () => Effect.die("unused"),
            generateReviewGuide: () => Effect.die("unused"),
            generateTranscriptionPostProcessing: generate,
          }),
        ),
        FileSystem.layerNoop({
          makeTempDirectoryScoped: () => Effect.succeed("/tmp/t3-thought-translate-test"),
        }),
      ),
    ),
  );

describe("ThoughtTranslationService", () => {
  it.effect("skips translation when text is already in the target language", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const service = yield* ThoughtTranslationService.ThoughtTranslationService.pipe(
        Effect.provide(
          makeTestLayer(() =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.as({ transcription: "should not run" }),
            ),
          ),
        ),
      );

      const source = "我先检查一下配置文件，然后更新服务端接口。";
      const result = yield* service.translate({
        text: source,
        targetLanguage: "简体中文",
      });

      expect(result).toEqual({
        translatedText: source,
        cached: false,
        skipped: true,
      });
      expect(yield* Ref.get(calls)).toBe(0);
    }),
  );

  it.effect("caches translations by text, targetLanguage, and style and evicts LRU entries", () =>
    Effect.gen(function* () {
      const seenModels = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
      const callCount = yield* Ref.make(0);
      const service = yield* ThoughtTranslationService.ThoughtTranslationService.pipe(
        Effect.provide(
          makeTestLayer(
            (input) =>
              Effect.gen(function* () {
                const count = yield* Ref.updateAndGet(callCount, (n) => n + 1);
                yield* Ref.update(seenModels, (models) => [...models, input.modelSelection]);
                return { transcription: `译文 #${count}` };
              }),
            { maxCacheEntries: 2 },
          ),
        ),
      );

      const first = yield* service.translate({
        text: "Let me inspect the WebSocket router first.",
        targetLanguage: "简体中文",
      });
      expect(first).toEqual({ translatedText: "译文 #1", cached: false, skipped: false });

      const cached = yield* service.translate({
        text: "Let me inspect the WebSocket router first.",
        targetLanguage: "简体中文",
      });
      expect(cached).toEqual({ translatedText: "译文 #1", cached: true, skipped: false });
      expect(yield* Ref.get(callCount)).toBe(1);
      const models = yield* Ref.get(seenModels);
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject(TEST_MODEL_SELECTION);

      // Different style produces a distinct cache key.
      const concise = yield* service.translate({
        text: "Let me inspect the WebSocket router first.",
        targetLanguage: "简体中文",
        style: "concise",
      });
      expect(concise).toEqual({ translatedText: "译文 #2", cached: false, skipped: false });

      // Refresh entry 1 so entry 2 becomes least-recently used, then insert entry 3 to evict entry 2.
      yield* service.translate({
        text: "Let me inspect the WebSocket router first.",
        targetLanguage: "简体中文",
      });
      yield* service.translate({
        text: "Now I will verify the contracts schema.",
        targetLanguage: "简体中文",
      });

      const evicted = yield* service.translate({
        text: "Let me inspect the WebSocket router first.",
        targetLanguage: "简体中文",
        style: "concise",
      });
      expect(evicted.cached).toBe(false);
      expect(yield* Ref.get(callCount)).toBe(4);
    }),
  );

  it.effect("limits concurrent text generation calls to 3", () =>
    Effect.gen(function* () {
      const inFlight = yield* Ref.make(0);
      const maxInFlight = yield* Ref.make(0);
      const startedCount = yield* Ref.make(0);
      const threeStarted = yield* Deferred.make<void>();
      const gate1 = yield* Deferred.make<void>();
      const gateRest = yield* Deferred.make<void>();

      const service = yield* ThoughtTranslationService.ThoughtTranslationService.pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.gen(function* () {
              const active = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
              yield* Ref.update(maxInFlight, (max) => Math.max(max, active));
              const started = yield* Ref.updateAndGet(startedCount, (n) => n + 1);
              if (started === 3) {
                yield* Deferred.succeed(threeStarted, undefined);
              }
              yield* Deferred.await(started === 1 ? gate1 : gateRest);
              yield* Ref.update(inFlight, (n) => n - 1);
              return { transcription: `translated:${input.prompt.length}` };
            }),
          ),
        ),
      );

      const prompts = [
        "First reasoning block to check concurrency limit.",
        "Second reasoning block to check concurrency limit.",
        "Third reasoning block to check concurrency limit.",
        "Fourth reasoning block to check concurrency limit.",
        "Fifth reasoning block to check concurrency limit.",
      ];

      const fibers = yield* Effect.forEach(prompts, (text) =>
        Effect.forkChild(service.translate({ text, targetLanguage: "简体中文" })),
      );

      yield* Deferred.await(threeStarted);
      expect(yield* Ref.get(inFlight)).toBe(3);
      expect(yield* Ref.get(startedCount)).toBe(3);

      yield* Deferred.succeed(gate1, undefined);
      yield* Deferred.succeed(gateRest, undefined);

      const results = yield* Effect.forEach(fibers, Fiber.join);
      expect(results).toHaveLength(5);
      expect(results.every((result) => !result.skipped && result.translatedText.length > 0)).toBe(
        true,
      );
      expect(yield* Ref.get(maxInFlight)).toBe(3);
    }),
  );

  it.effect("maps generation failures and empty output to ThoughtTranslationError", () =>
    Effect.gen(function* () {
      const failingService = yield* ThoughtTranslationService.ThoughtTranslationService.pipe(
        Effect.provide(
          makeTestLayer(() =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateTranscriptionPostProcessing",
                detail: "provider offline",
              }),
            ),
          ),
        ),
      );

      const failed = yield* failingService
        .translate({
          text: "Inspecting the failing provider path.",
          targetLanguage: "简体中文",
        })
        .pipe(Effect.flip);
      expect(failed._tag).toBe("ThoughtTranslationError");
      expect(failed.reason).toBe("generation_failed");

      const emptyService = yield* ThoughtTranslationService.ThoughtTranslationService.pipe(
        Effect.provide(makeTestLayer(() => Effect.succeed({ transcription: "   " }))),
      );
      const empty = yield* emptyService
        .translate({
          text: "Inspecting empty translation handling.",
          targetLanguage: "简体中文",
        })
        .pipe(Effect.flip);
      expect(empty._tag).toBe("ThoughtTranslationError");
      expect(empty.reason).toBe("empty_output");
    }),
  );
});
