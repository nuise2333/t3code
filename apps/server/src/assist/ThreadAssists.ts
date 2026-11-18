import {
  COUNCIL_SCORE_PREFIX,
  type OrchestrationV2Run,
  type RunId,
  type ThreadCouncil,
  type ThreadTokenSaver,
} from "@t3tools/contracts";
import { type CouncilStatus, formatCouncilScore } from "@t3tools/shared/council";
import { tokenSaverDue, tokenSaverGuidance } from "@t3tools/shared/tokenSaver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** Where rtk usually lands besides PATH, which a desktop app's server may not inherit. */
const RTK_EXTRA_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Whether the rtk command is installed, for the RTK compression pack. */
export const rtkInstalled = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return false;
  const directories = [
    ...(environment.PATH ?? "").split(":").filter((entry) => entry.startsWith("/")),
    ...RTK_EXTRA_DIRECTORIES,
    `${home}/.cargo/bin`,
    `${home}/.local/bin`,
  ];
  for (const directory of new Set(directories)) {
    if (yield* fileSystem.exists(`${directory}/rtk`).pipe(Effect.orElseSucceed(() => false))) {
      return true;
    }
  }
  return false;
});

/**
 * The token saver block for this turn, or null when nothing needs saying: the guidance goes out
 * on the first turn after it changed and then every few turns while a pack is on.
 */
export function tokenSaverBlock(input: {
  readonly saver: ThreadTokenSaver | null | undefined;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "requestedAt">>;
  readonly currentRunId: RunId;
  readonly rtk: boolean;
}): string | null {
  const saver = input.saver;
  if (!saver) return null;
  const changedMs = saver.changedAt;
  const turnsSinceChange = input.runs.filter(
    (run) => run.id !== input.currentRunId && DateTime.toEpochMillis(run.requestedAt) >= changedMs,
  ).length;
  const anyActive = saver.packs.some((pack) => pack !== "rtk" || input.rtk);
  if (!tokenSaverDue({ turnsSinceChange, anyActive })) return null;
  return tokenSaverGuidance(saver, { rtk: input.rtk });
}

function reviewerCount(council: ThreadCouncil): string {
  return council.reviewers === "auto"
    ? "2 to 5 reviewers (you choose how many)"
    : `exactly ${council.reviewers} reviewers`;
}

/** One line on where the Council stands, for the lead and the continue turn. */
function councilStatusLine(status: CouncilStatus): string {
  const round = status.rounds.length;
  const target = formatCouncilScore(status.target);
  const lowest = status.lowest === null ? "none yet" : formatCouncilScore(status.lowest);
  const scores = (status.rounds.at(-1)?.seats ?? [])
    .map(
      (seat) =>
        `${seat.lens} ${seat.score === null ? `(${seat.status})` : formatCouncilScore(seat.score)}`,
    )
    .join(", ");
  switch (status.state) {
    case "accepted":
      return "The user accepted the scores as they stand: finish without another round.";
    case "waiting":
      return `No round yet. Target ${target}; up to ${status.maxRounds} rounds.`;
    case "reviewing":
      return `Round ${round} of ${status.maxRounds} is reviewing (${scores}). Wait for the reviewers; their results come back to you.`;
    case "dispatch":
      return `Round ${round} of ${status.maxRounds} ended without enough scores (${scores}). Seat reviewers again for the lenses that have no score.`;
    case "fixing":
      return `Round ${round} of ${status.maxRounds}: lowest ${lowest}, below the target ${target} (${scores}). Fix what the reviewers found, then convene round ${round + 1}.`;
    case "passed":
      return `Round ${round} passed: lowest ${lowest} reaches the target ${target} (${scores}).`;
    case "limit":
      return `The round limit (${status.maxRounds}) is reached with lowest ${lowest}, below the target ${target}. Finish and tell the user what still falls short.`;
  }
}

/** Rides on every lead turn while Council is on, with where the cycle stands. */
export function councilLeadPrompt(council: ThreadCouncil, status: CouncilStatus): string {
  const target = formatCouncilScore(council.target);
  return [
    `<t3_code_council target="${target}" max_rounds="${council.maxRounds}">`,
    `Council is on: independent reviewers must each score the work at least ${target}/10 before you finish. The lowest score counts, not the average.`,
    `1. When the work for this request is done, convene a round: delegate ${reviewerCount(council)} in parallel with \`delegate_task\`, each with its own \`councilLens\` naming what it checks (such as "correctness", "tests", "UX"). Name the work to inspect in each task. Prefer a different model per reviewer. Round 1's lenses stay fixed: seat each of them again in every later round.`,
    `2. Reviewers inspect and report; they never change the work. Each report ends with "${COUNCIL_SCORE_PREFIX} N/10"; their results come back to you.`,
    `3. If the lowest score is below ${target}, fix what they found, then convene a fresh round with new reviewers. At most ${council.maxRounds} rounds.`,
    `4. Finish only when the latest round's lowest score reaches ${target}, or at the round limit. Then show the user a table of each lens's first and final score.`,
    "If a blocker should not be fixed, end your turn and tell the user why; they can lower the target, accept the scores or turn Council off. A question that changes nothing needs no round.",
    `Now: ${councilStatusLine(status)}`,
    "</t3_code_council>",
  ].join("\n");
}

/** What a Council reviewer is told before the lead's task. */
export function councilReviewerTask(lens: string, task: string): string {
  return [
    `<t3_code_council_reviewer lens="${lens.replaceAll('"', "'")}">`,
    `You are an independent Council reviewer. Your lens: ${lens}.`,
    "Inspect the work the task below names and report what falls short, most important first, with file and line where it applies. Do not change the work under review: no edits, commits or formatting in the checkout. Builds, renders or scratch files go outside it.",
    `Score the work from 0 to 10 for your lens, where ${formatCouncilScore(9)} means ready to ship. End your report with one final line exactly like: ${COUNCIL_SCORE_PREFIX} 7.5/10`,
    "</t3_code_council_reviewer>",
    "",
    task,
  ].join("\n");
}

/** The continue turn that brings a lead back when it stopped while Council still holds it. */
export function councilContinueText(status: CouncilStatus): string {
  const reason =
    status.state === "waiting"
      ? "This request changed work, but no Council round reviewed it yet. Convene round 1 before you finish."
      : councilStatusLine(status);
  return `Council is not satisfied yet. ${reason} If a blocker should not be fixed, end your turn and tell the user why.`;
}
