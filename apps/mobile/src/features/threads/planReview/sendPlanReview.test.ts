import {
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  PLAN_REVISION_PROMPT,
  type PlanReviewDraft,
} from "@t3tools/client-runtime/planReview";
import { EnvironmentId, PlanId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../lib/commandMetadata", () => ({ makeQueuedMessageMetadata: vi.fn() }));
vi.mock("../../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: vi.fn() }));
vi.mock("../../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  updateComposerDraftSettings: vi.fn(),
}));

import { planReviewOutboxMessage } from "./sendPlanReview";

const threadId = ThreadId.make("thread");
const planId = PlanId.make("plan");
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const base = {
  thread: {
    environmentId: EnvironmentId.make("env"),
    id: threadId,
    modelSelection: codex,
    runtimeMode: "full-access",
  },
  planId,
  planMarkdown: "# Plan\n\n- Step 1\n",
  settings: {},
  providers: [{ instanceId: codex.instanceId, showInteractionModeToggle: true, models: [] }],
  metadata: { messageId: "m", commandId: "c", createdAt: "2026-11-27T00:00:00.000Z" },
} as const;
const notes: PlanReviewDraft = {
  annotations: [{ id: "a", action: "delete", quote: "Step 1", line: 3 }],
  general: "",
};

describe("planReviewOutboxMessage", () => {
  it("approves in the default mode, linked to the plan, with the plan as the prompt", () => {
    const message = planReviewOutboxMessage({
      ...base,
      decision: "approve",
      draft: { annotations: [], general: "" },
    });
    expect(message).toMatchObject({
      interactionMode: "default",
      sourceProposedPlan: { threadId, planId },
      text: `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan\n\n- Step 1`,
      modelSelection: codex,
      runtimeMode: "full-access",
    });
    expect(message).not.toHaveProperty("context");
  });

  it("carries the reviewer's notes with an approval", () => {
    const message = planReviewOutboxMessage({ ...base, decision: "approve", draft: notes });
    expect(message).toMatchObject({
      text: expect.stringMatching(/REVIEWER NOTES[^\n]+\n\n## 1\. Remove \(line 3\)\n> Step 1\n/),
    });
    expect(message).not.toHaveProperty("context");
  });

  it("sends a plan back in plan mode with its notes, and not linked as implemented", () => {
    const message = planReviewOutboxMessage({
      ...base,
      decision: "revise",
      draft: notes,
      settings: { runtimeMode: "approval-required" },
    });
    expect(message).toMatchObject({
      interactionMode: "plan",
      runtimeMode: "approval-required",
      text: `${PLAN_REVISION_PROMPT}\n\n## 1. Remove (line 3)\n> Step 1\n\nThe user wants this part left out.`,
    });
    expect(message).not.toHaveProperty("context");
    expect(message).not.toHaveProperty("sourceProposedPlan");
  });

  it.each([
    {
      provider: "without plan mode",
      providers: [{ ...base.providers[0], showInteractionModeToggle: false }],
    },
    { provider: "that is not known", providers: [] },
  ])(
    "does not send a plan back to a model $provider, and still approves on it",
    ({ providers }) => {
      const input = { ...base, draft: notes, providers };

      expect(planReviewOutboxMessage({ ...input, decision: "revise" })).toBe(
        "plan-mode-unsupported",
      );
      expect(planReviewOutboxMessage({ ...input, decision: "approve" })).toMatchObject({
        interactionMode: "default",
        sourceProposedPlan: { threadId, planId },
      });
    },
  );

  it("has nothing to send back without feedback", () => {
    expect(
      planReviewOutboxMessage({
        ...base,
        decision: "revise",
        draft: { annotations: [], general: "  " },
      }),
    ).toBe("no-feedback");
  });
});
