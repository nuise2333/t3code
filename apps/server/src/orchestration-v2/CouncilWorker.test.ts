import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { councilContinuation } from "./CouncilWorker.ts";

const threadId = ThreadId.make("thread:council-lead");
const instanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 17, 9, minute));

const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:council"),
  title: "Council lead",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: at(0),
  updatedAt: at(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  council: { target: 9, maxRounds: 3, reviewers: "auto", since: DateTime.toEpochMillis(at(0)) },
};

const run = (ordinal: number, status: OrchestrationV2Run["status"] = "completed") => ({
  id: RunId.make(`run:${ordinal}`),
  ordinal,
  status,
});

let seats = 0;
const reviewer = (
  score: number | null,
  status: OrchestrationV2Subagent["status"] = "completed",
): OrchestrationV2Subagent => {
  seats += 1;
  return {
    id: NodeId.make(`node:seat-${seats}`),
    threadId,
    runId: null,
    parentNodeId: NodeId.make("node:root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: instanceId,
    providerThreadId: null,
    childThreadId: ThreadId.make(`thread:seat-${seats}`),
    nativeTaskRef: null,
    prompt: "Review",
    title: null,
    model: "gpt",
    councilLens: `lens ${seats}`,
    status,
    result: score === null ? "Done." : `Council score: ${score}/10`,
    startedAt: at(1),
    completedAt: status === "completed" ? at(2) : null,
    updatedAt: at(2),
  };
};

const continuation = (input: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly runs?: ReadonlyArray<ReturnType<typeof run>>;
  readonly changed?: boolean;
  readonly thread?: OrchestrationV2AppThread;
}) =>
  councilContinuation({
    thread: input.thread ?? thread,
    finishedRun: run(1),
    runs: input.runs ?? [run(1)],
    messages: [],
    subagents: input.subagents,
    changed: () => input.changed ?? false,
  });

describe("councilContinuation", () => {
  it("brings the lead back once per round while scores are below the target", () => {
    const command = continuation({ subagents: [reviewer(7), reviewer(9.5)] });
    assert.equal(command?.type, "message.dispatch");
    if (command?.type !== "message.dispatch") return;
    assert.include(command.text, "below the target 9.0");
    assert.include(String(command.commandId), ":1:fixing");
    assert.equal(command.createdBy, "agent");
  });

  it("asks for a round when the work changed before any review", () => {
    assert.isNull(continuation({ subagents: [] }));
    const command = continuation({ subagents: [], changed: true });
    assert.equal(command?.type, "message.dispatch");
    if (command?.type === "message.dispatch") assert.include(command.text, "Convene round 1");
  });

  it("leaves a passed, limited or accepted cycle, and a lead with work still out", () => {
    assert.isNull(continuation({ subagents: [reviewer(9), reviewer(9.5)] }));
    assert.isNull(continuation({ subagents: [reviewer(7), reviewer(9.5, "running")] }));
    assert.isNull(
      continuation({ subagents: [reviewer(7), reviewer(9)], runs: [run(1), run(2, "queued")] }),
    );
    assert.isNull(
      continuation({
        subagents: [reviewer(7), reviewer(9)],
        thread: {
          ...thread,
          council: { ...thread.council!, acceptedAt: DateTime.toEpochMillis(at(3)) },
        },
      }),
    );
  });

  it("never runs for a thread without Council or for a delegated task", () => {
    assert.isNull(
      continuation({ subagents: [reviewer(7), reviewer(9)], thread: { ...thread, council: null } }),
    );
    assert.isNull(
      continuation({
        subagents: [reviewer(7), reviewer(9)],
        thread: {
          ...thread,
          lineage: { ...thread.lineage, relationshipToParent: "subagent" },
        },
      }),
    );
  });
});
