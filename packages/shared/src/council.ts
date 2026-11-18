import {
  COUNCIL_SCORE_PREFIX,
  type CouncilSettings,
  type OrchestrationV2Subagent,
  type ThreadCouncil,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * The score a Council reviewer gave: the last line of its report that starts with
 * "Council score:", past markdown, read as N or N/10. Anything outside 0-10 is no score.
 */
export function parseCouncilScore(report: string | null | undefined): number | null {
  if (!report) return null;
  const prefix = COUNCIL_SCORE_PREFIX.toLowerCase();
  const lines = report.split("\n").slice(-40).reverse();
  for (const raw of lines) {
    const line = raw
      .replace(/^[\s>#*_`-]+/, "")
      .replace(/[*_`]+/g, "")
      .trim();
    if (!line.toLowerCase().startsWith(prefix)) continue;
    const match = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*10)?\s*\.?\s*$/.exec(line.slice(prefix.length));
    if (!match) return null;
    const score = Number(match[1]);
    return score >= 0 && score <= 10 ? score : null;
  }
  return null;
}

export type CouncilSeatStatus = "reviewing" | "scored" | "unscored" | "stopped";

export interface CouncilSeat {
  readonly taskId: string;
  readonly lens: string;
  readonly status: CouncilSeatStatus;
  readonly score: number | null;
  readonly childThreadId: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
}

export interface CouncilRound {
  readonly number: number;
  readonly seats: ReadonlyArray<CouncilSeat>;
  readonly startedAtMs: number;
}

export type CouncilState =
  /** The user accepted this cycle's scores. */
  | "accepted"
  /** No round has started this cycle. */
  | "waiting"
  /** A reviewer of the latest round is still working. */
  | "reviewing"
  /** The latest round ended without enough scores: the lead must seat reviewers again. */
  | "dispatch"
  /** The latest round's lowest score is below the target and rounds are left. */
  | "fixing"
  /** Every reviewer of the latest round reached the target. */
  | "passed"
  /** The round limit was reached below the target. */
  | "limit";

export interface CouncilStatus {
  readonly state: CouncilState;
  /** When this review cycle started: Council's start, or a later user message. */
  readonly cycleStartMs: number;
  readonly target: number;
  readonly maxRounds: number;
  /** Rounds started this cycle; the latest is `rounds[rounds.length - 1]`. */
  readonly rounds: ReadonlyArray<CouncilRound>;
  /** The latest round's lowest score, or null before any score. */
  readonly lowest: number | null;
  /** Each lens's first and latest score this cycle, in round-1 order. */
  readonly lenses: ReadonlyArray<{
    readonly lens: string;
    readonly first: number | null;
    readonly latest: number | null;
  }>;
}

const LIVE: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

const toMs = (value: DateTime.Utc | null) =>
  value === null ? null : DateTime.toEpochMillis(value);

/** The fewest scored seats that complete a round. */
function councilMinimumSeats(settings: Pick<CouncilSettings, "reviewers">): number {
  return settings.reviewers === "auto" ? 2 : settings.reviewers;
}

function seatOf(task: OrchestrationV2Subagent): CouncilSeat {
  const score = task.status === "completed" ? parseCouncilScore(task.result) : null;
  return {
    taskId: task.id,
    lens: task.councilLens ?? "Reviewer",
    status: LIVE.has(task.status)
      ? "reviewing"
      : score !== null
        ? "scored"
        : task.status === "completed"
          ? "unscored"
          : "stopped",
    score,
    childThreadId: task.childThreadId,
    startedAtMs: toMs(task.startedAt) ?? DateTime.toEpochMillis(task.updatedAt),
    completedAtMs: toMs(task.completedAt),
  };
}

/**
 * This cycle's reviewers, grouped into rounds. A reviewer joins the latest round unless every
 * seat of that round had already settled when it started; then it opens the next round.
 */
function councilRounds(input: {
  readonly threadId: string;
  readonly sinceMs: number;
  /** Seats that started at or after this end the window; absent for none. */
  readonly untilMs?: number;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
}): ReadonlyArray<CouncilRound> {
  const { sinceMs, untilMs = Infinity } = input;
  const seats = input.subagents
    .filter(
      (task) =>
        task.threadId === input.threadId &&
        task.origin === "app_owned" &&
        task.councilLens !== undefined,
    )
    .map(seatOf)
    .filter((seat) => seat.startedAtMs >= sinceMs && seat.startedAtMs < untilMs)
    .sort((left, right) => left.startedAtMs - right.startedAtMs);
  const rounds: Array<{ number: number; seats: CouncilSeat[]; startedAtMs: number }> = [];
  for (const seat of seats) {
    const current = rounds.at(-1);
    const settledBefore =
      current !== undefined &&
      current.seats.every(
        (member) => member.completedAtMs !== null && member.completedAtMs <= seat.startedAtMs,
      );
    if (current === undefined || settledBefore) {
      rounds.push({ number: rounds.length + 1, seats: [seat], startedAtMs: seat.startedAtMs });
    } else {
      current.seats.push(seat);
    }
  }
  return rounds;
}

interface CouncilStatusInput {
  readonly threadId: string;
  readonly council: ThreadCouncil;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  /**
   * When the user sent each message, in any order. A message starts a new cycle only when the
   * one before it had nothing outstanding (passed, at its limit, accepted or never reviewed), so
   * "keep going" after a stop continues its rounds.
   */
  readonly userMessageTimesMs: ReadonlyArray<number>;
}

function statusFor(input: CouncilStatusInput, sinceMs: number, untilMs: number): CouncilStatus {
  const { council } = input;
  const rounds = councilRounds({ ...input, sinceMs, untilMs });
  const latest = rounds.at(-1);
  const scores = (latest?.seats ?? []).flatMap((seat) => (seat.score === null ? [] : [seat.score]));
  const lowest = scores.length === 0 ? null : Math.min(...scores);
  const lensOrder = [...new Set(rounds.flatMap((round) => round.seats.map((seat) => seat.lens)))];
  const lenses = lensOrder.map((lens) => {
    const scored = rounds.flatMap((round) =>
      round.seats.filter((seat) => seat.lens === lens && seat.score !== null),
    );
    return {
      lens,
      first: scored[0]?.score ?? null,
      latest:
        latest?.seats.find((seat) => seat.lens === lens && seat.score !== null)?.score ?? null,
    };
  });
  const acceptedMs = council.acceptedAt ?? null;
  const accepted = acceptedMs !== null && acceptedMs >= sinceMs && acceptedMs < untilMs;
  const state: CouncilState = accepted
    ? "accepted"
    : latest === undefined
      ? "waiting"
      : latest.seats.some((seat) => seat.status === "reviewing")
        ? "reviewing"
        : scores.length < councilMinimumSeats(council)
          ? "dispatch"
          : lowest !== null && lowest >= council.target
            ? "passed"
            : rounds.length >= council.maxRounds
              ? "limit"
              : "fixing";
  return {
    state,
    target: council.target,
    maxRounds: council.maxRounds,
    rounds,
    lowest,
    lenses,
    cycleStartMs: sinceMs,
  };
}

const SETTLED_STATES: ReadonlySet<CouncilState> = new Set([
  "accepted",
  "waiting",
  "passed",
  "limit",
]);

/** Where a thread's Council stands, from its settings and the reviewers it convened. */
export function councilStatus(input: CouncilStatusInput): CouncilStatus {
  let sinceMs = input.council.since;
  const messages = [...input.userMessageTimesMs]
    .filter((at) => at > sinceMs)
    .sort((left, right) => left - right);
  for (const at of messages) {
    if (SETTLED_STATES.has(statusFor(input, sinceMs, at).state)) sinceMs = at;
  }
  return statusFor(input, sinceMs, Infinity);
}

/** Such as "9.0" or "8.5", so targets and scores read alike. */
export function formatCouncilScore(score: number): string {
  return Number.isInteger(score) ? score.toFixed(1) : String(score);
}

/**
 * Council runs only on a thread the user talks to: never on a fork's side chat, a delegated
 * task (a reviewer or member) or a task from a linked environment.
 */
export function councilApplies(thread: {
  readonly lineage: {
    readonly relationshipToParent: string | null;
    readonly sideChat?: boolean | undefined;
  };
  readonly delegatedFrom?: unknown;
}): boolean {
  return (
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.lineage.sideChat !== true &&
    thread.delegatedFrom == null
  );
}

/** When the user (not an agent, a task's result or the server) sent each message. */
export function councilUserMessageTimes(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly createdBy: string;
    readonly createdAt: DateTime.Utc;
    readonly senderThreadId?: unknown;
    readonly delegatedCompletion?: unknown;
  }>,
): ReadonlyArray<number> {
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.createdBy === "user" &&
        message.senderThreadId === undefined &&
        message.delegatedCompletion === undefined,
    )
    .map((message) => DateTime.toEpochMillis(message.createdAt));
}
