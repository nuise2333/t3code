import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2TurnItem,
  PlanId,
} from "@t3tools/contracts";
import { stripDisplayedPlanMarkdown, proposedPlanTitle } from "@t3tools/shared/proposedPlanText";

type ProposedPlanTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "proposed_plan" }>;

/**
 * The body of the plan a revision replaced. History paging moves a plan's body onto its turn
 * item and empties it outside the window, so null means it is not loaded here.
 */
export function resolvePlanMarkdown(
  planId: PlanId,
  plans: ReadonlyArray<OrchestrationV2PlanArtifact>,
  turnItems: ReadonlyArray<{ readonly type: string } | ProposedPlanTurnItem>,
): string | null {
  const plan = plans.find((candidate) => candidate.id === planId);
  if (plan?.kind !== "proposed_plan") return null;
  if (plan.markdown.trim()) return plan.markdown;
  const item = turnItems.find(
    (candidate): candidate is ProposedPlanTurnItem =>
      candidate.type === "proposed_plan" && "planId" in candidate && candidate.planId === planId,
  );
  return item?.markdown.trim() ? item.markdown : null;
}

export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: {
    maxLines?: number;
  },
): string {
  const maxLines = options?.maxLines ?? 8;
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const previewLines: string[] = [];
  let visibleLineCount = 0;
  let hasMoreContent = false;

  for (const line of lines) {
    const isVisibleLine = line.trim().length > 0;
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true;
      break;
    }
    previewLines.push(line);
    if (isVisibleLine) {
      visibleLineCount += 1;
    }
  }

  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop();
  }

  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
  }

  if (hasMoreContent) {
    previewLines.push("", "...");
  }

  return previewLines.join("\n");
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return `${sanitizePlanFileSegment(title ?? "plan")}.md`;
}

export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

export function downloadPlanAsTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
