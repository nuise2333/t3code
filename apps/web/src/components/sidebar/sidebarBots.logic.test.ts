import { BotId, type BotLastMessage, NodeId, ThreadId, type BotTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botLatestReplyAt,
  botPreview,
  botRoleTag,
  botRowMeta,
  botSignals,
  botStatus,
  filterBots,
  groupBots,
  keyboardMoveTarget,
  markAllBotsRead,
  messageTimeLabel,
  moveBot,
  orderBots,
  runningTaskThreadIds,
  syncBotSeen,
  type BotSignals,
} from "./sidebarBots.logic";

const NOW = new Date(2026, 10, 20, 15, 0).getTime();
const DAY = 86_400_000;
const iso = (at: number) => new Date(at).toISOString();

type Thread = Parameters<typeof botSignals>[0]["tasks"][number];

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    blockedOnThreadWait: false,
    pendingBackgroundTasks: [],
    lastVisitedAt: iso(NOW - DAY),
    ...overrides,
  } as Thread;
}

const runtime = (status: string, extra: Record<string, unknown> = {}) =>
  ({ status, activeRunId: null, updatedAt: iso(NOW), ...extra }) as Thread["runtime"];
const run = (status: string, completedAt: number | null) =>
  ({
    status,
    completedAt: completedAt === null ? null : iso(completedAt),
    startedAt: null,
    requestedAt: null,
  }) as unknown as Thread["latestRun"];

const quiet: BotSignals = {
  waiting: null,
  failed: false,
  limited: null,
  working: false,
  unread: 0,
  responded: false,
};

describe("botSignals", () => {
  const signals = (home: Thread | null, tasks: Thread[] = [], unloadedTaskWorking = false) =>
    botSignals({ home, tasks, unloadedTaskWorking, unread: 0 });

  it.each([
    ["no chat yet", null, [], quiet],
    ["an idle chat", thread(), [], quiet],
    [
      "a question in a task outranks an approval in the chat",
      thread({ hasPendingApprovals: true }),
      [thread({ hasPendingUserInput: true })],
      { ...quiet, waiting: "question" },
    ],
    ["an approval", thread({ hasPendingApprovals: true }), [], { ...quiet, waiting: "approval" }],
    [
      "a failure the user has not seen",
      thread({ latestRun: run("failed", NOW - 1000), runtime: runtime("failed") }),
      [],
      { ...quiet, failed: true },
    ],
    [
      "a usage limit with its reset",
      thread({
        runtime: runtime("failed", {
          lastErrorClass: "usage_limit",
          usageLimitResetAt: iso(NOW + 3600_000),
        }),
      }),
      [],
      { ...quiet, limited: { until: NOW + 3600_000 } },
    ],
    [
      "a running task",
      thread(),
      [thread({ runtime: runtime("running") })],
      { ...quiet, working: true },
    ],
    [
      "a finished run since the last visit",
      thread({ latestRun: run("completed", NOW - 1000) }),
      [],
      { ...quiet, responded: true },
    ],
  ] as const)("%s", (_label, home, tasks, expected) => {
    expect(signals(home, [...tasks])).toEqual(expected);
  });

  it("counts a working task this client has not loaded", () => {
    expect(signals(null, [], true).working).toBe(true);
  });
});

describe("botStatus", () => {
  it.each([
    [{ ...quiet, waiting: "approval", failed: true, working: true }, "waiting"],
    [{ ...quiet, failed: true, limited: { until: null }, working: true }, "failed"],
    [{ ...quiet, limited: { until: null }, working: true, unread: 2 }, "limited"],
    [{ ...quiet, working: true, unread: 2 }, "working"],
    [{ ...quiet, unread: 2, responded: true }, "unread"],
    [{ ...quiet, responded: true }, "responded"],
  ] as const)("%j shows %s", (signals, kind) => {
    expect(botStatus(signals)?.kind).toBe(kind);
  });

  it("shows nothing when nothing is going on", () => {
    expect(botStatus(quiet)).toBeNull();
  });
});

