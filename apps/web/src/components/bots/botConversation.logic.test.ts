import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "../chat/MessagesTimeline.logic";
import { botDayLabel, botSuggestions, decorateBotTimelineRows } from "./botConversation.logic";

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();

function message(
  id: string,
  role: "user" | "assistant",
  createdAt: number,
  grouping: { groupedWithPrevious?: boolean; groupedWithNext?: boolean } = {},
): MessagesTimelineRow {
  const iso = new Date(createdAt).toISOString();
  return {
    kind: "message",
    id,
    createdAt: iso,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      runId: null,
      streaming: false,
      createdAt: iso,
      updatedAt: iso,
    },
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    ...grouping,
  };
}

const work = (id: string): MessagesTimelineRow => ({
  kind: "turn-fold",
  id,
  createdAt: "",
  runId: RunId.make("run"),
  label: "Worked",
  expanded: false,
});

function summary(rows: ReadonlyArray<MessagesTimelineRow>) {
  return rows.map((row) =>
    row.kind === "message"
      ? [
          row.id,
          row.dayDividerAt === undefined ? "" : "day",
          row.unreadDivider === true ? "new" : "",
          row.groupedWithPrevious === true ? "prev" : "",
          row.groupedWithNext === true ? "next" : "",
        ]
          .filter(Boolean)
          .join(" ")
      : row.id,
  );
}

describe("botSuggestions", () => {
  it("matches the bot's role and falls back to general asks", () => {
    expect(botSuggestions("Code reviewer Rex")).toEqual([
      "What can you help me with?",
      "Review the latest changes for bugs.",
      "Explain how this project is structured.",
    ]);
    expect(botSuggestions("Researcher Ada")[1]).toBe(
      "Research the latest news on a topic I care about.",
    );
    expect(botSuggestions(" Pal")).toEqual([
      "What can you help me with?",
      "Remember that I prefer short, direct answers.",
      "Every weekday at 9, send me a summary of what changed.",
    ]);
  });
});

describe("botDayLabel", () => {
  it("names today and yesterday and dates older days", () => {
    const now = at(20, 18);
    const time = (value: number) =>
      new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    expect(botDayLabel(at(20, 15, 4), now)).toBe(`Today ${time(at(20, 15, 4))}`);
    expect(botDayLabel(at(19, 23, 59), now)).toBe(`Yesterday ${time(at(19, 23, 59))}`);
    const older = at(10, 9);
    expect(botDayLabel(older, now)).toBe(
      `${new Date(older).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time(older)}`,
    );
  });
});

describe("decorateBotTimelineRows", () => {
  it("puts day dividers on each day's first message and the unread divider on the first newer reply", () => {
    const rows = [
      message("u1", "user", at(19, 10)),
      work("fold"),
      message("a1", "assistant", at(19, 10, 1)),
      message("u2", "user", at(20, 9)),
      message("a2", "assistant", at(20, 9, 1)),
      message("a3", "assistant", at(20, 9, 2)),
    ];
    expect(summary(decorateBotTimelineRows(rows, at(20, 9, 0)))).toEqual([
      "u1 day",
      "fold",
      "a1",
      "u2 day",
      "a2 new",
      "a3",
    ]);
    expect(summary(decorateBotTimelineRows(rows, null))).not.toContain("a2 new");
  });

  it("splits grouped messages five minutes apart or across a day", () => {
    const rows = [
      message("u1", "user", at(20, 9), { groupedWithNext: true }),
      message("u2", "user", at(20, 9, 4), { groupedWithPrevious: true, groupedWithNext: true }),
      message("u3", "user", at(20, 9, 9), { groupedWithPrevious: true, groupedWithNext: true }),
      message("u4", "user", at(21, 9, 10), { groupedWithPrevious: true }),
    ];
    expect(summary(decorateBotTimelineRows(rows, null))).toEqual([
      "u1 day next",
      "u2 prev",
      "u3",
      "u4 day",
    ]);
  });

  it("keeps rows that need no change", () => {
    const rows = [message("u1", "user", at(20, 9)), message("a1", "assistant", at(20, 9, 1))];
    const decorated = decorateBotTimelineRows(rows, null);
    expect(decorated[0]).not.toBe(rows[0]);
    expect(decorated[1]).toBe(rows[1]);
  });
});
