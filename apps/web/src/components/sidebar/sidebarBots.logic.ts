import type { Bot, BotId, BotLastMessage, BotTask } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";
import { hasUnseenCompletion, resolveSidebarRowStatus } from "../Sidebar.logic";

/** What is going on in a bot's own chat and the tasks it is running right now. */
export interface BotSignals {
  readonly waiting: "approval" | "question" | null;
  readonly failed: boolean;
  readonly limited: { readonly until: number | null } | null;
  readonly working: boolean;
  readonly unread: number;
  readonly responded: boolean;
}

export type BotStatus =
  | { readonly kind: "waiting"; readonly reason: "approval" | "question" }
  | { readonly kind: "failed" }
  | { readonly kind: "limited"; readonly until: number | null }
  | { readonly kind: "working" }
  | { readonly kind: "unread"; readonly count: number }
  | { readonly kind: "responded" };

export type BotGroup = "needs-you" | "pinned" | "bots" | "hidden";

/** Short job titles ride beside the name; a sentence-long one stays in settings. */
const ROLE_TAG_MAX_CHARS = 16;
const DAY_MS = 86_400_000;

type ThreadSignalInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "blockedOnThreadWait"
  | "pendingBackgroundTasks"
  | "lastVisitedAt"
>;

/**
 * Reads the bot's chat and its running tasks the way the threads list reads a row.
 * `responded` is a finished run in the chat the user has not opened since.
 */
export function botSignals(input: {
  readonly home: ThreadSignalInput | null;
  readonly tasks: ReadonlyArray<ThreadSignalInput>;
  /** A task the server reports working whose thread this client has not loaded. */
  readonly unloadedTaskWorking: boolean;
  readonly unread: number;
}): BotSignals {
  const threads = input.home === null ? input.tasks : [input.home, ...input.tasks];
  let question = false;
  let approval = false;
  let failed = false;
  let limited: BotSignals["limited"] = null;
  let working = input.unloadedTaskWorking;
  for (const thread of threads) {
    const status = resolveSidebarRowStatus({
      ...thread,
      lastVisitedAt: thread.lastVisitedAt ?? undefined,
    });
    if (status === "input") question = true;
    else if (status === "approval") approval = true;
    else if (status === "failed") failed = true;
    else if (status === "limited" && limited === null) {
      const until = Date.parse(thread.runtime?.usageLimitResetAt ?? "");
      limited = { until: Number.isNaN(until) ? null : until };
    } else if (status === "working" || status === "preparing" || status === "waiting") {
      working = true;
    }
  }
  return {
    waiting: question ? "question" : approval ? "approval" : null,
    failed,
    limited,
    working,
    unread: input.unread,
    responded:
      input.home?.latestRun?.status === "completed" &&
      hasUnseenCompletion({ ...input.home, lastVisitedAt: input.home.lastVisitedAt ?? undefined }),
  };
}

/** The one mark a row shows: waiting on the user outranks everything, since nothing moves until they act. */
export function botStatus(signals: BotSignals): BotStatus | null {
  if (signals.waiting !== null) return { kind: "waiting", reason: signals.waiting };
  if (signals.failed) return { kind: "failed" };
  if (signals.limited !== null) return { kind: "limited", until: signals.limited.until };
  if (signals.working) return { kind: "working" };
  if (signals.unread > 0) return { kind: "unread", count: signals.unread };
  return signals.responded ? { kind: "responded" } : null;
}

export function botStatusLabel(status: BotStatus, now: number): string {
  switch (status.kind) {
    case "waiting":
      return status.reason === "question" ? "Needs your answer" : "Needs approval";
    case "failed":
      return "Last turn failed";
    case "limited":
      return status.until === null
        ? "Usage limit"
        : `Usage limit · resets ${limitResetLabel(status.until, now)}`;
    case "working":
      return "Working";
    case "unread":
      return `${status.count} unread`;
    case "responded":
      return "Responded";
  }
}

function startOfDay(now: number): number {
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
}

const shortDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Today shows the time, yesterday "Yesterday", this week the weekday, older the date. */
export function messageTimeLabel(at: number, now: number): string {
  const today = startOfDay(now);
  if (at >= today) return clockTime(at);
  if (at >= today - DAY_MS) return "Yesterday";
  if (at >= today - 6 * DAY_MS) {
    return new Date(at).toLocaleDateString(undefined, { weekday: "long" });
  }
  return shortDate(at);
}

/** A reset later today shows its time; a later one its date. */
function limitResetLabel(until: number, now: number): string {
  return until < startOfDay(now) + DAY_MS ? clockTime(until) : shortDate(until);
}

/** What sits at the end of the name line: what the user must do, the limit reset, or the time. */
export type BotRowMeta =
  | { readonly kind: "chip"; readonly label: "Review" | "Answer" }
  | { readonly kind: "limit"; readonly label: string }
  | { readonly kind: "time"; readonly label: string };

export function botRowMeta(
  status: BotStatus | null,
  lastMessage: BotLastMessage | undefined,
  now: number,
): BotRowMeta | null {
  if (status?.kind === "waiting") {
    return { kind: "chip", label: status.reason === "question" ? "Answer" : "Review" };
  }
  if (status?.kind === "limited") {
    return {
      kind: "limit",
      label: status.until === null ? "Limit" : limitResetLabel(status.until, now),
    };
  }
  if (lastMessage === undefined) return null;
  const at = Date.parse(lastMessage.at);
  return Number.isNaN(at) ? null : { kind: "time", label: messageTimeLabel(at, now) };
}

export function botPreview(
  bot: Pick<Bot, "paused" | "updatedAt" | "title">,
  lastMessage: BotLastMessage | undefined,
): string {
  if (bot.paused) {
    const since = Date.parse(bot.updatedAt);
    return Number.isNaN(since) ? "Paused" : `Paused since ${shortDate(since)}`;
  }
  if (lastMessage !== undefined) {
    return `${lastMessage.role === "user" ? "You: " : ""}${lastMessage.text}`;
  }
  return bot.title.trim() || "No messages yet";
}

/** The title rides beside the name only when it is short and nothing else is on that line. */
export function botRoleTag(
  bot: Pick<Bot, "title">,
  preview: string,
  meta: BotRowMeta | null,
): string | null {
  const title = bot.title.trim();
  if (title === "" || title === preview || meta !== null) return null;
  return [...title].length <= ROLE_TAG_MAX_CHARS ? title : null;
}

/** When the bot last showed activity, for ordering bots never dragged. */
export function botRecentAt(
  bot: Pick<Bot, "updatedAt">,
  lastMessage: BotLastMessage | undefined,
): number {
  const at = Date.parse(lastMessage?.at ?? bot.updatedAt);
  return Number.isNaN(at) ? 0 : at;
}

/** Dragged bots in their saved order first, then the rest by most recent activity. */
export function orderBots<T extends { readonly id: string }>(
  bots: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
  recentAt: (bot: T) => number,
): ReadonlyArray<T> {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...bots].sort((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank === undefined && rightRank !== undefined) return 1;
    if (rightRank === undefined && leftRank !== undefined) return -1;
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    return recentAt(right) - recentAt(left);
  });
}

