import {
  isPlanAnnotationComplete,
  type PlanAnnotationDraft,
  type PlanReviewDraft,
} from "@t3tools/client-runtime/planReview";
import { useGT } from "gt-react";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "~/lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";

const ACTION_BADGE = { delete: "error", replace: "warning", comment: "info" } as const;

function annotationNote(annotation: PlanAnnotationDraft): string {
  return (annotation.action === "replace" ? annotation.replacement : annotation.comment) ?? "";
}

function withNote(annotation: PlanAnnotationDraft, note: string): PlanAnnotationDraft {
  return annotation.action === "replace"
    ? { ...annotation, replacement: note }
    : { ...annotation, comment: note };
}

/** Writes a note. What is typed is the draft at once, so deciding or leaving never loses it. */
function AnnotationForm({
  annotation,
  onChangeNote,
  onDone,
  onCancel,
}: {
  annotation: PlanAnnotationDraft;
  onChangeNote: (note: string) => void;
  onDone: () => void;
  /** Receives the note as it was when the form opened. */
  onCancel: (original: string) => void;
}) {
  const gt = useGT();
  const note = annotationNote(annotation);
  const [original] = useState(note);
  const noteId = useId();
  const required = annotation.action !== "delete";
  const label =
    annotation.action === "replace"
      ? gt("Replace with")
      : annotation.action === "comment"
        ? gt("Comment")
        : gt("Reason (optional)");
  const canSave = !required || note.trim().length > 0;
  return (
    <div className="mt-2 grid gap-2">
      <label htmlFor={noteId} className="text-xs font-medium text-foreground">
        {label}
      </label>
      <Textarea
        id={noteId}
        size="sm"
        autoFocus
        value={note}
        onChange={(event) => onChangeNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            // Escape leaves the note, not the whole review.
            event.stopPropagation();
            onCancel(original);
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSave) {
            event.preventDefault();
            onDone();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={() => onCancel(original)}>
          {gt("Cancel")}
        </Button>
        <Button size="xs" disabled={!canSave} onClick={onDone}>
          {gt("Save")}
        </Button>
      </div>
    </div>
  );
}

function AnnotationItem({
  annotation,
  focused,
  editing,
  onReveal,
  onEdit,
  onChangeNote,
  onDone,
  onCancel,
  onRemove,
}: {
  annotation: PlanAnnotationDraft;
  focused: boolean;
  editing: boolean;
  onReveal: () => void;
  onEdit: () => void;
  onChangeNote: (note: string) => void;
  onDone: () => void;
  onCancel: (original: string) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const actionLabel =
    annotation.action === "delete"
      ? gt("Delete")
      : annotation.action === "replace"
        ? gt("Replace")
        : gt("Comment");
  const note = annotationNote(annotation);
  return (
    <li
      className={cn(
        "rounded-lg border border-border/70 bg-background/60 p-2.5",
        focused && "border-ring",
      )}
      data-annotation-id={annotation.id}
    >
      <div className="flex items-center gap-2">
        <Badge variant={ACTION_BADGE[annotation.action]}>{actionLabel}</Badge>
        {annotation.line === undefined ? null : (
          <span className="text-xs text-muted-foreground">
            {gt("Line {line}", { line: annotation.line })}
          </span>
        )}
        <span className="ms-auto flex gap-0.5">
          {editing ? null : (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Edit annotation")}
              onClick={onEdit}
            >
              <PencilIcon aria-hidden="true" />
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Remove annotation")}
            onClick={onRemove}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        </span>
      </div>
      <button
        type="button"
        className={cn(
          "mt-2 line-clamp-3 w-full cursor-pointer border-s-2 border-border ps-2 text-start text-xs whitespace-pre-wrap text-muted-foreground wrap-anywhere hover:text-foreground",
          annotation.action === "delete" && "line-through",
        )}
        aria-label={gt("Show in plan: {quote}", { quote: annotation.quote })}
        onClick={onReveal}
      >
        {annotation.quote}
      </button>
      {editing ? (
        <AnnotationForm
          annotation={annotation}
          onChangeNote={onChangeNote}
          onDone={onDone}
          onCancel={onCancel}
        />
      ) : note ? (
        <p className="mt-2 text-sm whitespace-pre-wrap text-foreground wrap-anywhere">
          {annotation.action === "replace" ? gt("Replace with: {text}", { text: note }) : note}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The reviewer's notes on a plan: one per selection, plus feedback on the plan as a whole, which
 * stays in view below the list however many notes there are.
 */
export function PlanReviewNotes({
  draft,
  focusedId,
  onChange,
  onReveal,
}: {
  draft: PlanReviewDraft;
  focusedId: string | null;
  onChange: (change: (draft: PlanReviewDraft) => PlanReviewDraft) => void;
  onReveal: (annotation: PlanAnnotationDraft) => void;
}) {
  const gt = useGT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const generalId = useId();
  const remove = (id: string) =>
    onChange((current) => ({
      ...current,
      annotations: current.annotations.filter((annotation) => annotation.id !== id),
    }));
  const setNote = (id: string, note: string) =>
    onChange((current) => ({
      ...current,
      annotations: current.annotations.map((annotation) =>
        annotation.id === id ? withNote(annotation, note) : annotation,
      ),
    }));
  return (
    <>
      <section className="flex min-h-24 flex-1 flex-col">
        <h3 className="px-4 pt-4 pb-2 text-sm font-medium text-foreground">
          {gt("Annotations ({count})", { count: draft.annotations.length })}
        </h3>
        {draft.annotations.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            {gt("Select text in the plan to delete it, replace it, or comment on it.")}
          </p>
        ) : (
          <ul className="grid min-h-0 flex-1 content-start gap-2 overflow-auto overscroll-contain px-4 pb-4">
            {draft.annotations.map((annotation) => {
              const complete = isPlanAnnotationComplete(annotation);
              return (
                <AnnotationItem
                  key={annotation.id}
                  annotation={annotation}
                  focused={focusedId === annotation.id}
                  editing={editingId === annotation.id || !complete}
                  onReveal={() => onReveal(annotation)}
                  onEdit={() => setEditingId(annotation.id)}
                  onChangeNote={(note) => {
                    // Its first character completes a new note, which must not close the form.
                    setEditingId(annotation.id);
                    setNote(annotation.id, note);
                  }}
                  onDone={() => {
                    setNote(annotation.id, annotationNote(annotation).trim());
                    setEditingId(null);
                  }}
                  onCancel={(original) => {
                    // A note that never had its text is dropped instead of left half-made.
                    if (isPlanAnnotationComplete(withNote(annotation, original)))
                      setNote(annotation.id, original);
                    else remove(annotation.id);
                    setEditingId(null);
                  }}
                  onRemove={() => remove(annotation.id)}
                />
              );
            })}
          </ul>
        )}
      </section>
      <section className="grid shrink-0 gap-2 border-t border-border/70 p-4">
        <label htmlFor={generalId} className="text-sm font-medium text-foreground">
          {gt("Overall feedback")}
        </label>
        <Textarea
          id={generalId}
          size="sm"
          rows={2}
          value={draft.general}
          placeholder={gt("Anything about the plan as a whole (optional)")}
          onChange={(event) => {
            const general = event.target.value;
            onChange((current) => ({ ...current, general }));
          }}
        />
      </section>
    </>
  );
}
