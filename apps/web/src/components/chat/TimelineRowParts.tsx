import { type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { BotAvatar } from "../bots/BotAvatar";
import type { TimelineBot } from "./timelineRowContext";

export const MESSAGE_HEADING_LEVEL = 3;

export function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

/** In a bot conversation, who answers: its face and name over a group, the name alone after. */
export function BotReplyHeading({ bot, groupStart }: { bot: TimelineBot; groupStart: boolean }) {
  if (!groupStart) return <MessageAuthorHeading>{bot.name}</MessageAuthorHeading>;
  return (
    <h3 className="mb-1 flex min-w-0 select-none items-center gap-2 text-sm font-medium text-foreground">
      <BotAvatar bot={bot} size="xs" />
      <span className="min-w-0 truncate">{bot.name}</span>
    </h3>
  );
}

/** A bot's words sit indented under its face; everywhere else children render as they are. */
export function BotReplyIndent({
  bot,
  children,
}: {
  bot: TimelineBot | null;
  children: ReactNode;
}) {
  return bot === null ? children : <div className="ps-7">{children}</div>;
}

export function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
  alwaysVisible = false,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              alwaysVisible && "pointer-events-auto static opacity-100",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}