/** The saved order after moving `id` just before `before`, or to the end. */
export function moveBot(
  shown: ReadonlyArray<string>,
  id: string,
  before: string | null,
): ReadonlyArray<string> {
  const rest = shown.filter((item) => item !== id);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Where Alt+Arrow moves `id` among its group's rows, or null at the group's edge. */
export function keyboardMoveTarget(
  peers: ReadonlyArray<string>,
  id: string,
  direction: "up" | "down",
): { readonly before: string | null } | null {
  const index = peers.indexOf(id);
  if (index < 0) return null;
  const next = index + (direction === "up" ? -1 : 1);
  if (next < 0 || next >= peers.length) return null;
  return { before: direction === "up" ? (peers[next] ?? null) : (peers[next + 1] ?? null) };
}

export interface BotGroups<T> {
  readonly needsYou: ReadonlyArray<T>;
  readonly pinned: ReadonlyArray<T>;
  readonly bots: ReadonlyArray<T>;
  readonly hidden: ReadonlyArray<T>;
  /** "Bots" is labelled only when a group above it is shown. */
  readonly labelBots: boolean;
}

/** Splits already ordered bots: paused ones are hidden, waiting ones need the user, then pins. */
export function groupBots<T extends { readonly id: string; readonly paused: boolean }>(
  bots: ReadonlyArray<T>,
  pins: ReadonlySet<string>,
  isWaiting: (bot: T) => boolean,
): BotGroups<T> {
  const needsYou: T[] = [];
  const pinned: T[] = [];
  const rest: T[] = [];
  const hidden: T[] = [];
  for (const bot of bots) {
    if (bot.paused) hidden.push(bot);
    else if (isWaiting(bot)) needsYou.push(bot);
    else if (pins.has(bot.id)) pinned.push(bot);
    else rest.push(bot);
  }
  return {
    needsYou,
    pinned,
    bots: rest,
    hidden,
    labelBots: needsYou.length > 0 || pinned.length > 0,
  };
}

/** Every word must match the name, handle, title or last message; a leading @ matches handles. */
export function filterBots<T extends Pick<Bot, "name" | "handle" | "title">>(
  bots: ReadonlyArray<T>,
  query: string,
  lastMessageText: (bot: T) => string = () => "",
): ReadonlyArray<T> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return bots;
  return bots.filter((bot) => {
    const fields = [bot.name, bot.handle, bot.title, lastMessageText(bot)].map((field) =>
      field.toLowerCase(),
    );
    return words.every((word) => {
      const term = word.startsWith("@") ? word.slice(1) : word;
      return fields.some((field) => field.includes(term));
    });
  });
}

/** When each bot was last read on this device, in epoch ms. */
export type BotSeen = Readonly<Record<string, number>>;

/** When the bot's chat last answered: its newest reply, or the end of its latest run. */
export function botLatestReplyAt(
  lastMessage: BotLastMessage | undefined,
  home: Pick<SidebarThreadSummary, "latestRun"> | null,
): number {
  const message = lastMessage?.role === "assistant" ? Date.parse(lastMessage.at) : 0;
  const run = Date.parse(home?.latestRun?.completedAt ?? "");
  return Math.max(Number.isNaN(message) ? 0 : message, Number.isNaN(run) ? 0 : run);
}

/**
 * A reply is unread until the bot's chat is opened. The first time a bot is seen its history
 * counts as read, so a new device does not light up every bot. `next` is the seen map to store
 * when it differs from `seen`.
 */
export function syncBotSeen(input: {
  readonly botIds: ReadonlyArray<BotId>;
  readonly seen: BotSeen;
  readonly openBotId: BotId | null;
  readonly latestReplyAt: (botId: BotId) => number;
}): {
  readonly next: BotSeen;
  readonly changed: boolean;
  readonly unread: ReadonlyMap<BotId, number>;
} {
  const next: Record<string, number> = { ...input.seen };
  const unread = new Map<BotId, number>();
  let changed = false;
  for (const botId of input.botIds) {
    const latest = input.latestReplyAt(botId);
    const seenAt = input.seen[botId];
    if (seenAt === undefined || botId === input.openBotId) {
      if (seenAt !== latest) {
        next[botId] = latest;
        changed = true;
      }
      continue;
    }
    if (latest > seenAt) unread.set(botId, 1);
  }
  return { next, changed, unread };
}

export function markAllBotsRead(
  botIds: ReadonlyArray<BotId>,
  seen: BotSeen,
  latestReplyAt: (botId: BotId) => number,
): BotSeen {
  const next: Record<string, number> = { ...seen };
  for (const botId of botIds) next[botId] = latestReplyAt(botId);
  return next;
}

/** The thread ids of the bot's tasks still running. */
export function runningTaskThreadIds(
  tasks: ReadonlyArray<BotTask>,
  botId: BotId,
): ReadonlyArray<BotTask["threadId"]> {
  return tasks
    .filter(
      (task) => task.botId === botId && (task.status === "working" || task.status === "waiting"),
    )
    .map((task) => task.threadId);
}
