import { useAtomValue } from "@effect/atom-react";
import { hasPlanReviewFeedback } from "@t3tools/client-runtime/planReview";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import * as Dialog from "../../components/ui/Dialog";
import { I18nProvider, useGT } from "../../i18n/I18nProvider";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { CopyTextButton } from "./CopyTextButton";
import { findProposedPlan } from "./planReview/planArtifacts";
import {
  planReviewDraftKey,
  usePlanReviewDraft,
  usePlanReviewDraftsLoaded,
} from "./planReview/planReviewDrafts";
import { usePlanDecision } from "./planReview/usePlanDecision";

type ProposedPlanTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "proposed_plan" }>;

interface ProposedPlanCardProps {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | null | undefined;
  readonly plan: ProposedPlanTurnItem;
  readonly renderMarkdown: (text: string) => ReactNode;
}

export function ProposedPlanCard(props: ProposedPlanCardProps) {
  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <I18nProvider fallback={null}>
        <ProposedPlanCardBody {...props} />
      </I18nProvider>
    </View>
  );
}

function ProposedPlanCardBody(props: ProposedPlanCardProps) {
  const gt = useGT();
  const navigation = useNavigation();
  const { environmentId, plan } = props;
  const markdown = plan.markdown;
  const decision = usePlanDecision({ environmentId, threadId: plan.threadId });
  const artifact = findProposedPlan(decision.structure?.projection.plans, plan.planId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const draft = usePlanReviewDraft(
    planReviewDraftKey(scopedThreadKey(environmentId, plan.threadId), plan.planId),
  );
  const draftsLoaded = usePlanReviewDraftsLoaded();
  const canWrite = useAtomValue(projectEnvironment.writeFile.permissionAtom(environmentId));
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [lastPath, setLastPath] = useState("plan.md");
  const contents = `${markdown.trimEnd()}\n`;
  const status = artifact?.status ?? "active";
  const hasNotes = hasPlanReviewFeedback(draft);
  const revision = artifact?.revision;

  const save = async (path: string) => {
    const relativePath = path.trim();
    if (!canWrite || !props.workspaceRoot || inFlight.current) return;
    if (!relativePath) {
      Dialog.alert(gt("Enter a workspace path"));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setLastPath(relativePath);
    const result = await writeFile({
      environmentId,
      input: { cwd: props.workspaceRoot, relativePath, contents },
    }).finally(() => {
      inFlight.current = false;
      setSaving(false);
    });
    if (result._tag === "Success") {
      Dialog.alert(gt("Plan saved to workspace"), result.value.relativePath);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Could not save plan"),
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const review = () =>
    navigation.navigate("ThreadPlanReview", {
      environmentId,
      threadId: plan.threadId,
      planId: plan.planId,
    });

  return (
    <>
      <View className="flex-row flex-wrap items-center gap-1.5">
        <Chip size="small" label={gt("Plan")} />
        {revision !== undefined && revision > 1 ? (
          <Chip size="small" label={gt("Revision {revision}", { revision })} />
        ) : null}
        {status === "completed" ? (
          <Chip size="small" icon="checkmark" label={gt("Approved")} />
        ) : status === "superseded" ? (
          <Chip size="small" label={gt("Replaced by a newer revision")} />
        ) : null}
      </View>
      <View className="flex-row items-center gap-2">
        <Text accessibilityRole="header" className="flex-1 font-t3-bold text-base text-foreground">
          {proposedPlanTitle(markdown) ?? gt("Proposed plan")}
        </Text>
        <CopyTextButton accessibilityLabel={gt("Copy plan")} text={contents} />
      </View>
      {props.renderMarkdown(stripDisplayedPlanMarkdown(markdown))}
      <View className="flex-row flex-wrap gap-2">
        {status === "active" && canOperate && !plan.streaming ? (
          <>
            <Button
              size="compact"
              // Notes written earlier are waiting in the review, so that is the way forward.
              tone={hasNotes ? "primary" : "secondary"}
              label={gt("Review")}
              disabled={!draftsLoaded}
              onPress={review}
            />
            <Button
              size="compact"
              tone={hasNotes ? "secondary" : "primary"}
              label={gt("Approve and implement")}
              disabled={!draftsLoaded}
              loading={decision.sending !== null}
              // Those notes ride along with an approval, so the reviewer sees them first.
              onPress={() =>
                hasNotes
                  ? review()
                  : void decision.decide({
                      planId: plan.planId,
                      planMarkdown: markdown,
                      draft,
                      decision: "approve",
                    })
              }
            />
          </>
        ) : null}
        <Button
          size="compact"
          tone="text"
          label={saving ? gt("Saving...") : gt("Save to workspace")}
          disabled={!canWrite || !props.workspaceRoot || saving}
          onPress={() =>
            Dialog.prompt({
              title: gt("Save plan to workspace"),
              // The write replaces an existing file, and the RPC has no create-only mode.
              message: gt(
                "Enter a path relative to the thread's workspace. A file already at that path is replaced.",
              ),
              initialValue: lastPath,
              confirmText: gt("Save"),
              onConfirm: (path) => void save(path),
            })
          }
        />
      </View>
    </>
  );
}
