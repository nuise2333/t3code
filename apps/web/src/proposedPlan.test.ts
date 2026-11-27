import { NodeId, PlanId, ThreadId, type OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { resolvePlanMarkdown } from "./proposedPlan";

const previousPlanId = PlanId.make("plan-1");
const artifact = (markdown: string): OrchestrationV2PlanArtifact => ({
  id: previousPlanId,
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: NodeId.make("node"),
  kind: "proposed_plan",
  status: "superseded",
  markdown,
});
const planItem = { type: "proposed_plan", planId: previousPlanId, markdown: "# From the item" };

it.each([
  {
    name: "the artifact's own body",
    plans: [artifact("# Kept")],
    items: [planItem],
    body: "# Kept",
  },
  {
    name: "the turn item when paging moved the body there",
    plans: [{ ...artifact(""), detailInTurnItem: true as const }],
    items: [{ type: "assistant_message" }, planItem],
    body: "# From the item",
  },
  {
    name: "nothing when the body is outside the window",
    plans: [artifact("")],
    items: [],
    body: null,
  },
  { name: "nothing for a plan the thread does not have", plans: [], items: [planItem], body: null },
])("reads a previous revision from $name", ({ plans, items, body }) => {
  expect(resolvePlanMarkdown(previousPlanId, plans, items as never)).toBe(body);
});
