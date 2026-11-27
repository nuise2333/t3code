import { diffPlanMarkdown, type PlanDiffLine } from "@t3tools/client-runtime/planReview";
import { useGT } from "gt-react";
import { cn } from "~/lib/utils";

const LINE_CLASS = {
  context: "",
  added: "bg-success/10",
  removed: "bg-destructive/10",
} as const;

const WORD_CLASS = { added: "rounded-xs bg-success/30", removed: "rounded-xs bg-destructive/30" };

const SIGN = { context: " ", added: "+", removed: "−" } as const;

function DiffLine({ line }: { line: PlanDiffLine }) {
  return (
    <div className={cn("flex gap-2 px-3", LINE_CLASS[line.kind])} data-diff-line={line.kind}>
      {/* The plan's own line, the one a note's "Line N" names; a removed line has none. */}
      <span className="w-8 shrink-0 text-end text-muted-foreground tabular-nums select-none">
        {line.kind === "removed" ? null : line.newLine}
      </span>
      <span aria-hidden="true" className="w-3 shrink-0 select-none text-muted-foreground">
        {SIGN[line.kind]}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere">
        {line.kind === "context"
          ? line.text || " "
          : line.segments.map((segment, index) =>
              segment.changed ? (
                // oxlint-disable-next-line react/no-array-index-key -- segments of one line never reorder
                <span key={index} className={WORD_CLASS[line.kind]}>
                  {segment.text}
                </span>
              ) : (
                segment.text || " "
              ),
            )}
      </span>
    </div>
  );
}

/** The plan's Markdown source against the revision it replaced. */
export function PlanDiffView({ previous, current }: { previous: string; current: string }) {
  const gt = useGT();
  const diff = diffPlanMarkdown(previous, current);
  if (diff.added === 0 && diff.removed === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {gt("No changes from the previous revision.")}
      </p>
    );
  }
  return (
    <div className="py-3">
      <p className="px-3 pb-2 text-xs text-muted-foreground">
        {gt("{added} lines added, {removed} removed", {
          added: diff.added,
          removed: diff.removed,
        })}
      </p>
      <div className="font-mono text-xs leading-5" data-testid="plan-diff">
        {diff.lines.map((line) => (
          <DiffLine
            key={`${line.kind}:${line.kind === "added" ? line.newLine : line.oldLine}`}
            line={line}
          />
        ))}
      </div>
    </div>
  );
}
