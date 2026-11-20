import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  BOT_CHANNEL_HISTORY_PAGE,
  BOT_CHANNEL_TEXT_MAX_CHARS,
  type Bot,
  type BotChannelDetail,
  type BotChannelId,
  type BotChannelMessage,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ArrowUpIcon, ChevronDownIcon, ChevronLeftIcon, SettingsIcon } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotChannelDialog } from "./BotChannelDialog";
import {
  CHANNEL_STATUS_LABELS,
  insertMention,
  isAtBottom,
  mentionAt,
  mentionCandidates,
  namesSentence,
  parseMentions,
  retryablePost,
  scrollTopAfterPrepend,
} from "./botChannels.logic";
import { BotAvatar } from "./BotAvatar";
import { BotFaceCluster, reportBotFailure } from "./botShared";

// Unsent text per channel, for this window's lifetime.
const drafts = new Map<string, string>();

export function BotChannelPage({
  environmentId,
  channelId,
}: {
  readonly environmentId: EnvironmentId;
  readonly channelId: BotChannelId;
}) {
  const navigateToMainApp = useNavigateToMainApp();
  const [limit, setLimit] = useState(BOT_CHANNEL_HISTORY_PAGE);
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const detailQuery = useEnvironmentQuery(
    serverEnvironment.botChannelLive({ environmentId, input: { id: channelId, limit } }),
  );
  // A larger page is a new subscription; keep showing the last history until it answers.
  const [kept, setKept] = useState<BotChannelDetail | null>(null);
  if (detailQuery.data !== null && detailQuery.data !== kept) setKept(detailQuery.data);
  const detail = detailQuery.data ?? kept;
  const bots = botsQuery.data?.bots ?? [];
  const channelName = detail ? `#${detail.channel.name}` : "Channel";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Back"
              onClick={() => void navigateToMainApp()}
            >
              <ChevronLeftIcon />
            </Button>
            <h1 className="truncate text-sm font-medium text-muted-foreground">{channelName}</h1>
          </div>
        </WorkspacePageHeader>
        {detail === null ? (
          <p
            className={cn(
              "px-6 py-4 text-sm",
              detailQuery.error ? "text-destructive" : "text-muted-foreground",
            )}
            role={detailQuery.error ? "alert" : "status"}
          >
            {detailQuery.error ?? "Loading channel…"}
          </p>
        ) : (
          <ChannelBody
            key={channelId}
            environmentId={environmentId}
            detail={detail}
            bots={bots}
            onShowEarlier={() => setLimit((current) => current + BOT_CHANNEL_HISTORY_PAGE)}
          />
        )}
      </div>
    </SidebarInset>
  );
}

