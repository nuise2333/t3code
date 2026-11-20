import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";

/** Your messages this close together read as one group. */
const BOT_GROUP_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const SUGGESTION_TOPICS: ReadonlyArray<readonly [RegExp, readonly [string, string]]> = [
  [
    /research|scout|investigat|analy/i,
    [
      "Research the latest news on a topic I care about.",
      "Compare three options and recommend one.",
    ],
  ],
  [
    /writ|draft|post|blog|content|copy/i,
    ["Draft a short post about what I shipped this week.", "Tighten this paragraph for me."],
  ],
  [
    /financ|ledger|budget|money|expens|account/i,
    ["Summarize my spending categories this month.", "Remind me of bills due this week."],
  ],
  [
    /code|review|engineer|dev|bug|test/i,
    ["Review the latest changes for bugs.", "Explain how this project is structured."],
  ],
  [
    /support|help ?desk|customer|inbox|email/i,
    ["Draft a friendly reply to a customer question.", "Sort these messages by urgency."],
  ],
];

const GENERAL_SUGGESTIONS = [
  "Remember that I prefer short, direct answers.",
  "Every weekday at 9, send me a summary of what changed.",
] as const;

/** Three things to ask, matched to what the bot is for (its title and name). */
export function botSuggestions(role: string): ReadonlyArray<string> {
  const matched =
    SUGGESTION_TOPICS.find(([pattern]) => pattern.test(role))?.[1] ?? GENERAL_SUGGESTIONS;
  return ["What can you help me with?", ...matched];
}

function startOfDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today 3:04 PM", "Yesterday 9:12 AM", "Tue, Oct 6 3:04 PM". */
export function botDayLabel(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const date = new Date(at).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${date} ${time}`;
}

type MessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;

/**
 * A bot chat's dividers and grouping: a day divider on the first message of each day, a
 * "New messages" divider on the first reply newer than `unreadAfter`, and your consecutive
 * messages grouped only while they are under five minutes apart on the same day.
 * Rows that need no change keep their identity.
 */
export function decorateBotTimelineRows(
  rows: ReadonlyArray<MessagesTimelineRow>,
  unreadAfter: number | null,
): MessagesTimelineRow[] {
  const breaksBefore = new Set<number>();
  const dayDividerAt = new Map<number, number>();
  let unreadIndex = -1;
  let previousAt: number | null = null;
  rows.forEach((row, index) => {
    if (row.kind !== "message") return;
    const at = Date.parse(row.message.createdAt);
    if (Number.isNaN(at)) return;
    if (previousAt === null || startOfDay(previousAt) !== startOfDay(at)) {
      dayDividerAt.set(index, at);
      breaksBefore.add(index);
    } else if (at - previousAt >= BOT_GROUP_MS) {
      breaksBefore.add(index);
    }
    if (
      unreadIndex < 0 &&
      unreadAfter !== null &&
      row.message.role === "assistant" &&
      at > unreadAfter
    ) {
      unreadIndex = index;
    }
    previousAt = at;
  });
  return rows.map((row, index) => {
    if (row.kind !== "message") return row;
    const day = dayDividerAt.get(index);
    const unread = index === unreadIndex;
    const groupedWithPrevious = row.groupedWithPrevious === true && !breaksBefore.has(index);
    const groupedWithNext = row.groupedWithNext === true && !breaksBefore.has(index + 1);
    if (
      day === undefined &&
      !unread &&
      groupedWithPrevious === (row.groupedWithPrevious === true) &&
      groupedWithNext === (row.groupedWithNext === true)
    ) {
      return row;
    }
    const next: MessageRow = { ...row, groupedWithPrevious, groupedWithNext };
    if (row.continuesSteer === true) next.continuesSteer = groupedWithPrevious;
    if (day !== undefined) next.dayDividerAt = day;
    if (unread) next.unreadDivider = true;
    return next;
  });
}