describe("messageTimeLabel", () => {
  it.each([
    [
      "earlier today",
      NOW - 3600_000,
      new Date(NOW - 3600_000).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    ],
    ["yesterday", NOW - DAY, "Yesterday"],
    [
      "this week",
      NOW - 3 * DAY,
      new Date(NOW - 3 * DAY).toLocaleDateString(undefined, { weekday: "long" }),
    ],
    [
      "older",
      NOW - 10 * DAY,
      new Date(NOW - 10 * DAY).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    ],
  ])("%s", (_label, at, label) => {
    expect(messageTimeLabel(at, NOW)).toBe(label);
  });
});

const lastMessage = (role: "user" | "assistant", text: string, at = NOW): BotLastMessage => ({
  botId: BotId.make("b1"),
  role,
  text,
  at: iso(at),
});

describe("row text", () => {
  const bot = { paused: false, updatedAt: iso(NOW), title: "Reviewer" };

  it.each([
    ["paused", { ...bot, paused: true }, lastMessage("assistant", "Done"), "Paused since"],
    ["the user's message", bot, lastMessage("user", "Fix it"), "You: Fix it"],
    ["the bot's reply", bot, lastMessage("assistant", "Done"), "Done"],
    ["no messages, a title", bot, undefined, "Reviewer"],
    ["no messages, no title", { ...bot, title: " " }, undefined, "No messages yet"],
  ] as const)("previews %s", (_label, row, message, preview) => {
    expect(botPreview(row, message)).toContain(preview);
  });

  it("puts what the user must do, then the limit reset, before the time", () => {
    const message = lastMessage("assistant", "Done", NOW - DAY);
    expect(botRowMeta({ kind: "waiting", reason: "question" }, message, NOW)).toEqual({
      kind: "chip",
      label: "Answer",
    });
    expect(botRowMeta({ kind: "waiting", reason: "approval" }, message, NOW)?.label).toBe("Review");
    expect(botRowMeta({ kind: "limited", until: null }, message, NOW)).toEqual({
      kind: "limit",
      label: "Limit",
    });
    expect(botRowMeta({ kind: "working" }, message, NOW)).toEqual({
      kind: "time",
      label: "Yesterday",
    });
    expect(botRowMeta(null, undefined, NOW)).toBeNull();
  });

  it.each([
    ["a short title alone on the line", "Reviewer", "Hi", null, "Reviewer"],
    ["a title the preview already shows", "Reviewer", "Reviewer", null, null],
    ["a title beside a time", "Reviewer", "Hi", { kind: "time", label: "3:00" }, null],
    ["a sentence-long title", "Reviews every pull request", "Hi", null, null],
  ] as const)("tags %s", (_label, title, preview, meta, tag) => {
    expect(botRoleTag({ title }, preview, meta)).toBe(tag);
  });
});

