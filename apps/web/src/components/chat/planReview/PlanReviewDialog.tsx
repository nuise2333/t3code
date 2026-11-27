import {
  hasPlanReviewFeedback,
  countPlanReviewNotes,
  type PlanAnnotationDraft,
  type PlanReviewDraft,
} from "@t3tools/client-runtime/planReview";
import type { PlanId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { revealPlanAnchor, type PlanTextSelection } from "~/lib/planReviewDom";
import { randomUUID } from "~/lib/utils";
import {
  planReviewDraftKey,
  usePlanReviewDraft,
  usePlanReviewDraftStore,
} from "~/planReviewDraftStore";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Spinner } from "../../ui/spinner";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { PlanDiffView } from "./PlanDiffView";
import { PlanReviewDocument } from "./PlanReviewDocument";
import { PlanReviewNotes } from "./PlanReviewNotes";

export interface PlanReviewTarget {
  readonly id: PlanId;
  readonly markdown: string;
  readonly revision?: number | undefined;
  readonly previousPlanId?: PlanId | undefined;
}

type PlanReviewDecision = "approve" | "revise";

function PlanReviewBody({
  plan,
  previousMarkdown,
  threadRef,
  cwd,
  blockedReason,
  onDecide,
}: {
  plan: PlanReviewTarget;
  previousMarkdown: string | null;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
  blockedReason: string | null;
  onDecide: (decision: PlanReviewDecision, draft: PlanReviewDraft) => Promise<void>;
}) {
  const gt = useGT();
  const draftKey = planReviewDraftKey(threadRef, plan.id);
  const draft = usePlanReviewDraft(draftKey);
  const updateDraft = usePlanReviewDraftStore((store) => store.update);
  const [view, setView] = useState<"plan" | "diff">("plan");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [sending, setSending] = useState<PlanReviewDecision | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const change = (next: (current: PlanReviewDraft) => PlanReviewDraft) =>
    updateDraft(draftKey, next);

  const annotate = (action: PlanAnnotationDraft["action"], selection: PlanTextSelection) => {
    const id = randomUUID();
    change((current) => ({
      ...current,
      annotations: [
        ...current.annotations,
        {
          id,
          action,
          quote: selection.quote,
          anchor: selection.anchor,
          ...(selection.line === undefined ? {} : { line: selection.line }),
        },
      ],
    }));
    setFocusedId(id);
  };
  const reveal = (annotation: PlanAnnotationDraft) => {
    // The plan has to be back on screen before its text can be scrolled to.
    flushSync(() => {
      setFocusedId(annotation.id);
      setView("plan");
    });
    if (annotation.anchor && scrollerRef.current) {
      revealPlanAnchor(scrollerRef.current, annotation.anchor);
    }
  };
  const decide = async (decision: PlanReviewDecision) => {
    setSending(decision);
    await onDecide(decision, draft);
    setSending(null);
  };

  const noteCount = countPlanReviewNotes(draft);
  const hasFeedback = hasPlanReviewFeedback(draft);
  const disabled = blockedReason !== null || sending !== null;
  const hint =
    blockedReason ??
    (hasFeedback
      ? gt(
          "{count, plural, one {# note} other {# notes}}. Request changes to have the plan revised, or approve to send them as implementation notes.",
          { count: noteCount },
        )
      : gt("Select text in the plan to annotate it. With nothing to change, approve it."));

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-3 pe-8">
          <DialogTitle>{gt("Review plan")}</DialogTitle>
          {plan.revision !== undefined && plan.revision > 1 ? (
            <Badge variant="secondary">
              {gt("Revision {revision}", { revision: plan.revision })}
            </Badge>
          ) : null}
          {plan.previousPlanId === undefined ? null : (
            <ToggleGroup
              className="ms-auto"
              value={[view]}
              onValueChange={(next) => {
                if (next[0] === "plan" || next[0] === "diff") setView(next[0]);
              }}
            >
              <Toggle value="plan">{gt("Plan")}</Toggle>
              <Toggle value="diff">{gt("Compare with previous")}</Toggle>
            </ToggleGroup>
          )}
        </div>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col border-t border-border/70 md:flex-row">
        <PlanReviewDocument
          hidden={view !== "plan"}
          markdown={plan.markdown}
          cwd={cwd}
          environmentId={threadRef.environmentId}
          threadRef={threadRef}
          annotations={draft.annotations}
          focusedId={focusedId}
          scrollerRef={scrollerRef}
          onAnnotate={annotate}
          onFocusAnnotation={setFocusedId}
        />
        {view === "plan" ? null : (
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
            {previousMarkdown === null ? (
              <p className="p-6 text-sm text-muted-foreground">
                {gt("The previous revision is not loaded here, so it cannot be compared.")}
              </p>
            ) : (
              <PlanDiffView previous={previousMarkdown} current={plan.markdown} />
            )}
          </div>
        )}
        <aside
          className="flex max-h-1/2 shrink-0 flex-col overflow-auto overscroll-contain border-t border-border/70 md:max-h-none md:w-80 md:border-s md:border-t-0"
          aria-label={gt("Review notes")}
        >
          <PlanReviewNotes
            draft={draft}
            focusedId={focusedId}
            onChange={change}
            onReveal={reveal}
          />
        </aside>
      </div>
      <DialogFooter className="sm:items-center">
        {/* The footer stacks bottom-up when narrow; the order keeps the hint above the buttons. */}
        <p className="order-1 text-xs text-muted-foreground sm:order-none sm:me-auto">{hint}</p>
        <div className="flex gap-2">
          <Button
            className="grow sm:grow-0"
            size="sm"
            // With notes written, sending the plan back is what the reviewer most likely means.
            variant={hasFeedback ? "default" : "outline"}
            disabled={disabled || !hasFeedback}
            aria-busy={sending === "revise"}
            onClick={() => void decide("revise")}
          >
            {sending === "revise" ? <Spinner aria-hidden="true" /> : null}
            {gt("Request changes")}
          </Button>
          <Button
            className="grow sm:grow-0"
            size="sm"
            variant={hasFeedback ? "outline" : "default"}
            disabled={disabled}
            aria-busy={sending === "approve"}
            onClick={() => void decide("approve")}
          >
            {sending === "approve" ? <Spinner aria-hidden="true" /> : null}
            {gt("Approve and implement")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** Reviews one proposed plan: annotate it, compare it with the revision before, then decide. */
export function PlanReviewDialog({
  plan,
  onClose,
  ...body
}: {
  plan: PlanReviewTarget | null;
  previousMarkdown: string | null;
  threadRef: ScopedThreadRef;
  cwd: string | undefined;
  /** Why a decision cannot be sent right now, in the reader's words. */
  blockedReason: string | null;
  onDecide: (decision: PlanReviewDecision, draft: PlanReviewDraft) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={plan !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="h-[min(92dvh,56rem)] max-w-6xl">
        {plan === null ? null : <PlanReviewBody key={plan.id} plan={plan} {...body} />}
      </DialogPopup>
    </Dialog>
  );
}
