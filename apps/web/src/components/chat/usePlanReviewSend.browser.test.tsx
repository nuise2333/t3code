import { EnvironmentId, PlanId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  turns: [] as unknown[],
  fail: false,
}));

vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() => async (value: { readonly input: unknown }) => {
    state.turns.push(value.input);
    return state.fail
      ? AsyncResult.failure(Cause.fail(new Error("offline")))
      : AsyncResult.success(undefined);
  }) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { ChatMessage } from "../../types";
import { usePlanReviewSend, type PlanReviewSubmission } from "./usePlanReviewSend";

const environmentId = EnvironmentId.make("environment:test");
const threadId = ThreadId.make("thread:plan");
const planId = PlanId.make("plan-1");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
const draft = {
  annotations: [{ id: "a", action: "delete" as const, quote: "Use Redis" }],
  general: "",
};

function setup(options: { fail?: boolean } = {}) {
  state.turns = [];
  state.fail = options.fail === true;
  const persisted = vi.fn(async () => AsyncResult.success(undefined));
  return { persisted };
}

function Review(props: {
  readonly submission: PlanReviewSubmission;
  readonly persisted: ReturnType<typeof setup>["persisted"];
  readonly planModeAvailable?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [outcome, setOutcome] = useState("");
  const send = usePlanReviewSend({
    environmentId,
    routeThreadKey: "environment:test:thread:plan",
    activeThread: { id: threadId, environmentId } as never,
    isServerThread: true,
    blocked: false,
    planModeAvailable: props.planModeAvailable ?? true,
    composerRef: {
      current: {
        getSendContext: () => ({
          providerAvailable: true,
          selectedModelSelection: modelSelection,
          selectedProviderModels: [],
        }),
      } as never,
    },
    runtimeMode: "full-access",
    localCheckoutBranchMismatch: null,
    beginLocalDispatch: () => undefined,
    resetLocalDispatch: () => undefined,
    setOptimisticUserMessages: setMessages,
    setThreadError: () => undefined,
    anchorNewTurn: () => undefined,
    persistThreadSettingsForNextTurn: props.persisted,
  });
  return (
    <>
      <button
        type="button"
        onClick={() => void send(props.submission).then((error) => setOutcome(error ?? "sent"))}
      >
        Decide
      </button>
      <output>{`${outcome}:${messages.length}`}</output>
    </>
  );
}

it.each([
  {
    decision: "approve" as const,
    mode: "default",
    turn: { sourceProposedPlan: { threadId, planId } },
    text: /^PLEASE IMPLEMENT THIS PLAN:\n# Plan\n\nREVIEWER NOTES[^\n]+\n\n## 1\. Remove\n> Use Redis\n/,
  },
  {
    decision: "revise" as const,
    mode: "plan",
    turn: {},
    text: /^YOUR PLAN WAS NOT APPROVED\.[^\n]+\n\n## 1\. Remove\n> Use Redis\n/,
  },
])("answers a plan with $decision in $mode mode", async ({ decision, mode, turn, text }) => {
  const { persisted } = setup();
  await using _screen = await render(
    <Review
      submission={{ planId, planMarkdown: "# Plan", draft, decision }}
      persisted={persisted}
    />,
  );
  await page.getByRole("button", { name: "Decide" }).click();

  await expect.element(page.getByRole("status")).toHaveTextContent("sent:1");
  expect(persisted).toHaveBeenCalledWith(expect.objectContaining({ interactionMode: mode }));
  expect(state.turns).toEqual([
    expect.objectContaining({
      threadId,
      interactionMode: mode,
      modelSelection,
      message: expect.objectContaining({ text: expect.stringMatching(text) }),
    }),
  ]);
  // An older server drops a context kind it does not know, so the notes travel as text alone.
  expect((state.turns[0] as { message: object }).message).not.toHaveProperty("context");
  expect("sourceProposedPlan" in (state.turns[0] as object)).toBe("sourceProposedPlan" in turn);
  expect(state.turns[0]).toMatchObject(turn);
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(environmentId, threadId))
      ?.interactionMode,
  ).toBe(mode);
});

it("reports why a review was not sent and takes its message back", async () => {
  const { persisted } = setup({ fail: true });
  await using _screen = await render(
    <Review
      submission={{ planId, planMarkdown: "# Plan", draft, decision: "revise" }}
      persisted={persisted}
    />,
  );
  await page.getByRole("button", { name: "Decide" }).click();

  await expect.element(page.getByRole("status")).toHaveTextContent("offline:0");
});

it("does not send a plan back to a model without plan mode, and still approves on it", async () => {
  const { persisted } = setup();
  await using screen = await render(
    <Review
      submission={{ planId, planMarkdown: "# Plan", draft, decision: "revise" }}
      persisted={persisted}
      planModeAvailable={false}
    />,
  );
  await page.getByRole("button", { name: "Decide" }).click();

  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent(
      "The current model does not support plan mode, so the plan cannot be sent back.:0",
    );
  expect(state.turns).toEqual([]);

  await screen.rerender(
    <Review
      submission={{ planId, planMarkdown: "# Plan", draft, decision: "approve" }}
      persisted={persisted}
      planModeAvailable={false}
    />,
  );
  await page.getByRole("button", { name: "Decide" }).click();

  await expect.element(page.getByRole("status")).toHaveTextContent("sent:1");
  expect(state.turns).toEqual([expect.objectContaining({ interactionMode: "default" })]);
});
