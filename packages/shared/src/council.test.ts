import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type ThreadCouncil,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { councilStatus, councilUserMessageTimes, parseCouncilScore } from "./council.ts";

const threadId = ThreadId.make("thread:lead");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 17, 9, minute));
const council: ThreadCouncil = {
  target: 9,
  maxRounds: 3,
  reviewers: "auto",
  since: DateTime.toEpochMillis(at(0)),
};

let next = 0;
function seat(
  lens: string,
  startedMinute: number,
  outcome: {
    readonly score?: number;
    readonly endedMinute?: number;
    readonly status?: OrchestrationV2Subagent["status"];
  },
): OrchestrationV2Subagent {
  next += 1;
  const ended = outcome.endedMinute ?? null;
  return {
    id: NodeId.make(`node:${next}`),
    threadId,
    runId: null,
    parentNodeId: NodeId.make("node:root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make(`thread:${next}`),
    nativeTaskRef: null,
    prompt: "Review",
    title: null,
    model: "gpt",
    councilLens: lens,
    status: outcome.status ?? (ended === null ? "running" : "completed"),
    result:
      outcome.score === undefined
        ? "Looks fine."
        : `Findings.\n\n**Council score: ${outcome.score}/10**`,
    startedAt: at(startedMinute),
    completedAt: ended === null ? null : at(ended),
    updatedAt: at(ended ?? startedMinute),
  };
}

const status = (subagents: ReadonlyArray<OrchestrationV2Subagent>, userMinutes: number[] = []) =>
  councilStatus({
    threadId,
    council,
    subagents,
    userMessageTimesMs: userMinutes.map((minute) => DateTime.toEpochMillis(at(minute))),
  });

describe("parseCouncilScore", () => {
  it("reads the last score line, past markdown, and nothing out of range", () => {
    expect(parseCouncilScore("Council score: 3/10\nmore\n> **Council score: 8.5 / 10**")).toBe(8.5);
    expect(parseCouncilScore("## Council score: 9")).toBe(9);
    expect(parseCouncilScore("Council score: 11/10")).toBeNull();
    expect(parseCouncilScore("Council score: high")).toBeNull();
    expect(parseCouncilScore("No score here")).toBeNull();
  });
});

describe("councilStatus", () => {
  it("groups parallel reviewers into a round and opens the next once they all settled", () => {
    const result = status([
      seat("correctness", 1, { score: 7, endedMinute: 5 }),
      seat("tests", 2, { score: 9.5, endedMinute: 6 }),
      seat("correctness", 10, { score: 9, endedMinute: 12 }),
      seat("tests", 10, {}),
    ]);
    expect(result.rounds.map((round) => round.seats.length)).toEqual([2, 2]);
    expect(result.state).toBe("reviewing");
    expect(result.lowest).toBe(9);
    expect(result.lenses).toEqual([
      { lens: "correctness", first: 7, latest: 9 },
      { lens: "tests", first: 9.5, latest: null },
    ]);
  });

  it("passes at the target, asks for fixes below it and stops at the round limit", () => {
    expect(
      status([
        seat("a", 1, { score: 9, endedMinute: 2 }),
        seat("b", 1, { score: 9.5, endedMinute: 2 }),
      ]).state,
    ).toBe("passed");
    expect(
      status([
        seat("a", 1, { score: 7, endedMinute: 2 }),
        seat("b", 1, { score: 9.5, endedMinute: 2 }),
      ]).state,
    ).toBe("fixing");
    const limited = [3, 6, 9].flatMap((minute) => [
      seat("a", minute, { score: 7, endedMinute: minute + 1 }),
      seat("b", minute, { score: 9, endedMinute: minute + 1 }),
    ]);
    expect(status(limited).state).toBe("limit");
  });

  it("needs enough scores: an unscored or stopped reviewer leaves the round to seat again", () => {
    expect(
      status([seat("a", 1, { score: 9.5, endedMinute: 2 }), seat("b", 1, { endedMinute: 2 })])
        .state,
    ).toBe("dispatch");
    expect(
      status([
        seat("a", 1, { score: 9.5, endedMinute: 2 }),
        seat("b", 1, { endedMinute: 2, status: "failed" }),
      ]).state,
    ).toBe("dispatch");
  });

  it("starts a new cycle on a user message only once the old one has nothing outstanding", () => {
    const fixing = [
      seat("a", 1, { score: 7, endedMinute: 2 }),
      seat("b", 1, { score: 9, endedMinute: 2 }),
    ];
    // "Keep going" while fixing continues the same rounds.
    expect(status(fixing, [5]).rounds).toHaveLength(1);
    const passed = [
      seat("a", 1, { score: 9, endedMinute: 2 }),
      seat("b", 1, { score: 9, endedMinute: 2 }),
    ];
    // A new request after a pass reviews only what comes next.
    const fresh = status(passed, [5]);
    expect(fresh.state).toBe("waiting");
    expect(fresh.cycleStartMs).toBe(DateTime.toEpochMillis(at(5)));
  });

  it("is accepted for the cycle the user accepted", () => {
    const below = [
      seat("a", 1, { score: 7, endedMinute: 2 }),
      seat("b", 1, { score: 8, endedMinute: 2 }),
    ];
    expect(
      councilStatus({
        threadId,
        council: { ...council, acceptedAt: DateTime.toEpochMillis(at(3)) },
        subagents: below,
        userMessageTimesMs: [],
      }).state,
    ).toBe("accepted");
  });
});

describe("councilUserMessageTimes", () => {
  it("counts only what the user wrote", () => {
    const message = (createdBy: string, extra: Record<string, unknown> = {}) => ({
      role: "user",
      createdBy,
      createdAt: at(1),
      ...extra,
    });
    expect(
      councilUserMessageTimes([
        message("user"),
        message("agent"),
        message("user", { senderThreadId: "thread:parent" }),
        message("user", { delegatedCompletion: {} }),
      ]),
    ).toHaveLength(1);
  });
});
