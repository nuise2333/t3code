import type { ProjectEntryKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isNetworkPath } from "@t3tools/shared/path";
import {
  insertRankedSearchResult,
  scoreSubsequenceMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { containsControlCharacter, escapeSpotlightString } from "../spotlightQuery.ts";

const HOST_SEARCH_RAW_ROW_CAP = 50_000;
// Measured warm mdfind answers in 0.6-1.6 s and a cold one took 2.1 s, all in one batch.
const SEARCH_DEADLINE = "3 seconds";
const FORCE_KILL_AFTER = "1 second";
const KIND_STAT_CONCURRENCY = 16;
// The type tree marks packages such as .app as directories; kMDItemContentType alone does not.
const SPOTLIGHT_KIND_ATTRIBUTE = "   kMDItemContentTypeTree = ";
const SPOTLIGHT_DIRECTORY_TYPE = '"public.directory"';
const SPOTLIGHT_INDEXING_PROBE_TTL = "30 seconds";
const LOCATE_GLOB_CHARACTERS = /[*?[\]\\]/gu;
const WINDOWS_NAME_FORBIDDEN_CHARACTERS = /[<>:"/\\|?*]/gu;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/gu;

export type HostFileSearchBackend = "spotlight" | "plocate" | "locate" | "everything";

export interface FilesystemSearchHostInput {
  readonly query: string;
  readonly limit: number;
  readonly kind?: ProjectEntryKind | undefined;
}

export interface FilesystemSearchHostEntry {
  readonly path: string;
  readonly kind: ProjectEntryKind;
}

export interface FilesystemSearchHostResult {
  readonly entries: ReadonlyArray<FilesystemSearchHostEntry>;
  /** More matches existed, or the index answered too slowly to list them all. */
  readonly truncated: boolean;
}

export class FilesystemSearchHostError extends Schema.TaggedError<FilesystemSearchHostError>()(
  "FilesystemSearchHostError",
  {
    /** `unavailable`: the host has no usable file index right now. */
    reason: Schema.Literals(["unavailable", "failed"]),
    detail: Schema.optional(Schema.String),
  },
) {}

export interface HostFileSearchAdapter {
  readonly backend: HostFileSearchBackend;
  readonly command: string;
}

export class HostFileSearch extends Context.Service<
  HostFileSearch,
  {
    /** The index found when the server started; each search still checks it answers. */
    readonly backend: HostFileSearchBackend | undefined;
    readonly search: (
      input: FilesystemSearchHostInput,
    ) => Effect.Effect<FilesystemSearchHostResult, FilesystemSearchHostError>;
  }
>()("t3/workspace/HostFileSearch") {}

/** Null when the query has nothing left to search once the backend's syntax is neutralized. */
export function hostSearchArgs(
  backend: HostFileSearchBackend,
  input: Pick<FilesystemSearchHostInput, "query" | "kind">,
): ReadonlyArray<string> | null {
  const { query, kind } = input;
  switch (backend) {
    case "spotlight": {
      const kindClause =
        kind === "directory"
          ? ` && kMDItemContentTypeTree == ${SPOTLIGHT_DIRECTORY_TYPE}`
          : kind === "file"
            ? ` && kMDItemContentTypeTree != ${SPOTLIGHT_DIRECTORY_TYPE}`
            : "";
      return [
        "-0",
        "-attr",
        "kMDItemContentTypeTree",
        `kMDItemFSName == "*${escapeSpotlightString(query)}*"cd${kindClause}`,
      ];
    }
    case "plocate":
    case "locate": {
      // Without wildcards locate matches a substring; with any, it globs the whole basename.
      const pattern = /[*?[\]\\]/u.test(query)
        ? `*${query.replace(LOCATE_GLOB_CHARACTERS, "\\$&")}*`
        : query;
      return ["-i", "-b", "-0", "-l", String(HOST_SEARCH_RAW_ROW_CAP), "--", pattern];
    }
    case "everything": {
      // es.exe keeps quotes in its argv and ignores `\"`, so the query goes in as an escaped
      // regex: no ASCII punctuation is left bare to read as a switch or Everything syntax.
      const literal = query.replace(WINDOWS_NAME_FORBIDDEN_CHARACTERS, "");
      if (literal.trim().length === 0) return null;
      return [
        "-n",
        String(HOST_SEARCH_RAW_ROW_CAP),
        ...(kind === "directory" ? ["/ad"] : kind === "file" ? ["/a-d"] : []),
        "-r",
        literal.replace(ASCII_PUNCTUATION, "\\$&"),
      ];
    }
  }
}

interface HostSearchContext {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly t3Home: string;
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replaceAll("/", "\\").toLowerCase() : path;
}

function isWithin(path: string, root: string, platform: NodeJS.Platform): boolean {
  const separator = platform === "win32" ? "\\" : "/";
  const target = comparablePath(path, platform);
  const base = comparablePath(root, platform).replace(/[\\/]+$/u, "");
  return target === base || target.startsWith(`${base}${separator}`);
}

/** Index rows nobody opens by name; they crowd real results out of the raw cap. */
export function isHostSearchNoise(path: string, context: HostSearchContext): boolean {
  if (isNetworkPath(path)) return true;
  const segments = path.split(context.platform === "win32" ? /[\\/]/u : "/");
  for (const segment of segments) {
    if (segment.startsWith(".") || segment === "node_modules") return true;
    if (context.platform === "win32") {
      const lower = segment.toLowerCase();
      if (lower === "$recycle.bin" || lower === "appdata") return true;
    }
  }
  if (isWithin(path, context.t3Home, context.platform)) return true;
  if (context.platform === "darwin") {
    const library = `${context.homeDirectory}/Library`;
    if (
      isWithin(path, `${library}/Mobile Documents`, "darwin") ||
      isWithin(path, `${library}/CloudStorage`, "darwin")
    ) {
      return false;
    }
    return (
      isWithin(path, library, "darwin") ||
      ["/System", "/Library", "/private"].some((root) => isWithin(path, root, "darwin"))
    );
  }
  return false;
}

interface HostSearchRow {
  readonly path: string;
  readonly kind: ProjectEntryKind | undefined;
}

function parseRow(
  backend: HostFileSearchBackend,
  raw: string,
  kind: ProjectEntryKind | undefined,
): HostSearchRow {
  switch (backend) {
    case "spotlight": {
      const attributeIndex = raw.lastIndexOf(SPOTLIGHT_KIND_ATTRIBUTE);
      if (attributeIndex === -1) return { path: raw, kind: "file" };
      return {
        path: raw.slice(0, attributeIndex),
        kind: raw.includes(SPOTLIGHT_DIRECTORY_TYPE, attributeIndex) ? "directory" : "file",
      };
    }
    case "everything":
      return { path: raw.replace(/\r$/u, ""), kind };
    case "plocate":
    case "locate":
      return { path: raw, kind: undefined };
  }
}

function basenameOf(path: string, platform: NodeJS.Platform): string {
  const trimmed = path.replace(platform === "win32" ? /[\\/]+$/u : /\/+$/u, "");
  const index =
    platform === "win32"
      ? Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
      : trimmed.lastIndexOf("/");
  return trimmed.slice(index + 1);
}

/** Filters and ranks rows as they stream in, keeping only the best `capacity`. */
export function makeHostSearchCollector(options: {
  readonly backend: HostFileSearchBackend;
  readonly input: Pick<FilesystemSearchHostInput, "query" | "kind">;
  readonly context: HostSearchContext;
  readonly capacity: number;
  readonly rawCap?: number;
}) {
  const { backend, input, context, capacity } = options;
  const rawCap = options.rawCap ?? HOST_SEARCH_RAW_ROW_CAP;
  const separator = backend === "everything" ? "\n" : "\0";
  // macOS returns names decomposed (NFD) while typed queries are composed (NFC).
  const query = input.query.normalize("NFC").toLowerCase();
  const ranked: RankedSearchResult<HostSearchRow>[] = [];
  let pending = "";
  let rows = 0;
  let matches = 0;

  const take = (raw: string) => {
    rows += 1;
    const row = parseRow(backend, raw, input.kind);
    if (row.path.length === 0 || isHostSearchNoise(row.path, context)) return;
    if (input.kind !== undefined && row.kind !== undefined && row.kind !== input.kind) return;
    const basename = basenameOf(row.path, context.platform);
    const score = scoreSubsequenceMatch(basename.normalize("NFC").toLowerCase(), query);
    if (score === null) return;
    matches += 1;
    insertRankedSearchResult(
      ranked,
      // The fraction orders equal scores by shorter path without outranking a better score.
      { item: row, score: score + Math.min(row.path.length, 4095) / 4096, tieBreaker: row.path },
      capacity,
    );
  };

  return {
    /** False once the raw cap is reached; the caller stops reading. */
    push: (text: string): boolean => {
      pending += text;
      let start = 0;
      for (;;) {
        const end = pending.indexOf(separator, start);
        if (end === -1) break;
        take(pending.slice(start, end));
        start = end + 1;
        if (rows >= rawCap) {
          pending = "";
          return false;
        }
      }
      pending = pending.slice(start);
      return true;
    },
    /** Takes the last row when output ends without a separator. */
    end: () => {
      if (pending.length > 0) take(pending);
      pending = "";
    },
    get capped() {
      return rows >= rawCap;
    },
    get rawRows() {
      return rows;
    },
    get matches() {
      return matches;
    },
    rows: (): ReadonlyArray<HostSearchRow> => ranked.map((entry) => entry.item),
  };
}

type HostSearchCollector = ReturnType<typeof makeHostSearchCollector>;

function unavailable(detail: string) {
  return new FilesystemSearchHostError({ reason: "unavailable", detail });
}

/** @public */
export const makeWithAdapter = Effect.fn("HostFileSearch.make")(function* (
  adapter: HostFileSearchAdapter | undefined,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const context: HostSearchContext = {
    platform: yield* HostProcess.Platform,
    homeDirectory: yield* HostProcess.HomeDirectory,
    t3Home: config.baseDir,
  };

  const readIndex = (
    command: string,
    args: ReadonlyArray<string>,
    collector: HostSearchCollector,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawnCommand = yield* resolveSpawnCommand(command, args);
        const child = yield* spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            shell: spawnCommand.shell,
            stdin: "ignore",
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        );
        const stderrBytes = yield* child.stderr.pipe(
          Stream.runFold(
            () => 0,
            (total, chunk: Uint8Array) => total + chunk.byteLength,
          ),
          Effect.forkScoped,
        );
        return yield* Effect.gen(function* () {
          yield* child.stdout.pipe(
            Stream.decodeText,
            Stream.runForEachWhile((text) => Effect.sync(() => collector.push(text))),
          );
          if (collector.capped) return { _tag: "capped" as const };
          collector.end();
          const code = yield* child.exitCode;
          const wroteStderr = (yield* Fiber.join(stderrBytes)) > 0;
          return { _tag: "exited" as const, code: Number(code), wroteStderr };
        }).pipe(Effect.timeoutOption(SEARCH_DEADLINE));
      }),
    ).pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "NotFound"
          ? unavailable(`${command} is not installed.`)
          : new FilesystemSearchHostError({ reason: "failed", detail: cause.message }),
      ),
    );

  const spotlightIndexingDisabled = yield* Effect.suspend(() =>
    spawner.string(
      ChildProcess.make("/usr/bin/mdutil", ["-s", "/"], { stdin: "ignore", stderr: "ignore" }),
    ),
  ).pipe(
    Effect.timeoutOption("1 second"),
    Effect.map((output) => Option.exists(output, (text) => /disabled/iu.test(text))),
    Effect.orElseSucceed(() => false),
    // Every keystroke that matches nothing asks, and the answer rarely changes.
    Effect.cachedWithTTL(SPOTLIGHT_INDEXING_PROBE_TTL),
  );

  const statKind = (row: HostSearchRow) =>
    fileSystem.stat(row.path).pipe(
      Effect.map((info): ReadonlyArray<FilesystemSearchHostEntry> => {
        if (info.type === "Directory") return [{ path: row.path, kind: "directory" }];
        if (info.type === "File") return [{ path: row.path, kind: "file" }];
        return [];
      }),
      // A locate database lags the disk, so a row may name a file that is gone.
      Effect.orElseSucceed(() => []),
    );

  const search = Effect.fn("HostFileSearch.search")(function* (input: FilesystemSearchHostInput) {
    if (adapter === undefined) {
      return yield* unavailable("No file index was found on this host.");
    }
    const args = containsControlCharacter(input.query)
      ? null
      : hostSearchArgs(adapter.backend, input);
    if (args === null) return { entries: [], truncated: false };
    yield* Effect.annotateCurrentSpan("hostFileSearch.backend", adapter.backend);

    // Spotlight reports each row's kind, and Everything does when asked for one.
    const knowsKind =
      adapter.backend === "spotlight" ||
      (adapter.backend === "everything" && input.kind !== undefined);
    const collector = makeHostSearchCollector({
      backend: adapter.backend,
      input,
      context,
      capacity: knowsKind ? input.limit : input.limit * 4,
    });
    const outcome = yield* readIndex(adapter.command, args, collector);

    if (Option.isSome(outcome) && outcome.value._tag === "exited") {
      const { code, wroteStderr } = outcome.value;
      const locate = adapter.backend === "plocate" || adapter.backend === "locate";
      // locate exits 1 quietly when nothing matches, and with a message when its database is unusable.
      if (code !== 0 && !(locate && code === 1 && !wroteStderr)) {
        return yield* unavailable(`${adapter.backend} exited with code ${code}.`);
      }
      if (
        adapter.backend === "spotlight" &&
        collector.rawRows === 0 &&
        (yield* spotlightIndexingDisabled)
      ) {
        return yield* unavailable("Spotlight indexing is turned off.");
      }
    }

    const ranked = collector.rows();
    const resolved = knowsKind
      ? ranked.flatMap((row) =>
          row.kind === undefined ? [] : [{ path: row.path, kind: row.kind }],
        )
      : (yield* Effect.forEach(ranked, statKind, { concurrency: KIND_STAT_CONCURRENCY })).flat();
    const entries = resolved.filter(
      (entry) => input.kind === undefined || entry.kind === input.kind,
    );
    return {
      entries: entries.slice(0, input.limit),
      truncated:
        Option.isNone(outcome) ||
        outcome.value._tag === "capped" ||
        collector.matches > ranked.length ||
        entries.length > input.limit,
    };
  });

  return HostFileSearch.of({ backend: adapter?.backend, search });
});

const detectAdapter = Effect.fn("HostFileSearch.detectAdapter")(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "darwin") {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem
      .exists("/usr/bin/mdfind")
      .pipe(Effect.orElseSucceed(() => false));
    return exists ? { backend: "spotlight" as const, command: "/usr/bin/mdfind" } : undefined;
  }
  const candidates: ReadonlyArray<HostFileSearchAdapter> =
    platform === "win32"
      ? [{ backend: "everything", command: "es" }]
      : [
          { backend: "plocate", command: "plocate" },
          { backend: "locate", command: "locate" },
        ];
  for (const candidate of candidates) {
    const command = yield* resolveCommandPath(candidate.command);
    if (command !== null) return { backend: candidate.backend, command };
  }
  return undefined;
});

export const layer = Layer.effect(
  HostFileSearch,
  detectAdapter().pipe(Effect.flatMap((adapter) => makeWithAdapter(adapter))),
);
