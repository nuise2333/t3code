import {
  buildPlanApprovalMessage,
  buildPlanRevisionMessage,
  type PlanReviewDraft,
} from "@t3tools/client-runtime/planReview";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { CommandId, MessageId, type PlanId, type ServerProvider } from "@t3tools/contracts";

import { makeQueuedMessageMetadata } from "../../../lib/commandMetadata";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { clearThreadComposerError } from "../../../state/thread-composer-error";
import { enqueueThreadOutboxMessage, type QueuedThreadMessage } from "../../../state/thread-outbox";
import {
  getComposerDraftSnapshot,
  updateComposerDraftSettings,
} from "../../../state/use-composer-drafts";

export type PlanReviewDecision = "approve" | "revise";
export type PlanReviewRefusal = "no-feedback" | "plan-mode-unsupported";

interface PlanReviewSubmission {
  readonly thread: Pick<
    EnvironmentThreadShell,
    "environmentId" | "id" | "modelSelection" | "runtimeMode"
  >;
  readonly planId: PlanId;
  readonly planMarkdown: string;
  readonly draft: PlanReviewDraft;
  readonly decision: PlanReviewDecision;
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "showInteractionModeToggle">
  >;
}

/**
 * The message that answers a proposed plan. Sending it back keeps the thread in plan mode and
 * carries the reviewer's notes; approving returns to the default mode and links the turn to the
 * plan, which marks it implemented. A plan is not sent back without feedback, nor to a model
 * without plan mode: the outbox would run it in the default mode, implementing what it should revise.
 */
export function planReviewOutboxMessage(
  input: PlanReviewSubmission & {
    readonly settings: Pick<QueuedThreadMessage, "modelSelection" | "runtimeMode">;
    readonly metadata: ReturnType<typeof makeQueuedMessageMetadata>;
  },
): QueuedThreadMessage | PlanReviewRefusal {
  const threadId = input.thread.id;
  const approved = input.decision === "approve";
  const text = approved
    ? buildPlanApprovalMessage(input.planMarkdown, input.draft)
    : buildPlanRevisionMessage(input.draft);
  if (text === null) return "no-feedback";
  const modelSelection = input.settings.modelSelection ?? input.thread.modelSelection;
  const provider = input.providers.find((entry) => entry.instanceId === modelSelection.instanceId);
  if (!approved && provider?.showInteractionModeToggle !== true) return "plan-mode-unsupported";
  return {
    environmentId: input.thread.environmentId,
    threadId,
    messageId: MessageId.make(input.metadata.messageId),
    commandId: CommandId.make(input.metadata.commandId),
    text,
    attachments: [],
    modelSelection,
    runtimeMode: input.settings.runtimeMode ?? input.thread.runtimeMode,
    interactionMode: approved ? "default" : "plan",
    ...(approved ? { sourceProposedPlan: { threadId, planId: input.planId } } : {}),
    createdAt: input.metadata.createdAt,
  };
}

/** Queues the answer on the thread's outbox; resolves why when it was not sent. */
export async function sendPlanReview(
  input: PlanReviewSubmission,
): Promise<PlanReviewRefusal | null> {
  const threadKey = scopedThreadKey(input.thread.environmentId, input.thread.id);
  const message = planReviewOutboxMessage({
    ...input,
    settings: getComposerDraftSnapshot(threadKey),
    metadata: makeQueuedMessageMetadata(),
  });
  if (typeof message === "string") return message;
  clearThreadComposerError(threadKey);
  await enqueueThreadOutboxMessage(message);
  // The composer's own mode follows, so the next ordinary message keeps what was decided.
  if (message.interactionMode !== undefined) {
    updateComposerDraftSettings(threadKey, { interactionMode: message.interactionMode });
  }
  return null;
}
