import type { PlanAnnotationDraft } from "@t3tools/client-runtime/planReview";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MessageSquarePlusIcon, ReplaceIcon, Trash2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  capturePlanTextSelection,
  paintPlanHighlights,
  planAnchorIndexAtPoint,
  type PlanHighlightMark,
  type PlanTextSelection,
} from "~/lib/planReviewDom";
import { observeSelectionActions } from "~/lib/selectionActions";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../../ChatMarkdown";
import { Button } from "../../ui/button";

// A touch selection settles after the last handle drag; mouse selections use the observer.
const TOUCH_SELECTION_SETTLE_MS = 300;

/**
 * The plan as the reviewer reads it. Selecting text offers the three annotations; existing
 * ones stay painted over the text they are about.
 */
export function PlanReviewDocument({
  hidden,
  markdown,
  cwd,
  environmentId,
  threadRef,
  annotations,
  focusedId,
  scrollerRef,
  onAnnotate,
  onFocusAnnotation,
}: {
  /** Kept mounted while the comparison is shown, so the reading position survives it. */
  hidden: boolean;
  markdown: string;
  cwd: string | undefined;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  annotations: ReadonlyArray<PlanAnnotationDraft>;
  focusedId: string | null;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onAnnotate: (action: PlanAnnotationDraft["action"], selection: PlanTextSelection) => void;
  onFocusAnnotation: (id: string | null) => void;
}) {
  const gt = useGT();
  const [selection, setSelection] = useState<PlanTextSelection | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selection events to offer annotations for the selected plan text
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () =>
      setSelection(capturePlanTextSelection(scroller, markdown, window.getSelection()));
    const actions = observeSelectionActions({
      element: scroller,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      onSelection: update,
      onDismiss: () => setSelection(null),
    });
    let touch = false;
    let touchTimer: number | null = null;
    const onPointerDown = (event: PointerEvent) => {
      touch = event.pointerType !== "mouse";
    };
    const onSelectionChange = () => {
      actions.selectionChanged();
      if (!touch) return;
      if (touchTimer !== null) window.clearTimeout(touchTimer);
      touchTimer = window.setTimeout(update, TOUCH_SELECTION_SETTLE_MS);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      if (touchTimer !== null) window.clearTimeout(touchTimer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      actions.dispose();
    };
  }, [markdown, scrollerRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints annotation highlights over the rendered Markdown, and again when a code block finishes rendering
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const marks: PlanHighlightMark[] = annotations.flatMap((annotation) =>
      annotation.anchor
        ? [
            {
              anchor: annotation.anchor,
              kind: annotation.id === focusedId ? "focus" : annotation.action,
            },
          ]
        : [],
    );
    let clear = paintPlanHighlights(scroller, marks);
    const observer = new MutationObserver(() => {
      clear();
      clear = paintPlanHighlights(scroller, marks);
    });
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clear();
    };
  }, [annotations, focusedId, scrollerRef]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the toolbar and keeps it inside the plan column before paint
  useLayoutEffect(() => {
    const host = hostRef.current;
    const toolbar = toolbarRef.current;
    if (!host || !toolbar || !selection) return;
    const bounds = host.getBoundingClientRect();
    const left = selection.rect.right - bounds.left - toolbar.offsetWidth;
    const top = selection.rect.bottom - bounds.top + 6;
    toolbar.style.left = `${Math.max(8, Math.min(left, bounds.width - toolbar.offsetWidth - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(top, bounds.height - toolbar.offsetHeight - 8))}px`;
  }, [selection]);

  const annotate = (action: PlanAnnotationDraft["action"]) => {
    if (!selection) return;
    onAnnotate(action, selection);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  const actions: ReadonlyArray<[PlanAnnotationDraft["action"], string, ReactNode]> = [
    ["delete", gt("Delete"), <Trash2Icon key="delete" aria-hidden="true" />],
    ["replace", gt("Replace"), <ReplaceIcon key="replace" aria-hidden="true" />],
    ["comment", gt("Comment"), <MessageSquarePlusIcon key="comment" aria-hidden="true" />],
  ];

  return (
    <div ref={hostRef} className={cn("relative min-h-0 flex-1", hidden && "hidden")}>
      <div
        ref={scrollerRef}
        className="h-full overflow-auto overscroll-contain px-5 py-4"
        data-testid="plan-review-document"
        onClick={(event) => {
          if (!window.getSelection()?.isCollapsed) return;
          const index = planAnchorIndexAtPoint(
            event.currentTarget,
            annotations.map((annotation) => annotation.anchor),
            { x: event.clientX, y: event.clientY },
          );
          onFocusAnnotation(annotations[index]?.id ?? null);
        }}
      >
        <ChatMarkdown
          text={markdown}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef}
          isStreaming={false}
          headingLevelOffset={2}
        />
      </div>
      {selection ? (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={gt("Annotate the selected text")}
          className="absolute z-10 flex gap-1"
          onPointerDown={(event) => event.preventDefault()}
        >
          {actions.map(([action, label, icon]) => (
            <Button key={action} size="xs" variant="glass" onClick={() => annotate(action)}>
              {icon}
              {label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
