import type { AgentTeamProgress, AgentTeamTaskRow } from "@t3tools/client-runtime/routing";
import type { ThreadId } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleSlashIcon,
  LoaderCircleIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { AgentElapsed } from "./AgentElapsed";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const STATUS_LABELS: Record<AgentTeamTaskRow["status"], string> = {
  working: "Working",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

function agentTeamTally(progress: AgentTeamProgress): string {
  if (progress.rows.length === 0) return "The lead delegates to members as it plans.";
  return [
    progress.working > 0 ? `${progress.working} working` : null,
    progress.done > 0 ? `${progress.done} done` : null,
    progress.failed > 0 ? `${progress.failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The team the thread leads, above the composer: its name and lead, a tally of delegated tasks,
 * and, expanded, one row per task that opens the member's thread.
 */
export function agentTeamBannerItem(input: {
  readonly name: string;
  readonly summary: string;
  readonly progress: AgentTeamProgress;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem {
  const { progress } = input;
  const ToggleIcon = input.expanded ? ChevronUpIcon : ChevronDownIcon;
  return {
    id: "agent-team",
    variant: "default",
    icon: <UsersIcon />,
    title: `Team ${input.name}`,
    description: `${input.summary} · ${agentTeamTally(progress)}`,
    ...(progress.rows.length === 0
      ? {}
      : {
          actions: (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={input.expanded}
              aria-label={input.expanded ? "Hide team tasks" : "Show team tasks"}
              onClick={input.onToggle}
            >
              <ToggleIcon />
              {progress.rows.length} {progress.rows.length === 1 ? "task" : "tasks"}
            </Button>
          ),
        }),
    ...(input.expanded && progress.rows.length > 0
      ? {
          children: (
            <ComposerBanner.Scroll className="max-h-[min(14rem,30dvh)]">
              <ul aria-label={`Team ${input.name} tasks`} className="grid gap-px">
                {progress.rows.map((row) => (
                  <AgentTeamTaskItem key={row.id} row={row} onOpenThread={input.onOpenThread} />
                ))}
              </ul>
            </ComposerBanner.Scroll>
          ),
        }
      : {}),
  };
}

function AgentTeamTaskItem({
  row,
  onOpenThread,
}: {
  readonly row: AgentTeamTaskRow;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const childThreadId = row.childThreadId;
  const content = (
    <>
      <StatusIcon status={row.status} />
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">{row.member}</span>
      <span className="w-12 shrink-0 text-end text-muted-foreground">
        <AgentElapsed
          agent={{
            status: row.status === "working" ? "running" : "completed",
            startedAt: row.startedAt,
            completedAt: row.completedAt,
          }}
          compact
        />
      </span>
    </>
  );
  const rowClassName =
    "flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-start text-xs";
  return (
    <li>
      {childThreadId === null ? (
        <div className={rowClassName}>{content}</div>
      ) : (
        <button
          type="button"
          className={cn(rowClassName, "cursor-pointer hover:bg-accent focus-visible:bg-accent")}
          aria-label={`${row.title}, ${row.member}, ${STATUS_LABELS[row.status]}. Open its thread`}
          onClick={() => onOpenThread(childThreadId)}
        >
          {content}
        </button>
      )}
    </li>
  );
}

function StatusIcon({ status }: { readonly status: AgentTeamTaskRow["status"] }) {
  const label = STATUS_LABELS[status];
  const className = "size-3.5 shrink-0";
  switch (status) {
    case "working":
      return (
        <LoaderCircleIcon
          aria-label={label}
          className={cn(className, "animate-spin text-info motion-reduce:animate-none")}
        />
      );
    case "done":
      return <CheckIcon aria-label={label} className={cn(className, "text-success")} />;
    case "failed":
      return <XIcon aria-label={label} className={cn(className, "text-destructive-foreground")} />;
    case "stopped":
      return (
        <CircleSlashIcon aria-label={label} className={cn(className, "text-muted-foreground")} />
      );
  }
}
