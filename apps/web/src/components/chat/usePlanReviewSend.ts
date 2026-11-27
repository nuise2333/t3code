import {
  buildPlanApprovalMessage,
  buildPlanRevisionMessage,
  type PlanReviewDraft,
} from "@t3tools/client-runtime/planReview";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type PlanId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import type { Dispatch, SetStateAction } from "react";
import { newMessageId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ChatMessage } from "../../types";
import { formatOutgoingPrompt, type makeThreadErrorSetter } from "../ChatView.logic";
import { draftSendState } from "./chatViewSend";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import type { useTimelineFollow } from "./useTimelineFollow";

type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;

export interface PlanReviewSubmission {
  readonly planId: PlanId;
  readonly planMarkdown: string;
  readonly draft: PlanReviewDraft;
  readonly decision: "approve" | "revise";
}

interface PlanReviewSendInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadKey: string;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly isServerThread: boolean;
  readonly blocked: boolean;
  /** Whether the model the answer goes to offers plan mode. */
  readonly planModeAvailable: boolean;
  readonly composerRef: ComposerHandleRef;
  readonly runtimeMode: RuntimeMode;
  readonly localCheckoutBranchMismatch: { readonly currentBranch: string } | null;
  readonly beginLocalDispatch: LocalDispatchState["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchState["resetLocalDispatch"];
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly anchorNewTurn: ReturnType<typeof useTimelineFollow>["anchorNewTurn"];
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: EnvironmentThreadShell["id"];
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}

/**
 * Answers a proposed plan on its thread. Sending it back keeps the thread in plan mode and
 * carries the reviewer's notes; approving returns to the default mode and links the turn to
 * the plan, which marks it implemented. Resolves null once the turn started, or why it did not.
 */
export function usePlanReviewSend(input: PlanReviewSendInput) {
  const {
    environmentId,
    routeThreadKey,
    activeThread,
    isServerThread,
    blocked,
    planModeAvailable,
    composerRef,
    runtimeMode,
    localCheckoutBranchMismatch,
    beginLocalDispatch,
    resetLocalDispatch,
    setOptimisticUserMessages,
    setThreadError,
    anchorNewTurn,
    persistThreadSettingsForNextTurn,
  } = input;
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const gt = useGT();
  const { sendInFlight: sendInFlightRef } = draftSendState(routeThreadKey);

  return async function sendPlanReview(review: PlanReviewSubmission): Promise<string | null> {
    const sendCtx = composerRef.current?.getSendContext();
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      !activeThread ||
      !isServerThread ||
      blocked ||
      sendInFlightRef.current ||
      !sendCtx?.providerAvailable
    ) {
      return gt("This thread cannot take a message right now. Try again in a moment.");
    }
    // Outside plan mode the agent would start on the plan it was asked to revise.
    if (review.decision === "revise" && !planModeAvailable) {
      return gt("The current model does not support plan mode, so the plan cannot be sent back.");
    }
    const threadId = activeThread.id;
    const message =
      review.decision === "approve"
        ? buildPlanApprovalMessage(review.planMarkdown, review.draft)
        : buildPlanRevisionMessage(review.draft);
    if (message === null) return gt("Add an annotation or overall feedback first.");

    const interactionMode = review.decision === "approve" ? "default" : "plan";
    const messageId = newMessageId();
    const createdAt = new Date().toISOString();
    const text = formatOutgoingPrompt({
      provider: sendCtx.selectedProvider,
      model: sendCtx.selectedModel,
      models: sendCtx.selectedProviderModels,
      effort: sendCtx.selectedPromptEffort,
      text: message,
    });

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    setThreadError(threadId, null);
    anchorNewTurn(scopedThreadKey(scopeThreadRef(activeThread.environmentId, threadId)), messageId);
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageId,
        role: "user",
        text,
        runId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    ]);

    const threadRef = scopeThreadRef(activeThread.environmentId, threadId);
    const settingsResult = await persistThreadSettingsForNextTurn({
      threadId,
      createdAt,
      ...(localCheckoutBranchMismatch ? { branch: localCheckoutBranchMismatch.currentBranch } : {}),
      runtimeMode,
      interactionMode,
    });
    const result: AtomCommandResult<unknown, unknown> =
      settingsResult._tag === "Failure"
        ? settingsResult
        : await startThreadTurn({
            environmentId,
            input: {
              threadId,
              message: { messageId, role: "user", text, attachments: [] },
              modelSelection: sendCtx.selectedModelSelection,
              runtimeMode,
              interactionMode,
              ...(review.decision === "approve"
                ? { sourceProposedPlan: { threadId, planId: review.planId } }
                : {}),
              createdAt,
            },
          });

    sendInFlightRef.current = false;
    resetLocalDispatch();
    if (result._tag !== "Failure") {
      // The composer's own mode follows, so the next ordinary message keeps what was decided.
      useComposerDraftStore.getState().setInteractionMode(threadRef, interactionMode);
      return null;
    }
    setOptimisticUserMessages((existing) => existing.filter((entry) => entry.id !== messageId));
    const error = isAtomCommandInterrupted(result) ? null : squashAtomCommandFailure(result);
    return error instanceof Error ? error.message : gt("The plan review could not be sent.");
  };
}
