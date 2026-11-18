import type { ThreadId } from "@t3tools/contracts";
import { type CouncilSeat, type CouncilStatus, formatCouncilScore } from "@t3tools/shared/council";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
  LoaderCircleIcon,
  ScaleIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Whether the lead stopped and the next step is the user's. */
function councilNeedsUser(status: CouncilStatus, threadIdle: boolean): boolean {
  return (
    threadIdle &&
    (status.state === "fixing" || status.state === "dispatch" || status.state === "limit")
  );
}

function stateLine(status: CouncilStatus, needsUser: boolean): string {
  const round = status.rounds.length;
  const lowest = status.lowest === null ? null : formatCouncilScore(status.lowest);
  if (needsUser && status.state !== "limit") return "Council needs you";
  switch (status.state) {
    case "accepted":
      return lowest === null ? "Accepted" : `Accepted at ${lowest}`;
    case "waiting":
      return "Council is on";
    case "reviewing":
      return `Round ${round} of ${status.maxRounds} · reviewing`;
    case "dispatch":
      return `Round ${round} of ${status.maxRounds} · seating reviewers`;
    case "fixing":
      return `Round ${round} of ${status.maxRounds} · fixing`;
    case "passed":
      return `Passed at ${lowest ?? formatCouncilScore(status.target)}`;
    case "limit":
      return `Stopped at round limit (${round} of ${status.maxRounds})`;
  }
}

/**
 * Council above the composer while a cycle has a round or needs the user: where it stands, the
 * lowest score against the target, and, expanded, one row per reviewer of the latest round.
 */
export function councilBannerItem(input: {
  readonly status: CouncilStatus;
  readonly threadIdle: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onAccept: () => void;
  readonly onDismiss?: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem {
  const { status } = input;
  const needsUser = councilNeedsUser(status, input.threadIdle);
  const target = formatCouncilScore(status.target);
  const seats = status.rounds.at(-1)?.seats ?? [];
  const lowest =
    status.lowest === null
      ? `target ${target}`
      : `lowest ${formatCouncilScore(status.lowest)}${status.state === "reviewing" ? " so far" : ""} / target ${target}`;
  const ToggleIcon = input.expanded ? ChevronUpIcon : ChevronDownIcon;
  return {
    id: "council",
    variant: needsUser ? "warning" : "default",
    icon: needsUser ? <TriangleAlertIcon /> : <ScaleIcon />,
    title: stateLine(status, needsUser),
    description: needsUser
      ? `${lowest}. Reply to keep fixing, lower the target in the Council panel, or accept.`
      : lowest,
    actions: (
      <>
        {needsUser ? (
          <Button size="xs" variant="ghost" onClick={input.onAccept}>
            Accept and finish
          </Button>
        ) : null}
        {seats.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={input.expanded}
            aria-label={input.expanded ? "Hide reviewers" : "Show reviewers"}
            onClick={input.onToggle}
          >
            <ToggleIcon />
            {seats.length}
          </Button>
        ) : null}
      </>
    ),
    ...(input.onDismiss ? { onDismiss: input.onDismiss, dismissLabel: "Hide Council" } : {}),
    ...(input.expanded && seats.length > 0
      ? {
          children: (
            <ComposerBanner.Scroll className="max-h-[min(14rem,30dvh)]">
              <ul aria-label="Council reviewers" className="grid gap-px">
                {seats.map((seat) => (
                  <CouncilSeatRow
                    key={seat.taskId}
                    seat={seat}
                    target={status.target}
                    first={status.lenses.find((lens) => lens.lens === seat.lens)?.first ?? null}
                    settled={status.state !== "reviewing"}
                    onOpenThread={input.onOpenThread}
                  />
                ))}
              </ul>
            </ComposerBanner.Scroll>
          ),
        }
      : {}),
  };
}

function CouncilSeatRow(props: {
  readonly seat: CouncilSeat;
  readonly target: number;
  readonly first: number | null;
  readonly settled: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { seat } = props;
  const reached = seat.score !== null && seat.score >= props.target;
  const icon =
    seat.status === "reviewing" ? (
      <LoaderCircleIcon
        aria-label="Reviewing"
        className="size-3.5 shrink-0 animate-spin text-info motion-reduce:animate-none"
      />
    ) : reached ? (
      <CheckIcon aria-label="At target" className="size-3.5 shrink-0 text-success" />
    ) : (
      <CircleIcon
        aria-label={seat.score === null ? "No score" : "Below target"}
        className={cn(
          "size-3.5 shrink-0",
          seat.score === null ? "text-muted-foreground" : "text-warning",
        )}
      />
    );
  const score =
    seat.score === null
      ? seat.status === "reviewing"
        ? "…"
        : "no score"
      : props.settled && props.first !== null && props.first !== seat.score
        ? `${formatCouncilScore(props.first)} → ${formatCouncilScore(seat.score)}`
        : formatCouncilScore(seat.score);
  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{seat.lens}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">{score}</span>
    </>
  );
  const rowClassName =
    "flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-start text-xs";
  const childThreadId = seat.childThreadId as ThreadId | null;
  return (
    <li>
      {childThreadId === null ? (
        <div className={rowClassName}>{content}</div>
      ) : (
        <button
          type="button"
          className={cn(rowClassName, "cursor-pointer hover:bg-accent focus-visible:bg-accent")}
          aria-label={`${seat.lens}: ${score}. Open the reviewer's thread`}
          onClick={() => props.onOpenThread(childThreadId)}
        >
          {content}
        </button>
      )}
    </li>
  );
}
