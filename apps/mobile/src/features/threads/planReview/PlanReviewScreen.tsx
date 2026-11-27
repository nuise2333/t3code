import {
  hasPlanReviewFeedback,
  isPlanAnnotationComplete,
  countPlanReviewNotes,
  type PlanAnnotationDraft,
  type PlanReviewDraft,
} from "@t3tools/client-runtime/planReview";
import type { EnvironmentId, PlanId, ThreadId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { memo, useRef, useState } from "react";
import { Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { KeyboardSheetBody } from "../../../components/ui/KeyboardSheetBody";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { I18nProvider, useGT } from "../../../i18n/I18nProvider";
import { cn } from "../../../lib/cn";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { uuidv4 } from "../../../lib/uuid";
import {
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
} from "../../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../../files/FileMarkdownPreview";
import { findProposedPlan, resolvePlanMarkdown } from "./planArtifacts";
import { PlanDiffView } from "./PlanDiffView";
import { annotationForBlock, splitPlanBlocks, type PlanBlock } from "./planReviewBlocks";
import {
  planReviewDraftKey,
  updatePlanReviewDraft,
  usePlanReviewDraft,
  usePlanReviewDraftsLoaded,
} from "./planReviewDrafts";
import {
  ANNOTATION_TONE,
  AnnotationForm,
  annotationNote,
  PlanReviewNotes,
  useAnnotationActionLabel,
} from "./PlanReviewNotes";
import { usePlanDecision } from "./usePlanDecision";

const DEPTH_INDENT = 14;

type PlanReviewParams = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly planId: PlanId;
};

/** Reviews one proposed plan: annotate its parts, compare it with the revision before, then decide. */
export function PlanReviewScreen(props: StaticScreenProps<PlanReviewParams>) {
  return (
    <I18nProvider>
      <PlanReview {...props.route.params} />
    </I18nProvider>
  );
}

/** Memoized with handlers that do not change as a note is typed, so typing redraws one block. */
const PlanBlockRow = memo(function PlanBlockRow(props: {
  readonly block: PlanBlock;
  readonly annotation: PlanAnnotationDraft | undefined;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onPress: (block: PlanBlock, annotation: PlanAnnotationDraft | undefined) => void;
  readonly onAnnotate: (action: PlanAnnotationDraft["action"], block: PlanBlock) => void;
  readonly onChangeNote: (id: string, note: string) => void;
  readonly onDone: () => void;
  readonly onCancel: (id: string, original: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onLayout: (line: number, y: number) => void;
}) {
  const gt = useGT();
  const actionLabel = useAnnotationActionLabel();
  const { block, annotation } = props;
  const note = annotation ? annotationNote(annotation).trim() : "";
  return (
    <View
      style={{ marginLeft: block.depth * DEPTH_INDENT }}
      onLayout={(event) => props.onLayout(block.line, event.nativeEvent.layout.y)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={block.quote}
        accessibilityHint={gt("Annotates this part of the plan")}
        accessibilityState={{ selected: props.selected }}
        disabled={!block.quote}
        onPress={() => props.onPress(block, annotation)}
        className={cn(
          "rounded-xl border px-3 py-1.5 active:opacity-70",
          props.selected
            ? "border-primary bg-primary/10"
            : annotation
              ? ANNOTATION_TONE[annotation.action].block
              : "border-transparent",
        )}
      >
        {/* The Markdown view takes touches for selection and links; here a tap picks the block. */}
        <View
          pointerEvents="none"
          className={annotation?.action === "delete" ? "opacity-50" : undefined}
        >
          <SelectableMarkdownText markdown={block.markdown} textStyle={props.textStyle} />
        </View>
        {annotation && !props.editing ? (
          <View className="flex-row gap-2 pt-1">
            <Text
              textRole="caption"
              className={cn("font-t3-bold", ANNOTATION_TONE[annotation.action].label)}
            >
              {actionLabel(annotation.action)}
            </Text>
            {note ? (
              <Text textRole="caption" className="min-w-0 flex-1">
                {note}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Pressable>
      {props.selected && !annotation ? (
        <View className="flex-row flex-wrap gap-2 px-1 py-2">
          <Button
            size="compact"
            tone="danger"
            icon="trash"
            label={gt("Delete")}
            onPress={() => props.onAnnotate("delete", block)}
          />
          <Button
            size="compact"
            icon="arrow.left.arrow.right"
            label={gt("Replace")}
            onPress={() => props.onAnnotate("replace", block)}
          />
          <Button
            size="compact"
            icon="text.bubble"
            label={gt("Comment")}
            onPress={() => props.onAnnotate("comment", block)}
          />
        </View>
      ) : null}
      {annotation && props.editing ? (
        <View className="px-1 pb-2">
          <AnnotationForm
            annotation={annotation}
            onChangeNote={(text) => props.onChangeNote(annotation.id, text)}
            onDone={props.onDone}
            onCancel={(original) => props.onCancel(annotation.id, original)}
            onRemove={() => props.onRemove(annotation.id)}
          />
        </View>
      ) : null}
    </View>
  );
});

function PlanReview({ environmentId, threadId, planId }: PlanReviewParams) {
  const gt = useGT();
  const navigation = useNavigation();
  const decision = usePlanDecision({ environmentId, threadId });
  const projection = decision.structure?.projection;
  const plan = findProposedPlan(projection?.plans, planId);
  const turnItems = projection?.visibleTurnItems.map((row) => row.item) ?? [];
  const markdown = projection ? resolvePlanMarkdown(planId, projection.plans, turnItems) : null;
  const previousMarkdown =
    projection && plan?.previousPlanId !== undefined
      ? resolvePlanMarkdown(plan.previousPlanId, projection.plans, turnItems)
      : null;
  const draftKey = planReviewDraftKey(scopedThreadKey(environmentId, threadId), planId);
  const draft = usePlanReviewDraft(draftKey);
  const draftsLoaded = usePlanReviewDraftsLoaded();
  const [view, setView] = useState<"plan" | "diff">("plan");
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { nativeTextStyle } = useMarkdownPreviewStyles();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const blockOffsets = useRef(new Map<number, number>());
  const documentOffset = useRef(0);
  const blocks = splitPlanBlocks(markdown ?? "");

  const change = (next: (current: PlanReviewDraft) => PlanReviewDraft) =>
    updatePlanReviewDraft(draftKey, next);
  // A block at the top of the page keeps the note being written under it clear of the keyboard.
  const scrollToLine = (line: number | undefined) => {
    const y = line === undefined ? undefined : blockOffsets.current.get(line);
    if (y !== undefined) {
      scrollRef.current?.scrollTo({ y: Math.max(0, documentOffset.current + y - 12) });
    }
  };
  const recordBlockOffset = (line: number, y: number) => {
    blockOffsets.current.set(line, y);
  };
  const closeEditor = () => setEditingId(null);
  const remove = (id: string) => {
    change((current) => ({
      ...current,
      annotations: current.annotations.filter((annotation) => annotation.id !== id),
    }));
    if (editingId === id) setEditingId(null);
  };
  // What is typed goes into the draft at once, so sending or leaving never loses it.
  const setNote = (id: string, note: string) =>
    change((current) => ({
      ...current,
      annotations: current.annotations.map((annotation) =>
        annotation.id !== id
          ? annotation
          : annotation.action === "replace"
            ? { ...annotation, replacement: note }
            : { ...annotation, comment: note },
      ),
    }));
  // A note that never got its text is dropped instead of left half-made.
  const dropUnfinished = (keepId?: string) =>
    change((current) => {
      const keep = (annotation: PlanAnnotationDraft) =>
        annotation.id === keepId || isPlanAnnotationComplete(annotation);
      return current.annotations.every(keep)
        ? current
        : { ...current, annotations: current.annotations.filter(keep) };
    });
  const cancel = (id: string, original: string) => {
    setNote(id, original);
    dropUnfinished();
    setEditingId(null);
  };
  const annotate = (action: PlanAnnotationDraft["action"], block: PlanBlock) => {
    const id = uuidv4();
    change((current) => ({
      ...current,
      annotations: [...current.annotations, { id, action, quote: block.quote, line: block.line }],
    }));
    setSelectedLine(null);
    if (action === "delete") {
      setEditingId(null);
      return;
    }
    setEditingId(id);
    scrollToLine(block.line);
  };
  const pressBlock = (block: PlanBlock, annotation: PlanAnnotationDraft | undefined) => {
    dropUnfinished(annotation?.id);
    if (annotation) {
      setSelectedLine(null);
      setEditingId(editingId === annotation.id ? null : annotation.id);
      return;
    }
    setEditingId(null);
    setSelectedLine(selectedLine === block.line ? null : block.line);
  };
  const reveal = (annotation: PlanAnnotationDraft) => {
    setView("plan");
    setSelectedLine(null);
    scrollToLine(annotation.line);
  };
  const decide = async (kind: "approve" | "revise") => {
    if (markdown === null) return;
    const sent = await decision.decide({
      planId,
      planMarkdown: markdown,
      draft,
      decision: kind,
    });
    if (sent) navigation.goBack();
  };

  const hasFeedback = hasPlanReviewFeedback(draft);
  const answered = plan !== undefined && plan.status !== "active";
  const disabled =
    answered ||
    markdown === null ||
    !draftsLoaded ||
    decision.blockedReason !== null ||
    decision.sending !== null;
  const hint =
    plan?.status === "completed"
      ? gt("Approved")
      : plan?.status === "superseded"
        ? gt("Replaced by a newer revision")
        : (decision.blockedReason ??
          (hasFeedback
            ? gt(
                "{count, plural, one {# note} other {# notes}}. Request changes to have the plan revised, or approve to send them as implementation notes.",
                { count: countPlanReviewNotes(draft) },
              )
            : gt("Tap a part of the plan to annotate it. With nothing to change, approve it.")));

  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        title={gt("Review plan")}
        {...(plan?.revision !== undefined && plan.revision > 1
          ? { subtitle: gt("Revision {revision}", { revision: plan.revision }) }
          : {})}
        onClose={() => navigation.goBack()}
      />
      <KeyboardSheetBody
        toolbar={
          <>
            <View className="flex-1">
              <Button
                fullWidth
                size="compact"
                // With notes written, sending the plan back is what the reviewer most likely means.
                tone={hasFeedback ? "primary" : "secondary"}
                label={gt("Request changes")}
                disabled={disabled || !hasFeedback}
                loading={decision.sending === "revise"}
                onPress={() => void decide("revise")}
              />
            </View>
            <View className="flex-[1.4]">
              <Button
                fullWidth
                size="compact"
                tone={hasFeedback ? "secondary" : "primary"}
                label={gt("Approve and implement")}
                disabled={disabled}
                loading={decision.sending === "approve"}
                onPress={() => void decide("approve")}
              />
            </View>
          </>
        }
      >
        {plan?.previousPlanId === undefined ? null : (
          <View className="pb-3">
            <SegmentedControl
              options={[
                { value: "plan", label: gt("Plan") },
                { value: "diff", label: gt("Compare with previous") },
              ]}
              selected={view}
              onSelect={setView}
            />
          </View>
        )}
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 20, paddingBottom: 16 }}
        >
          {markdown === null ? null : view === "plan" ? (
            <View
              className="gap-0.5"
              onLayout={(event) => {
                documentOffset.current = event.nativeEvent.layout.y;
              }}
            >
              {blocks.map((block) => {
                const annotation = annotationForBlock(draft.annotations, block);
                return (
                  <PlanBlockRow
                    key={block.line}
                    block={block}
                    annotation={annotation}
                    selected={selectedLine === block.line}
                    // An unfinished note keeps its field open until it has text or is dropped.
                    editing={
                      annotation !== undefined &&
                      (editingId === annotation.id || !isPlanAnnotationComplete(annotation))
                    }
                    textStyle={nativeTextStyle}
                    onPress={pressBlock}
                    onAnnotate={annotate}
                    onChangeNote={setNote}
                    onDone={closeEditor}
                    onCancel={cancel}
                    onRemove={remove}
                    onLayout={recordBlockOffset}
                  />
                );
              })}
            </View>
          ) : previousMarkdown === null ? (
            <Text textRole="footnote" className="text-foreground-muted">
              {gt("The previous revision is not loaded here, so it cannot be compared.")}
            </Text>
          ) : (
            <PlanDiffView previous={previousMarkdown} current={markdown} />
          )}
          <PlanReviewNotes
            draft={draft}
            onChangeGeneral={(general) => change((current) => ({ ...current, general }))}
            onReveal={reveal}
            onEdit={(annotation) => {
              reveal(annotation);
              setEditingId(annotation.id);
            }}
            onRemove={remove}
          />
        </ScrollView>
        <Text textRole="caption" className="py-2 text-foreground-muted">
          {hint}
        </Text>
      </KeyboardSheetBody>
    </View>
  );
}
