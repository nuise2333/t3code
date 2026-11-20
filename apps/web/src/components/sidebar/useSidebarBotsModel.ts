import type {
  Bot,
  BotId,
  BotLastMessage,
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useQuietThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import { activeBotId } from "../bots/botsPage.logic";
import {
  botLatestReplyAt,
  botSignals,
  markAllBotsRead,
  runningTaskThreadIds,
  syncBotSeen,
  type BotSeen,
  type BotSignals,
} from "./sidebarBots.logic";

// Pins, order and read marks are this device's view of the list.
const SEEN_KEY = "t3code:bots:seen";
const PINS_KEY = "t3code:bots:pinned";
const ORDER_KEY = "t3code:bots:order";
const HIDDEN_OPEN_KEY = "t3code:bots:hidden-open";

const SeenSchema = Schema.Record(Schema.String, Schema.Number);
const IdsSchema = Schema.Array(Schema.String);
const EMPTY_SEEN: BotSeen = {};
const NO_IDS: ReadonlyArray<string> = [];
const NO_BOTS: ReadonlyArray<Bot> = [];

/** When each bot's chat was last read on this device. */
export function useBotSeen() {
  return useLocalStorage(SEEN_KEY, EMPTY_SEEN, SeenSchema);
}

export function useBotPins() {
  return useLocalStorage(PINS_KEY, NO_IDS, IdsSchema);
}

export function useBotOrder() {
  return useLocalStorage(ORDER_KEY, NO_IDS, IdsSchema);
}

export function useHiddenBotsOpen() {
  return useLocalStorage(HIDDEN_OPEN_KEY, false, Schema.Boolean);
}

/** The bots list with what each bot is doing, read from its chat and running tasks. */
export function useSidebarBotsModel(
  environmentId: EnvironmentId,
  openThreadRef: ScopedThreadRef | null,
) {
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const shells = useQuietThreadShells();
  const [seen, setSeen] = useBotSeen();
  const data = botsQuery.data;
  const bots = data?.bots ?? NO_BOTS;

  const lastMessages = new Map<BotId, BotLastMessage>(
    (data?.lastMessages ?? []).map((message) => [message.botId, message]),
  );
  const runningTasks = new Map<BotId, ReadonlyArray<ThreadId>>(
    bots.map((bot) => [bot.id, runningTaskThreadIds(data?.tasks ?? [], bot.id)]),
  );
  const wanted = new Set<ThreadId>();
  for (const bot of bots) {
    if (bot.homeThreadId !== null) wanted.add(bot.homeThreadId);
    for (const threadId of runningTasks.get(bot.id) ?? []) wanted.add(threadId);
  }
  const shellById = new Map<ThreadId, SidebarThreadSummary>();
  for (const shell of shells) {
    if (shell.environmentId === environmentId && wanted.has(shell.id)) {
      shellById.set(shell.id, shell);
    }
  }
  const homeShell = (bot: Bot) =>
    bot.homeThreadId === null ? null : (shellById.get(bot.homeThreadId) ?? null);
  const botById = new Map(bots.map((bot) => [bot.id, bot]));
  const latestReplyAt = (botId: BotId) => {
    const bot = botById.get(botId);
    return bot === undefined ? 0 : botLatestReplyAt(lastMessages.get(botId), homeShell(bot));
  };
  const botIds = bots.map((bot) => bot.id);
  const openBotId = activeBotId(bots, environmentId, openThreadRef);
  const seenSync = syncBotSeen({ botIds, seen, openBotId, latestReplyAt });

  const signals = new Map<BotId, BotSignals>(
    bots.map((bot) => {
      const taskThreads = runningTasks.get(bot.id) ?? [];
      const taskShells = taskThreads.flatMap((threadId) => {
        const shell = shellById.get(threadId);
        return shell === undefined ? [] : [shell];
      });
      return [
        bot.id,
        botSignals({
          home: homeShell(bot),
          tasks: taskShells,
          unloadedTaskWorking: taskShells.length < taskThreads.length,
          unread: seenSync.unread.get(bot.id) ?? 0,
        }),
      ];
    }),
  );

  return {
    botsQuery,
    data,
    bots,
    lastMessages,
    signals,
    openBotId,
    unreadCount: seenSync.unread.size,
    /** Seen marks to store: first sight of a bot, or its chat open now. */
    pendingSeen: seenSync.changed ? seenSync.next : null,
    storeSeen: setSeen,
    markAllRead: () => setSeen(markAllBotsRead(botIds, seen, latestReplyAt)),
  };
}
