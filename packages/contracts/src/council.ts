import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Guidance packs that make an agent spend fewer tokens; each is a short, plain instruction. */
export const TokenSaverPack = Schema.Literals([
  "caveman",
  "lean-code",
  "quiet-tools",
  "rtk",
  "economizer",
]);
export type TokenSaverPack = typeof TokenSaverPack.Type;

/** How terse Caveman makes replies. */
export const TokenSaverLevel = Schema.Literals(["lite", "full", "ultra"]);
export type TokenSaverLevel = typeof TokenSaverLevel.Type;

export const TokenSaverSettings = Schema.Struct({
  packs: Schema.Array(TokenSaverPack).check(Schema.isMaxLength(5)),
  level: TokenSaverLevel,
});
export type TokenSaverSettings = typeof TokenSaverSettings.Type;

/**
 * A thread's token saver; the server stamps `changedAt` (epoch milliseconds) so it knows when to
 * restate it. Times are numbers: a thread's lenient fields cannot hold a DateTime.
 */
export const ThreadTokenSaver = Schema.Struct({
  ...TokenSaverSettings.fields,
  changedAt: Schema.Finite,
});
export type ThreadTokenSaver = typeof ThreadTokenSaver.Type;

export const COUNCIL_TARGETS = [7, 8, 8.5, 9, 9.5, 10] as const;
export const COUNCIL_MAX_ROUNDS = [3, 5, 10, 25] as const;
export const COUNCIL_REVIEWER_COUNTS = [2, 3, 4, 5] as const;

/** How a Council reviews: the score every reviewer must reach, the round limit and the seats. */
export const CouncilSettings = Schema.Struct({
  target: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10)),
  maxRounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  /** "auto" lets the lead pick 2 to 5 reviewers; a number fixes it. */
  reviewers: Schema.Union([
    Schema.Literal("auto"),
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(2), Schema.isLessThanOrEqualTo(5)),
  ]),
});
export type CouncilSettings = typeof CouncilSettings.Type;

const DEFAULT_COUNCIL_SETTINGS: CouncilSettings = {
  target: 9,
  maxRounds: 10,
  reviewers: "auto",
};

/**
 * Council on a thread. `since` starts the review cycle: only reviewers and changes after it count.
 * `acceptedAt` is set when the user accepted the cycle's scores as they stand.
 */
export const ThreadCouncil = Schema.Struct({
  ...CouncilSettings.fields,
  /** Epoch milliseconds. */
  since: Schema.Finite,
  /** Epoch milliseconds. */
  acceptedAt: Schema.optionalKey(Schema.Finite),
});
export type ThreadCouncil = typeof ThreadCouncil.Type;

/** A reviewer ends its report with this line; the server reads the score from it. */
export const COUNCIL_SCORE_PREFIX = "Council score:";

/** Lens names a reviewer by what it checks, such as "correctness" or "tests". */
export const CouncilLens = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

/** What a new thread starts with: the panel's settings, and whether Council starts on. */
export const CouncilDefaults = Schema.Struct({
  ...CouncilSettings.fields,
  newThreads: Schema.Boolean,
});
export type CouncilDefaults = typeof CouncilDefaults.Type;

export const DEFAULT_COUNCIL_DEFAULTS: CouncilDefaults = {
  ...DEFAULT_COUNCIL_SETTINGS,
  newThreads: false,
};
