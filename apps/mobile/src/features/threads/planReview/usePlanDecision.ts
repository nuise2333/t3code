import type { PlanReviewDraft } from "@t3tools/client-runtime/planReview";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import {
  AuthOrchestrationOperateScope,
  type PlanId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";

import * as Dialog from "../../../components/ui/Dialog";
import { useGT } from "../../../i18n/I18nProvider";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { useEnvironmentServerConfig } from "../../../state/entities";
import { useEnvironmentScope } from "../../../state/session";
import { useRemoteEnvironmentRuntime } from "../../../state/use-remote-environment-registry";
import { useQuietThreadStructure } from "../../../state/use-thread-detail";
import { useThreadOutboxMessages } from "../../../state/use-thread-outbox";
import { clearPlanReviewDraft, planReviewDraftKey } from "./planReviewDrafts";
import { sendPlanReview, type PlanReviewDecision } from "./sendPlanReview";

/** Answers a proposed plan on its thread, and says why it cannot be answered right now. */
export function usePlanDecision(ref: ScopedThreadRef) {
  const gt = useGT();
  const structure = useQuietThreadStructure(ref);
  const connected = useRemoteEnvironmentRuntime(ref.environmentId)?.connectionState === "connected";
  const canOperate = useEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope);
  const [sending, setSending] = useState<PlanReviewDecision | null>(null);
  const providers = useEnvironmentServerConfig(ref.environmentId)?.providers;
  const thread = structure?.projection.thread;
  const threadKey = scopedThreadKey(ref.environmentId, ref.threadId);
  // An answer still on its way out would otherwise be sent a second time.
  const queued = (useThreadOutboxMessages()[threadKey]?.length ?? 0) > 0;
  const blockedReason = !connected
    ? gt("Not connected. Decide once the environment is back.")
    : structure && threadRuntimeIsActive(deriveThreadStructureRuntime(structure.projection))
      ? gt("The agent is still working. Decide once it stops.")
      : !canOperate || thread === undefined || queued
        ? gt("This thread cannot take a message right now. Try again in a moment.")
        : null;

  /** Resolves true once the answer is queued on the thread. */
  const decide = async (input: {
    readonly planId: PlanId;
    readonly planMarkdown: string;
    readonly draft: PlanReviewDraft;
    readonly decision: PlanReviewDecision;
  }): Promise<boolean> => {
    if (sending !== null) return false;
    let failure = blockedReason;
    if (failure === null && input.decision === "revise" && providers === undefined) {
      failure = gt("This thread cannot take a message right now. Try again in a moment.");
    }
    if (failure === null && thread !== undefined) {
      setSending(input.decision);
      try {
        const refusal = await sendPlanReview({
          ...input,
          providers: providers ?? [],
          thread: { ...thread, environmentId: ref.environmentId },
        });
        if (refusal === "no-feedback") failure = gt("Add an annotation or overall feedback first.");
        if (refusal === "plan-mode-unsupported") {
          failure = gt(
            "The current model does not support plan mode, so the plan cannot be sent back.",
          );
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : gt("The plan review could not be sent.");
      }
      setSending(null);
    }
    if (failure === null) {
      // A queued approval can still fail to go out; its notes stay for approving again.
      if (input.decision === "revise") {
        clearPlanReviewDraft(planReviewDraftKey(threadKey, input.planId), input.draft);
      }
      return true;
    }
    Dialog.alert(
      input.decision === "approve"
        ? gt("The plan was not approved")
        : gt("The plan was not sent back"),
      failure,
    );
    return false;
  };

  return { structure, blockedReason, sending, decide };
}
