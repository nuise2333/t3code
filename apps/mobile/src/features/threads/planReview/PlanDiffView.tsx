import { diffPlanMarkdown, type PlanDiffLine } from "@t3tools/client-runtime/planReview";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { useGT } from "../../../i18n/I18nProvider";
import { cn } from "../../../lib/cn";

const LINE_CLASS = { context: "", added: "bg-emerald-500/10", removed: "bg-rose-500/10" } as const;
const WORD_CLASS = { added: "bg-emerald-500/30", removed: "bg-rose-500/30" } as const;
const SIGN = { context: " ", added: "+", removed: "−" } as const;

function DiffLine({ line }: { readonly line: PlanDiffLine }) {
  return (
    <View className={cn("flex-row gap-2 px-3", LINE_CLASS[line.kind])}>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        className="w-3 font-mono text-xs leading-5 text-foreground-muted"
      >
        {SIGN[line.kind]}
      </Text>
      <Text className="min-w-0 flex-1 font-mono text-xs leading-5 text-foreground">
        {line.kind === "context"
          ? line.text || " "
          : line.segments.map((segment, index) =>
              segment.changed ? (
                // oxlint-disable-next-line react/no-array-index-key -- segments of one line never reorder
                <Text key={index} className={WORD_CLASS[line.kind]}>
                  {segment.text}
                </Text>
              ) : (
                segment.text || " "
              ),
            )}
      </Text>
    </View>
  );
}

/** The plan's Markdown source against the revision it replaced. */
export function PlanDiffView(props: { readonly previous: string; readonly current: string }) {
  const gt = useGT();
  const diff = diffPlanMarkdown(props.previous, props.current);
  if (diff.added === 0 && diff.removed === 0) {
    return (
      <Text textRole="footnote" className="text-foreground-muted">
        {gt("No changes from the previous revision.")}
      </Text>
    );
  }
  return (
    <View className="gap-2">
      <Text textRole="caption" className="text-foreground-muted">
        {gt("{added} lines added, {removed} removed", {
          added: diff.added,
          removed: diff.removed,
        })}
      </Text>
      <View className="overflow-hidden rounded-2xl border border-border bg-card py-2">
        {diff.lines.map((line) => (
          <DiffLine
            key={`${line.kind}:${line.kind === "added" ? line.newLine : line.oldLine}`}
            line={line}
          />
        ))}
      </View>
    </View>
  );
}
