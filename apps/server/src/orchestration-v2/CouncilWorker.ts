import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import {
  councilApplies,
  councilStatus,
  councilUserMessageTimes,
  type CouncilStatus,
} from "@t3tools/shared/council";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadAssists from "../assist/ThreadAssists.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const ACTIVE_RUN: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const LIVE_TASK: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

/**
 * The continue turn for a lead that just stopped while Council still holds it, or null. It comes
 * once per round and state: a lead that stops again in the same state is asking the user, and
 * the composer's Council strip shows that. A lead with tasks still out is woken by their results.
 */
export function councilContinuation(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly finishedRun: Pick<OrchestrationV2Run, "id" | "status" | "ordinal">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "ordinal">>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  /** Whether the finished run, or a member's task this cycle, changed the work. */
  readonly changed: (status: CouncilStatus) => boolean;
}): OrchestrationV2Command | null {
  const { thread } = input;
  const council = thread.council;
  if (!council || !councilApplies(thread) || thread.archivedAt !== null) return null;
  if (input.finishedRun.status !== "completed") return null;
  const newest = input.runs.reduce<number>((max, run) => Math.max(max, run.ordinal), 0);
  if (input.finishedRun.ordinal < newest) return null;
  if (input.runs.some((run) => ACTIVE_RUN.has(run.status))) return null;
  if (
    input.subagents.some(
      (task) =>
        task.threadId === thread.id && task.origin === "app_owned" && LIVE_TASK.has(task.status),
    )
  ) {
    return null;
  }
  const status = councilStatus({
    threadId: thread.id,
    council,
    subagents: input.subagents,
    userMessageTimesMs: councilUserMessageTimes(input.messages),
  });
  const due =
    status.state === "fixing" ||
    status.state === "dispatch" ||
    (status.state === "waiting" && input.changed(status));
  if (!due) return null;
  const key = `${thread.id}:${status.cycleStartMs}:${status.rounds.length}:${status.state}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`council-continue:${key}`),
    messageId: MessageId.make(`council-continue:${key}`),
    threadId: thread.id,
    text: ThreadAssists.councilContinueText(status),
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

const makeWorker = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const onRunSettled = Effect.fn("CouncilWorker.onRunSettled")(function* (
    finishedRun: OrchestrationV2Run,
  ) {
    const thread = yield* projections.getThread(finishedRun.threadId);
    if (!thread.council || !councilApplies(thread)) return;
    const records = yield* projections.getThreadRecords(thread.id, [
      "runs",
      "messages",
      "subagents",
    ]);
    const runChanged = yield* projections
      .getThreadRecords(thread.id, ["turnItems"], { turnItemRunId: finishedRun.id })
      .pipe(Effect.map(({ turnItems }) => turnItems.some((item) => item.type === "file_change")));
    const command = councilContinuation({
      thread,
      finishedRun,
      runs: records.runs,
      messages: records.messages,
      subagents: records.subagents,
      changed: (status) =>
        runChanged ||
        records.subagents.some(
          (task) =>
            task.threadId === thread.id &&
            task.origin === "app_owned" &&
            task.councilLens === undefined &&
            task.status === "completed" &&
            (task.startedAt === null ||
              DateTime.toEpochMillis(task.startedAt) >= status.cycleStartMs),
        ),
    });
    if (command === null) return;
    yield* threads.dispatch(command);
  });

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      event.type === "run.updated" && event.payload.status === "completed"
        ? onRunSettled(event.payload).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.council.continue-failed", {
                threadId: event.payload.threadId,
                cause,
              }),
            ),
          )
        : Effect.void,
    ),
  );
});

export const layer = Layer.effectDiscard(makeWorker);