describe("order and groups", () => {
  const ids = ["a", "b", "c", "d"] as const;
  const bots = ids.map((id) => ({ id, paused: id === "d" }));
  const recent: Record<string, number> = { a: 1, b: 4, c: 3, d: 2 };

  it("puts dragged bots first in their order, the rest newest first", () => {
    expect(orderBots(bots, ["c", "a"], (bot) => recent[bot.id] ?? 0).map((bot) => bot.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it.each([
    [["a", "b", "c"], "c", "a", ["c", "a", "b"]],
    [["a", "b", "c"], "a", null, ["b", "c", "a"]],
    [["a", "b", "c"], "a", "missing", ["b", "c", "a"]],
  ] as const)("moves within %j: %s before %s", (shown, id, before, next) => {
    expect(moveBot(shown, id, before)).toEqual(next);
  });

  it.each([
    ["b", "up", { before: "a" }],
    ["b", "down", { before: null }],
    ["a", "down", { before: "c" }],
    ["a", "up", null],
    ["c", "down", null],
  ] as const)("Alt+Arrow moves %s %s", (id, direction, target) => {
    expect(keyboardMoveTarget(["a", "b", "c"], id, direction)).toEqual(target);
  });

  it("hides paused bots, raises waiting ones above pins, and labels Bots only under another group", () => {
    const groups = groupBots(bots, new Set(["b", "c", "d"]), (bot) => bot.id === "c");
    expect(groups.needsYou.map((bot) => bot.id)).toEqual(["c"]);
    expect(groups.pinned.map((bot) => bot.id)).toEqual(["b"]);
    expect(groups.bots.map((bot) => bot.id)).toEqual(["a"]);
    expect(groups.hidden.map((bot) => bot.id)).toEqual(["d"]);
    expect(groups.labelBots).toBe(true);
    expect(groupBots(bots, new Set(), () => false).labelBots).toBe(false);
  });
});

describe("filterBots", () => {
  const bots = [
    { id: "b1", name: "Builder", handle: "builder", title: "Software engineer" },
    { id: "b2", name: "Reviewer", handle: "rev", title: "Code reviewer" },
  ];
  const lastText = (bot: { id: string }) => (bot.id === "b2" ? "Looks good to merge" : "");

  it.each([
    ["", ["b1", "b2"]],
    ["build", ["b1"]],
    ["@rev", ["b2"]],
    ["CODE", ["b2"]],
    ["engineer builder", ["b1"]],
    ["merge", ["b2"]],
    ["engineer rev", []],
  ])("query %j matches %j", (query, matched) => {
    expect(filterBots(bots, query, lastText).map((bot) => bot.id)).toEqual(matched);
  });
});

describe("seen and unread", () => {
  const [a, b] = [BotId.make("a"), BotId.make("b")];
  const latest: Record<string, number> = { a: 200, b: 100 };
  const latestReplyAt = (id: BotId) => latest[id] ?? 0;

  it("counts first sight as read and stores it", () => {
    const result = syncBotSeen({ botIds: [a, b], seen: {}, openBotId: null, latestReplyAt });
    expect(result.unread.size).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.next).toEqual({ a: 200, b: 100 });
  });

  it("marks a newer reply unread until the bot is opened", () => {
    const seen = { a: 150, b: 100 };
    const closed = syncBotSeen({ botIds: [a, b], seen, openBotId: null, latestReplyAt });
    expect([...closed.unread]).toEqual([[a, 1]]);
    expect(closed.changed).toBe(false);
    const opened = syncBotSeen({ botIds: [a, b], seen, openBotId: a, latestReplyAt });
    expect(opened.unread.size).toBe(0);
    expect(opened.next).toEqual({ a: 200, b: 100 });
  });

  it("marks all read", () => {
    expect(markAllBotsRead([a, b], { a: 0 }, latestReplyAt)).toEqual({ a: 200, b: 100 });
  });

  it("reads the newest reply from the chat's last message or its latest run", () => {
    const run = (completedAt: string | null) => ({ latestRun: { completedAt } }) as never;
    expect(botLatestReplyAt(lastMessage("assistant", "x", 500), run(iso(300)))).toBe(500);
    expect(botLatestReplyAt(lastMessage("user", "x", 500), run(iso(300)))).toBe(300);
    expect(botLatestReplyAt(undefined, null)).toBe(0);
  });
});

describe("runningTaskThreadIds", () => {
  const task = (botId: string, threadId: string, status: BotTask["status"]): BotTask => ({
    threadId: ThreadId.make(threadId),
    taskId: NodeId.make(`node-${threadId}`),
    botId: BotId.make(botId),
    requesterThreadId: ThreadId.make("home"),
    requesterBotId: null,
    title: threadId,
    depth: 1,
    status,
    nudgedAt: null,
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
  });

  it("keeps the bot's working and waiting tasks", () => {
    const tasks = [
      task("a", "t1", "working"),
      task("a", "t2", "waiting"),
      task("a", "t3", "done"),
      task("b", "t4", "working"),
    ];
    expect(runningTaskThreadIds(tasks, BotId.make("a"))).toEqual(["t1", "t2"]);
  });
});
