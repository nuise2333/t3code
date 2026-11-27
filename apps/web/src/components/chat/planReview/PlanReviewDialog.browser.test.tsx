import { buildPlanRevisionMessage, type PlanReviewDraft } from "@t3tools/client-runtime/planReview";
import { EnvironmentId, PlanId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import "../../../index.css";
import { planReviewDraftKey, usePlanReviewDraftStore } from "../../../planReviewDraftStore";
import { PlanReviewDialog, type PlanReviewTarget } from "./PlanReviewDialog";

// The review is about the text, not Markdown rendering, whose module graph loads Shiki.
vi.mock("../../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => (
    <div>
      {text.split("\n").map((line) => (
        <p key={line}>{line.replace(/^[#\-\d. ]+/, "")}</p>
      ))}
    </div>
  ),
}));

const threadRef = scopeThreadRef(EnvironmentId.make("environment:test"), ThreadId.make("thread"));
const plan: PlanReviewTarget = {
  id: PlanId.make("plan-2"),
  markdown: "# Queue rollout\n1. Use Redis for the queue\n2. Sync nightly\n3. Use Redis for locks",
  revision: 2,
  previousPlanId: PlanId.make("plan-1"),
};
const previousMarkdown = "# Queue rollout\n1. Use Redis for the queue\n2. Sync weekly";

/** Selects the nth `text` in the plan the way a drag does: press, select, release. */
function selectPlanText(text: string, occurrence = 0) {
  const root = document.querySelector<HTMLElement>("[data-testid=plan-review-document]")!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.nodeValue?.indexOf(text) ?? -1;
    if (index === -1 || seen++ < occurrence) continue;
    node.parentElement!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
    );
    window.getSelection()!.setBaseAndExtent(node, index, node, index + text.length);
    window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    return;
  }
  throw new Error(`"${text}" is not in the plan`);
}

function setup() {
  usePlanReviewDraftStore.setState({ drafts: {} });
  const onDecide = vi.fn(async (_decision: "approve" | "revise", _draft: PlanReviewDraft) => {});
  const dialog = (
    <PlanReviewDialog
      plan={plan}
      previousMarkdown={previousMarkdown}
      threadRef={threadRef}
      cwd={undefined}
      blockedReason={null}
      onDecide={onDecide}
      onClose={() => {}}
    />
  );
  return { onDecide, dialog };
}

it("annotates selected plan text and sends the notes back", async () => {
  const { onDecide, dialog } = setup();
  await using _screen = await render(dialog);
  const requestChanges = page.getByRole("button", { name: "Request changes" });
  await expect.element(requestChanges).toBeDisabled();

  selectPlanText("Use Redis", 1);
  await userEvent.click(page.getByRole("toolbar").getByRole("button", { name: "Delete" }));
  await expect.element(page.getByText("Line 4")).toBeVisible();
  expect(CSS.highlights.has("t3-plan-review-focus")).toBe(true);

  selectPlanText("nightly");
  await userEvent.click(page.getByRole("toolbar").getByRole("button", { name: "Replace" }));
  const save = page.getByRole("button", { name: "Save" });
  await expect.element(save).toBeDisabled();
  await userEvent.type(page.getByLabelText("Replace with"), "hourly");
  await userEvent.click(save);
  await expect.element(page.getByText("Replace with: hourly")).toBeVisible();
  expect(CSS.highlights.has("t3-plan-review-delete")).toBe(true);

  await userEvent.click(page.getByRole("button", { name: "Edit annotation" }).last());
  await userEvent.type(page.getByLabelText("Replace with"), " sharp");
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  await expect.element(page.getByText("Replace with: hourly")).toBeVisible();

  await userEvent.click(requestChanges);
  expect(onDecide).toHaveBeenCalledWith(
    "revise",
    expect.objectContaining({
      general: "",
      annotations: [
        expect.objectContaining({
          action: "delete",
          quote: "Use Redis",
          line: 4,
          anchor: { text: "Use Redis", occurrence: 1 },
        }),
        expect.objectContaining({
          action: "replace",
          quote: "nightly",
          line: 3,
          replacement: "hourly",
        }),
      ],
    }),
  );
  expect(
    usePlanReviewDraftStore.getState().drafts[planReviewDraftKey(threadRef, plan.id)]?.annotations,
  ).toHaveLength(2);
});

it("sends a note that was typed but never saved, and sends it once", async () => {
  const { onDecide, dialog } = setup();
  let finishSending = () => {};
  onDecide.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishSending = resolve;
    }),
  );
  await using _screen = await render(dialog);
  const requestChanges = page.getByRole("button", { name: "Request changes" });

  selectPlanText("nightly");
  await userEvent.click(page.getByRole("toolbar").getByRole("button", { name: "Replace" }));
  await userEvent.type(page.getByLabelText("Replace with"), "hourly");
  await userEvent.click(requestChanges);

  await expect.element(requestChanges).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Approve and implement" })).toBeDisabled();
  expect(buildPlanRevisionMessage(onDecide.mock.calls[0]![1])).toContain(
    "## 1. Replace (line 3)\n> nightly\n\nReplace with:\nhourly",
  );
  finishSending();
});

it("drops a note left without its text and compares with the previous revision", async () => {
  const { dialog } = setup();
  await using _screen = await render(dialog);

  selectPlanText("nightly");
  await userEvent.click(page.getByRole("toolbar").getByRole("button", { name: "Comment" }));
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));
  await expect.element(page.getByText("Annotations (0)")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Compare with previous" }));
  await expect.element(page.getByText("2 lines added, 1 removed")).toBeVisible();
  expect(
    Array.from(document.querySelectorAll("[data-diff-line=added]"), (line) => line.textContent),
  ).toEqual(["3+2. Sync nightly", "4+3. Use Redis for locks"]);
});
