import type { ThreadId } from "@t3tools/contracts";
import { type CouncilSeat, type CouncilStatus, formatCouncilScore } from "@t3tools/shared/council";
import { useGT } from "gt-react";
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

type Translate = ReturnType<typeof useGT>;

function stateLine(gt: Translate, status: CouncilStatus, needsUser: boolean): string {
  const round = status.rounds.length;
  const max = status.maxRounds;
  const lowest = status.lowest === null ? null : formatCouncilScore(status.lowest);
  if (needsUser && status.state !== "limit") return gt("Council needs you");
  switch (status.state) {
    case "accepted":
      return lowest === null ? gt("Accepted") : gt("Accepted at {score}", { score: lowest });
    case "waiting":
      return gt("Council is on");
    case "reviewing":
      return gt("Round {round} of {max} · reviewing", { round, max });
    case "dispatch":
      return gt("Round {round} of {max} · seating reviewers", { round, max });
    case "fixing":
      return gt("Round {round} of {max} · fixing", { round, max });
    case "passed":
      return gt("Passed at {score}", { score: lowest ?? formatCouncilScore(status.target) });
    case "limit":
      return gt("Stopped at round limit ({round} of {max})", { round, max });
  }
}

/**
 * Council above the composer while a cycle has a round or needs the user: where it stands, the
 * lowest score against the target, and, expanded, one row per reviewer of the latest round.
 */
export function councilBannerItem(input: {
  readonly gt: Translate;
  readonly status: CouncilStatus;
  readonly threadIdle: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onAccept: () => void;
  readonly onDismiss?: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ComposerBannerStackItem {
  const { gt, status } = input;
  const needsUser = councilNeedsUser(status, input.threadIdle);
  const target = formatCouncilScore(status.target);
  const seats = status.rounds.at(-1)?.seats ?? [];
  const lowest =
    status.lowest === null
      ? gt("target {target}", { target })
      : status.state === "reviewing"
        ? gt("lowest {lowest} so far / target {target}", {
            lowest: formatCouncilScore(status.lowest),
            target,
          })
        : gt("lowest {lowest} / target {target}", {
            lowest: formatCouncilScore(status.lowest),
            target,
          });
  const ToggleIcon = input.expanded ? ChevronUpIcon : ChevronDownIcon;
  return {
    id: "council",
    variant: needsUser ? "warning" : "default",
    icon: needsUser ? <TriangleAlertIcon /> : <ScaleIcon />,
    title: stateLine(gt, status, needsUser),
    description: needsUser
      ? gt("{lowest}. Reply to keep fixing, lower the target in the Council panel, or accept.", {
          lowest,
        })
      : lowest,
    actions: (
      <>
        {needsUser ? (
          <Button size="xs" variant="ghost" onClick={input.onAccept}>
            {gt("Accept and finish")}
          </Button>
        ) : null}
        {seats.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={input.expanded}
            aria-label={input.expanded ? gt("Hide reviewers") : gt("Show reviewers")}
            onClick={input.onToggle}
          >
            <ToggleIcon />
            {seats.length}
          </Button>
        ) : null}
      </>
    ),
    ...(input.onDismiss ? { onDismiss: input.onDismiss, dismissLabel: gt("Hide Council") } : {}),
    ...(input.expanded && seats.length > 0
      ? {
          children: (
            <ComposerBanner.Scroll className="max-h-[min(14rem,30dvh)]">
              <ul aria-label={gt("Council reviewers")} className="grid gap-px">
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
  const gt = useGT();
  const { seat } = props;
  const reached = seat.score !== null && seat.score >= props.target;
  const icon =
    seat.status === "reviewing" ? (
      <LoaderCircleIcon
        aria-label={gt("Reviewing")}
        className="size-3.5 shrink-0 animate-spin text-info motion-reduce:animate-none"
      />
    ) : reached ? (
      <CheckIcon aria-label={gt("At target")} className="size-3.5 shrink-0 text-success" />
    ) : (
      <CircleIcon
        aria-label={seat.score === null ? gt("No score") : gt("Below target")}
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
        : gt("no score")
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
          aria-label={gt("{lens}: {score}. Open the reviewer's thread", { lens: seat.lens, score })}
          onClick={() => props.onOpenThread(childThreadId)}
        >
          {content}
        </button>
      )}
    </li>
  );
}
