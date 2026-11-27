import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2TurnItem,
  PlanId,
} from "@t3tools/contracts";

export type ProposedPlanArtifact = Extract<
  OrchestrationV2PlanArtifact,
  { readonly kind: "proposed_plan" }
>;
type ProposedPlanTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "proposed_plan" }>;

export function findProposedPlan(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact> | undefined,
  planId: PlanId,
): ProposedPlanArtifact | undefined {
  const plan = plans?.find((candidate) => candidate.id === planId);
  return plan?.kind === "proposed_plan" ? plan : undefined;
}

/**
 * A proposed plan's body. History paging moves it onto the plan's turn item and empties it
 * outside the window, so null means it is not loaded here.
 */
export function resolvePlanMarkdown(
  planId: PlanId,
  plans: ReadonlyArray<OrchestrationV2PlanArtifact>,
  turnItems: ReadonlyArray<{ readonly type: string } | ProposedPlanTurnItem>,
): string | null {
  const plan = findProposedPlan(plans, planId);
  if (plan === undefined) return null;
  if (plan.markdown.trim()) return plan.markdown;
  const item = turnItems.find(
    (candidate): candidate is ProposedPlanTurnItem =>
      candidate.type === "proposed_plan" && "planId" in candidate && candidate.planId === planId,
  );
  return item?.markdown.trim() ? item.markdown : null;
}