function ChannelBody({
  environmentId,
  detail,
  bots,
  onShowEarlier,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: BotChannelDetail;
  readonly bots: ReadonlyArray<Bot>;
  readonly onShowEarlier: () => void;
}) {
  const { channel } = detail;
  const canOperate = useAtomValue(serverEnvironment.postToBotChannel.permissionAtom(environmentId));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const history = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const prepend = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const botById = new Map(bots.map((bot) => [bot.id, bot]));
  const members = channel.memberIds.flatMap((id) => {
    const bot = botById.get(id);
    return bot === undefined ? [] : [bot];
  });
  const nameOf = (id: Bot["id"] | null) =>
    (id === null ? undefined : botById.get(id)?.name) ?? "A removed bot";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scroll position is DOM state: after each render, keep the reading position when older rows loaded, or follow new rows when already at the end.
  useLayoutEffect(() => {
    const element = history.current;
    if (element === null) return;
    const pending = prepend.current;
    if (pending !== null) {
      prepend.current = null;
      element.scrollTop = scrollTopAfterPrepend({
        scrollTop: pending.scrollTop,
        previousScrollHeight: pending.scrollHeight,
        scrollHeight: element.scrollHeight,
      });
    } else if (atBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  });

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3">
        <BotFaceCluster memberIds={channel.memberIds} bots={bots} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {members.length > 0 ? members.map((bot) => bot.name).join(", ") : "No members"}
        </span>
        {channel.archived ? null : (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Channel settings"
            disabled={!canOperate}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon />
          </Button>
        )}
      </div>
      {channel.archived ? (
        <p
          className="shrink-0 border-b border-border bg-muted/50 px-6 py-2 text-sm text-muted-foreground"
          role="status"
        >
          Deleted channel. Preview only.
        </p>
      ) : null}
      <div
        ref={history}
        className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
        aria-label="Channel messages"
        onScroll={(event) => {
          atBottom.current = isAtBottom(event.currentTarget);
        }}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
          {detail.hasMore ? (
            <Button
              size="sm"
              variant="outline"
              className="self-center"
              onClick={() => {
                const element = history.current;
                if (element !== null) {
                  prepend.current = {
                    scrollTop: element.scrollTop,
                    scrollHeight: element.scrollHeight,
                  };
                }
                onShowEarlier();
              }}
            >
              Show earlier messages
            </Button>
          ) : null}
          {detail.messages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
              <BotFaceCluster memberIds={channel.memberIds} bots={bots} size="sm" />
              <p>
                {members.length > 0
                  ? "No messages yet. @mention a bot or write to the lead."
                  : "Add bots in channel settings to start work."}
              </p>
            </div>
          ) : (
            detail.messages.map((message) => (
              <ChannelMessage
                key={message.id}
                message={message}
                bot={message.authorBotId === null ? undefined : botById.get(message.authorBotId)}
                authorName={nameOf(message.authorBotId)}
                environmentId={environmentId}
              />
            ))
          )}
          {detail.activeBotIds.length > 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <BotFaceCluster memberIds={detail.activeBotIds} bots={bots} />
              <span>
                {namesSentence(detail.activeBotIds.map(nameOf))}{" "}
                {detail.activeBotIds.length > 1 ? "are" : "is"} working
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-6 pb-4">
        <ChannelActions
          environmentId={environmentId}
          detail={detail}
          members={members}
          nameOf={nameOf}
          canOperate={canOperate}
        />
        <ChannelComposer
          environmentId={environmentId}
          detail={detail}
          members={members}
          canOperate={canOperate}
          onSent={() => {
            atBottom.current = true;
          }}
        />
      </div>
      {settingsOpen ? (
        <BotChannelDialog
          environmentId={environmentId}
          bots={bots}
          channel={channel}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}

function ChannelMessage({
  message,
  bot,
  authorName,
  environmentId,
}: {
  readonly message: BotChannelMessage;
  readonly bot: Bot | undefined;
  readonly authorName: string;
  readonly environmentId: EnvironmentId;
}) {
  if (message.kind === "assigned") {
    return (
      <div
        className="flex items-baseline justify-center gap-2 text-sm text-muted-foreground"
        role="note"
      >
        <span>{message.text}</span>
        {message.status !== null ? (
          <span className="text-xs">{CHANNEL_STATUS_LABELS[message.status]}</span>
        ) : null}
      </div>
    );
  }
  if (message.kind === "user") {
    // Assignment rows already show progress; a post flags only what needs the user.
    const marker =
      message.status === "stopped" || message.status === "failed"
        ? CHANNEL_STATUS_LABELS[message.status]
        : null;
    return (
      <article className="flex flex-col items-end gap-1">
        <header className="flex items-baseline gap-2 text-sm">
          <strong className="font-semibold text-foreground">You</strong>
          {marker !== null ? <span className="text-xs text-muted-foreground">{marker}</span> : null}
        </header>
        <div className="max-w-[85%] rounded-2xl border border-border bg-card px-3.5 py-2 text-sm whitespace-pre-wrap text-foreground">
          {message.text}
        </div>
      </article>
    );
  }
  return (
    <article className="flex gap-3">
      {bot !== undefined ? <BotAvatar bot={bot} /> : <span className="size-7 shrink-0" />}
      <div className="min-w-0 flex-1 space-y-1">
        <header className="text-sm font-semibold text-foreground">{authorName}</header>
        <ChatMarkdown text={message.text} cwd={undefined} environmentId={environmentId} />
      </div>
    </article>
  );
}

function ChannelActions({
  environmentId,
  detail,
  members,
  nameOf,
  canOperate,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: BotChannelDetail;
  readonly members: ReadonlyArray<Bot>;
  readonly nameOf: (id: Bot["id"]) => string;
  readonly canOperate: boolean;
}) {
  const stopChannel = useAtomCommand(serverEnvironment.stopBotChannel, {
    label: "bot channel stop",
  });
  const continuePost = useAtomCommand(serverEnvironment.continueBotChannelPost, {
    label: "bot channel continue",
  });
  const reassignPost = useAtomCommand(serverEnvironment.reassignBotChannelPost, {
    label: "bot channel reassign",
  });
  const [busy, setBusy] = useState(false);
  if (detail.channel.archived) return null;
  const retryable = members.length > 0 ? retryablePost(detail.messages) : null;
  if (detail.busyBotIds.length === 0 && retryable === null) return null;

  const run = async (
    title: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result = await command();
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportBotFailure(title, squashAtomCommandFailure(result));
    }
  };
  const id = detail.channel.id;

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Channel activity">
      {detail.busyBotIds.length > 0 ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!canOperate || busy}
          onClick={() =>
            void run("Could not stop the channel", () =>
              stopChannel({ environmentId, input: { id } }),
            )
          }
        >
          Stop {namesSentence(detail.busyBotIds.map(nameOf))}
        </Button>
      ) : null}
      {retryable !== null ? (
        <>
          <span className="me-auto text-sm text-muted-foreground">
            {retryable.status === "failed" ? "This message failed." : "This message stopped."}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || busy}
            onClick={() =>
              void run("Could not continue the message", () =>
                continuePost({ environmentId, input: { id, messageId: retryable.id } }),
              )
            }
          >
            Continue
          </Button>
          <Menu>
            <MenuTrigger
              render={<Button size="sm" variant="outline" disabled={!canOperate || busy} />}
            >
              Reassign
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {members.map((bot) => (
                <MenuItem
                  key={bot.id}
                  onClick={() =>
                    void run("Could not reassign the message", () =>
                      reassignPost({
                        environmentId,
                        input: { id, messageId: retryable.id, botId: bot.id },
                      }),
                    )
                  }
                >
                  <BotAvatar bot={bot} size="xs" />
                  {bot.name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </>
      ) : null}
    </div>
  );
}

function ChannelComposer({
  environmentId,
  detail,
  members,
  canOperate,
  onSent,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: BotChannelDetail;
  readonly members: ReadonlyArray<Bot>;
  readonly canOperate: boolean;
  readonly onSent: () => void;
}) {
  const { channel } = detail;
  const draftKey = `${environmentId}:${channel.id}`;
  const postToChannel = useAtomCommand(serverEnvironment.postToBotChannel, {
    label: "bot channel post",
  });
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const disabled = channel.archived || members.length === 0 || !canOperate;
  const mention = mentionAt(text, caret);
  const candidates =
    mention === null || mention.start === dismissedAt
      ? []
      : mentionCandidates(members, mention.query);
  const picked = candidates[Math.min(highlight, candidates.length - 1)];

  const change = (next: string, nextCaret: number) => {
    setText(next);
    setCaret(nextCaret);
    setHighlight(0);
    if (next === "") drafts.delete(draftKey);
    else drafts.set(draftKey, next);
  };

  const pick = (bot: Bot) => {
    if (mention === null) return;
    const next = insertMention(text, mention.start, caret, bot.handle);
    change(next.text, next.caret);
    requestAnimationFrame(() => {
      textarea.current?.setSelectionRange(next.caret, next.caret);
      textarea.current?.focus();
    });
  };

  const send = async () => {
    const body = text.trim();
    if (body === "" || sending || disabled) return;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setSending(true);
    const result = await postToChannel({
      environmentId,
      input: { id: channel.id, text: body, recipientIds: parseMentions(body, members) },
    });
    setSending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportBotFailure("Could not send the message", squashAtomCommandFailure(result));
      }
      return;
    }
    change("", 0);
    onSent();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (picked !== undefined && mention !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((current) => (current + step + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(mention.start);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const placeholder = channel.archived
    ? "Deleted channel. Restore it to post."
    : members.length === 0
      ? "Add bots in channel settings to post."
      : `Message #${channel.name}… @mention up to two bots`;

  return (
    <div className="relative">
      {picked !== undefined ? (
        <ul
          role="listbox"
          aria-label="Mention a bot"
          className="absolute bottom-full left-0 z-10 mb-1 flex max-h-56 w-64 flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
        >
          {candidates.map((bot) => (
            <li key={bot.id} role="option" aria-selected={bot.id === picked.id}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm",
                  bot.id === picked.id ? "bg-accent text-accent-foreground" : "hover:bg-accent",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(bot);
                }}
              >
                <BotAvatar bot={bot} size="xs" />
                <span className="truncate">{bot.name}</span>
                <span className="ms-auto text-xs text-muted-foreground">@{bot.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-card p-3 focus-within:ring-1 focus-within:ring-ring focus-within:ring-inset">
        <textarea
          ref={textarea}
          aria-label="Message channel"
          aria-description="Enter to send. Shift Enter for a new line."
          rows={2}
          maxLength={BOT_CHANNEL_TEXT_MAX_CHARS}
          disabled={disabled || sending}
          placeholder={placeholder}
          className="max-h-60 min-h-12 flex-1 resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          value={text}
          onChange={(event) =>
            change(event.target.value, event.target.selectionStart ?? event.target.value.length)
          }
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
        />
        <Button
          size="icon-sm"
          aria-label="Send message"
          disabled={disabled || sending || text.trim() === ""}
          onClick={() => void send()}
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  );
}
