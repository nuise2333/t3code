import type { PlanAnnotationDraft, PlanReviewDraft } from "@t3tools/client-runtime/planReview";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { IconButton } from "../../../components/ui/IconButton";
import { useGT } from "../../../i18n/I18nProvider";
import { cn } from "../../../lib/cn";

/** Each kind of note keeps one color from the plan to the list of notes. */
export const ANNOTATION_TONE = {
  delete: { block: "border-rose-400/60 bg-rose-500/10", label: "text-danger-foreground" },
  replace: { block: "border-amber-400/60 bg-amber-500/10", label: "text-warning-foreground" },
  comment: { block: "border-sky-400/60 bg-sky-500/10", label: "text-primary-text" },
} as const;

export function annotationNote(annotation: PlanAnnotationDraft): string {
  return (annotation.action === "replace" ? annotation.replacement : annotation.comment) ?? "";
}

export function useAnnotationActionLabel() {
  const gt = useGT();
  return (action: PlanAnnotationDraft["action"]) =>
    action === "delete" ? gt("Delete") : action === "replace" ? gt("Replace") : gt("Comment");
}

/** Writes a note beside its plan block. What is typed is the draft at once, so nothing is lost. */
export function AnnotationForm(props: {
  readonly annotation: PlanAnnotationDraft;
  readonly onChangeNote: (note: string) => void;
  readonly onDone: () => void;
  /** Receives the note as it was when the form opened. */
  readonly onCancel: (original: string) => void;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  const { annotation } = props;
  const [original] = useState(() => annotationNote(annotation));
  // The field reads its own state so a slow draft write can never fight the keyboard's composition.
  const [note, setNote] = useState(original);
  const label =
    annotation.action === "replace"
      ? gt("Replace with")
      : annotation.action === "comment"
        ? gt("Comment")
        : gt("Reason (optional)");
  const canSave = annotation.action === "delete" || note.trim().length > 0;
  return (
    <View className="gap-2 pt-2">
      <Text textRole="caption" className="font-t3-medium text-foreground">
        {label}
      </Text>
      <TextInput
        autoFocus
        multiline
        accessibilityLabel={label}
        textAlignVertical="top"
        value={note}
        onChangeText={(text) => {
          setNote(text);
          props.onChangeNote(text);
        }}
        className="min-h-20"
      />
      <View className="flex-row flex-wrap items-center justify-end gap-2">
        <View className="flex-1">
          <Button
            size="compact"
            tone="text"
            label={gt("Remove annotation")}
            onPress={props.onRemove}
          />
        </View>
        <Button
          size="compact"
          tone="text"
          label={gt("Cancel")}
          onPress={() => props.onCancel(original)}
        />
        <Button
          size="compact"
          tone="primary"
          label={gt("Save")}
          disabled={!canSave}
          onPress={props.onDone}
        />
      </View>
    </View>
  );
}

function AnnotationItem(props: {
  readonly annotation: PlanAnnotationDraft;
  readonly onReveal: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  const actionLabel = useAnnotationActionLabel();
  const { annotation } = props;
  const note = annotationNote(annotation).trim();
  return (
    <View className={cn("rounded-2xl border px-3 pb-3", ANNOTATION_TONE[annotation.action].block)}>
      <View className="flex-row items-center gap-2">
        <Text
          textRole="caption"
          className={cn("font-t3-bold", ANNOTATION_TONE[annotation.action].label)}
        >
          {actionLabel(annotation.action)}
        </Text>
        {annotation.line === undefined ? null : (
          <Text textRole="caption" className="text-foreground-muted">
            {gt("Line {line}", { line: annotation.line })}
          </Text>
        )}
        <View className="flex-1" />
        <IconButton
          icon="pencil"
          accessibilityLabel={gt("Edit annotation")}
          tintColorClassName="accent-icon-muted"
          onPress={props.onEdit}
        />
        <IconButton
          icon="trash"
          accessibilityLabel={gt("Remove annotation")}
          tintColorClassName="accent-icon-muted"
          onPress={props.onRemove}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Show in plan: {quote}", { quote: annotation.quote })}
        onPress={props.onReveal}
        className="border-l-2 border-border pl-2 active:opacity-70"
      >
        <Text
          textRole="footnote"
          numberOfLines={3}
          className={cn("text-foreground-muted", annotation.action === "delete" && "line-through")}
        >
          {annotation.quote}
        </Text>
      </Pressable>
      {note ? (
        <Text textRole="footnote" className="pt-2 text-foreground">
          {annotation.action === "replace" ? gt("Replace with: {text}", { text: note }) : note}
        </Text>
      ) : null}
    </View>
  );
}

/** The reviewer's notes on a plan: one per annotated part, plus feedback on the plan as a whole. */
export function PlanReviewNotes(props: {
  readonly draft: PlanReviewDraft;
  readonly onChangeGeneral: (general: string) => void;
  readonly onReveal: (annotation: PlanAnnotationDraft) => void;
  /** Notes are edited beside the part of the plan they are about. */
  readonly onEdit: (annotation: PlanAnnotationDraft) => void;
  readonly onRemove: (id: string) => void;
}) {
  const gt = useGT();
  const { draft } = props;
  const general = gt("Overall feedback");
  return (
    <View className="gap-5">
      <View className="gap-2">
        <Text accessibilityRole="header" textRole="footnote" className="font-t3-bold">
          {gt("Annotations ({count})", { count: draft.annotations.length })}
        </Text>
        {draft.annotations.length === 0 ? (
          <Text textRole="caption" className="text-foreground-muted">
            {gt("Tap a part of the plan to delete it, replace it, or comment on it.")}
          </Text>
        ) : (
          draft.annotations.map((annotation) => (
            <AnnotationItem
              key={annotation.id}
              annotation={annotation}
              onReveal={() => props.onReveal(annotation)}
              onEdit={() => props.onEdit(annotation)}
              onRemove={() => props.onRemove(annotation.id)}
            />
          ))
        )}
      </View>
      <View className="gap-2">
        <Text accessibilityRole="header" textRole="footnote" className="font-t3-bold">
          {general}
        </Text>
        <TextInput
          multiline
          accessibilityLabel={general}
          textAlignVertical="top"
          value={draft.general}
          placeholder={gt("Anything about the plan as a whole (optional)")}
          onChangeText={props.onChangeGeneral}
          className="min-h-24"
        />
      </View>
    </View>
  );
}
