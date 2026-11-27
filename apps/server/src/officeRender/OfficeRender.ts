import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import { openMediaFile, type OpenMediaFile } from "../assets/MediaFile.ts";
import {
  cacheName,
  convert,
  findSoffice,
  prepareProfile,
  removeStaleConversions,
  runSoffice,
  touchCached,
} from "./officeHost.ts";

class OfficeRendererUnavailable extends Schema.TaggedError<OfficeRendererUnavailable>()(
  "OfficeRendererUnavailable",
  {},
) {}
class OfficeRenderFailed extends Schema.TaggedError<OfficeRenderFailed>()("OfficeRenderFailed", {
  detail: Schema.String,
}) {}

export class OfficeRender extends Context.Service<
  OfficeRender,
  {
    readonly available: Effect.Effect<boolean>;
    readonly renderPdf: (
      absolutePath: string,
      opened?: OpenMediaFile,
    ) => Effect.Effect<string, OfficeRendererUnavailable | OfficeRenderFailed>;
  }
>()("t3/officeRender/OfficeRender") {}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OfficeRenderFailed({ detail: String(cause).slice(-2500) }),
  });

export const make = Effect.fn("OfficeRender.make")(function* (options?: {
  find?: typeof findSoffice;
  run?: typeof runSoffice;
  budget?: number;
}) {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const files = yield* FileSystem.FileSystem;
  const cache = path.join(config.providerStatusCacheDir, "office-render");
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const find = options?.find ?? findSoffice;
  const binary = yield* Effect.cached(Effect.promise(() => find(platform, env)));
  const cacheDirectory = yield* Effect.cachedWithTTL(
    files.makeDirectory(cache, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(files.realPath(cache)),
      Effect.mapError(
        () => new OfficeRenderFailed({ detail: "Could not initialize the render cache." }),
      ),
    ),
    (exit) => (Exit.isSuccess(exit) ? Infinity : 0),
  );
  let prepared = false;
  const semaphore = yield* Semaphore.make(1);
  const pending = new Map<string, Deferred.Deferred<string, OfficeRenderFailed>>();
  const render = Effect.fn("OfficeRender.convert")(
    function* (bin: string, source: string, file: OpenMediaFile, pdf: string) {
      if (!prepared) {
        yield* attempt(() => prepareProfile(path.join(cache, "profile"), platform, home));
        // Conversions run one at a time, so before the first none of these folders is in use.
        yield* attempt(() => removeStaleConversions(cache));
        prepared = true;
      }
      return yield* attempt(() =>
        convert(
          bin,
          source,
          file,
          pdf,
          options?.budget ?? 512 * 1024 * 1024,
          options?.run ?? runSoffice,
        ),
      );
    },
    Effect.uninterruptible,
    semaphore.withPermit,
  );
  return OfficeRender.of({
    available: Effect.map(binary, (value) => value !== null),
    renderPdf: Effect.fn("OfficeRender.renderPdf")(function* (absolutePath, opened) {
      const bin = yield* binary;
      if (!bin) return yield* new OfficeRendererUnavailable({});
      const source = opened
        ? absolutePath
        : yield* files
            .realPath(absolutePath)
            .pipe(
              Effect.mapError(
                () => new OfficeRenderFailed({ detail: "Source file is unavailable." }),
              ),
            );
      const file = opened ?? (yield* openMediaFile(source).pipe(Effect.orElseSucceed(() => null)));
      if (!file) return yield* new OfficeRenderFailed({ detail: "Source file is unavailable." });
      const pdf = path.join(yield* cacheDirectory, cacheName(source, file));
      const now = yield* Clock.currentTimeMillis;
      const existing = pending.get(pdf);
      if (existing) return yield* Deferred.await(existing);
      const job = Deferred.makeUnsafe<string, OfficeRenderFailed>();
      pending.set(pdf, job);
      yield* attempt(() => touchCached(pdf, now)).pipe(
        Effect.flatMap((hit) => (hit ? Effect.succeed(pdf) : render(bin, source, file, pdf))),
        Deferred.into(job),
        Effect.ensuring(Effect.sync(() => pending.delete(pdf))),
      );
      return yield* Deferred.await(job);
    }, Effect.scoped),
  });
});

export const layer = Layer.effect(OfficeRender, make());
