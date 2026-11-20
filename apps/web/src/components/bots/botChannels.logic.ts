import type {
  Bot,
  BotChannel,
  BotChannelMessage,
  BotChannelWorkStatus,
  BotId,
} from "@t3tools/contracts";

const MAX_FACES = 4;

/** Up to four faces; more shows three and a "+N" count. */
export function channelFaces<T extends Pick<Bot, "id">>(
  memberIds: ReadonlyArray<BotId>,
  bots: ReadonlyArray<T>,
): { readonly shown: ReadonlyArray<T>; readonly extra: number } {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const members = memberIds.flatMap((id) => {
    const bot = byId.get(id);
    return bot === undefined ? [] : [bot];
  });
  if (members.length <= MAX_FACES) return { shown: members, extra: 0 };
  return { shown: members.slice(0, MAX_FACES - 1), extra: members.length - (MAX_FACES - 1) };
}

/** "A", "A and B", "A, B and C". */
export function namesSentence(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const CHANNEL_STATUS_LABELS: Record<BotChannelWorkStatus, string> = {
  queued: "Queued",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

/** The latest post a member can run again. */
export function retryablePost(
  messages: ReadonlyArray<BotChannelMessage>,
): BotChannelMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.kind === "user" && (message.status === "stopped" || message.status === "failed")) {
      return message;
    }
  }
  return null;
}

const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9-]*)/gi;

/** Members named by `@handle`, in the order they first appear. */
export function parseMentions(
  text: string,
  members: ReadonlyArray<Pick<Bot, "id" | "handle">>,
): ReadonlyArray<BotId> {
  const ids: BotId[] = [];
  for (const match of text.matchAll(MENTION)) {
    const handle = match[2]?.toLowerCase();
    const member = members.find((candidate) => candidate.handle === handle);
    if (member !== undefined && !ids.includes(member.id)) ids.push(member.id);
  }
  return ids;
}

/** The `@partial` word the caret sits at the end of, for autocomplete. */
export function mentionAt(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(before);
  if (match === null) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query: query.toLowerCase() };
}

/** Members whose handle or name starts with the query. */
export function mentionCandidates<T extends Pick<Bot, "handle" | "name">>(
  members: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  return members.filter(
    (member) => member.handle.startsWith(query) || member.name.toLowerCase().startsWith(query),
  );
}

/** Replaces `@partial` at `start..caret` with `@handle ` and returns the new caret. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  handle: string,
): { readonly text: string; readonly caret: number } {
  const inserted = `@${handle} `;
  return {
    text: `${text.slice(0, start)}${inserted}${text.slice(caret)}`,
    caret: start + inserted.length,
  };
}

/** Every word must appear in the channel name; a leading # is ignored. */
export function filterChannels<T extends Pick<BotChannel, "name">>(
  channels: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^#+/, ""))
    .filter(Boolean);
  if (words.length === 0) return channels;
  return channels.filter((channel) => {
    const name = channel.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

/** Within this many pixels of the end counts as reading the newest messages. */
const BOTTOM_SLACK_PX = 32;

export function isAtBottom(element: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  return element.scrollHeight - element.clientHeight - element.scrollTop < BOTTOM_SLACK_PX;
}

/** Where to scroll after older rows were added above, so the rows in view stay put. */
export function scrollTopAfterPrepend(input: {
  readonly scrollTop: number;
  readonly previousScrollHeight: number;
  readonly scrollHeight: number;
}): number {
  return input.scrollTop + (input.scrollHeight - input.previousScrollHeight);
}
