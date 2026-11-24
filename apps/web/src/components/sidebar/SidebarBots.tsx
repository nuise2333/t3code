import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  MAX_BOTS,
  type Bot,
  type BotChannel,
  type BotLastMessage,
  type ContextMenuItem,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  EllipsisIcon,
  HashIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { readLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotChannelDialog } from "../bots/BotChannelDialog";
import { BotEditorDialog } from "../bots/BotEditorDialog";
import { filterChannels } from "../bots/botChannels.logic";
import { BotAvatar } from "../bots/BotAvatar";
import {
  BotFaceCluster,
  reportBotFailure,
  useAddBotTeam,
  useBotActions,
  useBotModelContext,
  useDefaultBotsEnvironmentId,
} from "../bots/botShared";
import { BOT_TEAM_TEMPLATES } from "../bots/botsPage.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarContent, SidebarGroup, SidebarInput, useSidebar } from "../ui/sidebar";
import { takeBotsSearchFocusRequest } from "./sidebarMode";
import {
  botPreview,
  botRecentAt,
  botRoleTag,
  botRowMeta,
  botStatus,
  botStatusLabel,
  filterBots,
  groupBots,
  keyboardMoveTarget,
  moveBot,
  orderBots,
  type BotGroup,
  type BotRowMeta,
  type BotStatus,
} from "./sidebarBots.logic";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import {
  useBotOrder,
  useBotPins,
  useHiddenBotsOpen,
  useSidebarBotsModel,
} from "./useSidebarBotsModel";

type BotMenuAction = "pin" | "edit" | "duplicate" | "details" | "hide" | "delete";
type ChannelMenuAction = "edit" | "delete" | "restore";
const NO_CHANNELS: ReadonlyArray<BotChannel> = [];

const SKELETON_ROWS = 3;

export function SidebarBots({ activeThreadRef }: { activeThreadRef: ScopedThreadRef | null }) {
  const environmentId = useDefaultBotsEnvironmentId();
  if (environmentId === null) {
    return (
      <SidebarContent>
        <SidebarGroup>
          <p className="px-2 py-1.5 text-sm text-sidebar-muted-foreground">
            Connect an environment to use bots.
          </p>
        </SidebarGroup>
      </SidebarContent>
    );
  }
  return (
    <SidebarBotsEnvironment
      key={environmentId}
      environmentId={environmentId}
      activeThreadRef={activeThreadRef}
    />
  );
}

interface CreateMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly run: () => void;
}

function SidebarBotsEnvironment({
  environmentId,
  activeThreadRef,
}: {
  environmentId: EnvironmentId;
  activeThreadRef: ScopedThreadRef | null;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const model = useSidebarBotsModel(environmentId, activeThreadRef);
  const { data, bots, lastMessages, signals, openBotId } = model;
  const canOperate = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const { defaultModel } = useBotModelContext(environmentId, null);
  const { addTeam, addingTeam } = useAddBotTeam(environmentId, bots, defaultModel);
  const { busy, openBotChat, removeBot, setPaused, duplicateBot } = useBotActions(environmentId);
  const [pins, setPins] = useBotPins();
  const [order, setOrder] = useBotOrder();
  const [hiddenOpen, setHiddenOpen] = useHiddenBotsOpen();
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editor, setEditor] = useState<{ readonly bot: Bot | null } | null>(null);
  const [channelEditor, setChannelEditor] = useState<{
    readonly channel: BotChannel | null;
  } | null>(null);
  const archiveChannel = useAtomCommand(serverEnvironment.archiveBotChannel, {
    label: "bot channel archive",
  });
  const routeParams = useParams({ strict: false });
  const openChannelId =
    routeParams.environmentId === environmentId ? (routeParams.channelId ?? null) : null;
  const [dragging, setDragging] = useState<{ id: string; group: BotGroup } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const now = Date.parse(useNowMinute());
  const rowButtons = new Map<string, HTMLButtonElement>();

  const dispatcher = bots.find((bot) => bot.dispatcher) ?? null;
  const canCreate = canOperate && data !== undefined && !addingTeam;
  const pinSet = new Set(pins);
  const lastMessageOf = (bot: Bot): BotLastMessage | undefined => lastMessages.get(bot.id);
  const statusOf = (bot: Bot): BotStatus | null => {
    const botSignals = signals.get(bot.id);
    return botSignals === undefined ? null : botStatus(botSignals);
  };
  const ordered = orderBots(bots, order, (bot) => botRecentAt(bot, lastMessageOf(bot)));
  const shown = filterBots(ordered, query, (bot) => lastMessageOf(bot)?.text ?? "");
  const groups = groupBots(shown, pinSet, (bot) => signals.get(bot.id)?.waiting != null);
  const channels = data?.channels ?? NO_CHANNELS;
  const shownChannels = filterChannels(channels, query);
  const activeChannels = shownChannels.filter((channel) => !channel.archived);
  const deletedChannels = shownChannels.filter((channel) => channel.archived);
  const showHidden = hiddenOpen || groups.hidden.some((bot) => bot.id === openBotId);
  const orderedIds = ordered.map((bot) => bot.id);

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const createEntries: ReadonlyArray<CreateMenuEntry> = [
    { id: "bot", label: "New bot", icon: <PlusIcon />, run: () => setEditor({ bot: null }) },
    {
      id: "channel",
      label: "New channel",
      icon: <HashIcon />,
      run: () => setChannelEditor({ channel: null }),
    },
  ];

  const openChannel = (channel: Pick<BotChannel, "id">) => {
    closeMobileSidebar();
    void navigate({
      to: "/bots/channels/$environmentId/$channelId",
      params: { environmentId, channelId: channel.id },
    });
  };

  const setChannelArchived = async (channel: BotChannel, archived: boolean) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = await archiveChannel({ environmentId, input: { id: channel.id, archived } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportBotFailure(
        `Could not ${archived ? "delete" : "restore"} #${channel.name}`,
        squashAtomCommandFailure(result),
      );
    }
  };

  const showChannelMenu = (channel: BotChannel, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<ChannelMenuAction>[] = channel.archived
      ? [{ id: "restore", label: "Restore", icon: "refresh-cw", disabled: !canOperate }]
      : [
          { id: "edit", label: "Edit", icon: "pencil", disabled: !canOperate },
          {
            id: "delete",
            label: "Delete",
            icon: "trash",
            destructive: true,
            disabled: !canOperate,
          },
        ];
    void api.contextMenu.show(items, position).then((action) => {
      if (action === "edit") setChannelEditor({ channel });
      else if (action === "delete" || action === "restore") {
        void setChannelArchived(channel, action === "delete");
      }
    });
  };

  const renderChannelRows = (list: ReadonlyArray<BotChannel>) =>
    list.map((channel) => (
      <SidebarChannelRow
        key={channel.id}
        channel={channel}
        bots={bots}
        active={channel.id === openChannelId}
        onOpen={() => openChannel(channel)}
        onMenu={(position) => showChannelMenu(channel, position)}
      />
    ));

  const setPinned = (bot: Bot, pinned: boolean) =>
    setPins((current) => [...current.filter((id) => id !== bot.id), ...(pinned ? [bot.id] : [])]);

  const runAction = (action: BotMenuAction, bot: Bot) => {
    switch (action) {
      case "pin":
        setPinned(bot, !pinSet.has(bot.id));
        return;
      case "edit":
        setEditor({ bot });
        return;
      case "duplicate":
        void duplicateBot(bot);
        return;
      case "details":
        closeMobileSidebar();
        void navigate({ to: "/bots", search: { bot: bot.id } });
        return;
      case "hide":
        void setPaused(bot, !bot.paused);
        return;
      case "delete":
        void removeBot(bot).then((deleted) => {
          if (deleted) setPinned(bot, false);
        });
        return;
    }
  };

  const showBotMenu = (bot: Bot, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const pinned = pinSet.has(bot.id);
    const items: ContextMenuItem<BotMenuAction>[] = [
      { id: "pin", label: pinned ? "Unpin" : "Pin", icon: pinned ? "pin-off" : "pin" },
      { id: "edit", label: "Edit bot", icon: "pencil", disabled: !canOperate },
      {
        id: "duplicate",
        label: "Duplicate bot",
        icon: "copy",
        disabled: !canOperate || bots.length >= MAX_BOTS,
      },
      { id: "details", label: "Details", icon: "settings" },
      {
        id: "hide",
        label: bot.paused ? "Restore" : "Hide (pause)",
        icon: bot.paused ? "refresh-cw" : "archive",
        disabled: !canOperate,
      },
      {
        id: "delete",
        label: "Delete bot…",
        icon: "trash",
        destructive: true,
        separatorBefore: true,
        disabled: !canOperate || busy,
      },
    ];
    void api.contextMenu.show(items, position).then((action) => {
      if (action) runAction(action, bot);
    });
  };

  const moveTo = (id: string, before: string | null) => {
    flushSync(() => setOrder(moveBot(orderedIds, id, before)));
  };

  const onRowKeyDown = (event: KeyboardEvent, bot: Bot, group: BotGroup, peers: Bot[]) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    if (group !== "pinned" && group !== "bots") return;
    const direction = event.key === "ArrowUp" ? "up" : "down";
    const target = keyboardMoveTarget(
      peers.map((peer) => peer.id),
      bot.id,
      direction,
    );
    if (target === null) return;
    event.preventDefault();
    moveTo(bot.id, target.before);
    setAnnouncement(
      `Moved ${bot.name} ${direction} within ${group === "pinned" ? "Pinned" : "Bots"}.`,
    );
    rowButtons.get(bot.id)?.focus();
  };

  const dragProps = (bot: Bot, group: BotGroup) => {
    const draggable = group === "pinned" || group === "bots";
    return {
      draggable,
      onDragStart: (event: DragEvent) => {
        if (!draggable) return;
        setDragging({ id: bot.id, group });
        event.dataTransfer.setData("text/plain", bot.id);
        event.dataTransfer.effectAllowed = "move";
      },
      onDragOver: (event: DragEvent) => {
        if (dragging === null || dragging.group !== group) return;
        event.preventDefault();
        if (dragOver !== bot.id) setDragOver(bot.id);
      },
      onDragLeave: () => {
        if (dragOver === bot.id) setDragOver(null);
      },
      onDrop: (event: DragEvent) => {
        if (dragging === null || dragging.group !== group) return;
        event.preventDefault();
        if (dragging.id !== bot.id) setOrder(moveBot(orderedIds, dragging.id, bot.id));
        setDragging(null);
        setDragOver(null);
      },
      onDragEnd: () => {
        setDragging(null);
        setDragOver(null);
      },
    };
  };

  const renderRows = (list: ReadonlyArray<Bot>, group: BotGroup) =>
    list.map((bot) => {
      const status = statusOf(bot);
      const lastMessage = lastMessageOf(bot);
      const preview = botPreview(bot, lastMessage);
      const meta = botRowMeta(status, lastMessage, now);
      const state = [bot.paused ? "paused" : "", status ? botStatusLabel(status, now) : ""]
        .filter(Boolean)
        .join(", ");
      return (
        <SidebarBotRow
          key={bot.id}
          bot={bot}
          status={status}
          now={now}
          meta={meta}
          preview={preview}
          roleTag={botRoleTag(bot, preview, meta)}
          stateLabel={state}
          active={bot.id === openBotId}
          dragOver={dragOver === bot.id}
          buttonRef={(button) => {
            if (button) rowButtons.set(bot.id, button);
            else rowButtons.delete(bot.id);
          }}
          dragProps={dragProps(bot, group)}
          onOpen={() => {
            closeMobileSidebar();
            void openBotChat(bot);
          }}
          onSettings={() => setEditor({ bot })}
          onMenu={(position) => showBotMenu(bot, position)}
          onKeyDown={(event) => onRowKeyDown(event, bot, group, [...list])}
        />
      );
    });

  return (
    <>
      <SidebarContent
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex items-center gap-1">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70">
                <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                <SidebarInput
                  nativeInput
                  ref={(input: HTMLInputElement | null) => {
                    if (input && takeBotsSearchFocusRequest()) input.focus();
                  }}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query !== "") {
                      event.preventDefault();
                      setQuery("");
                    }
                  }}
                  placeholder="Search"
                  aria-label="Search bots and channels"
                  className="min-w-0 flex-1"
                />
                {query !== "" ? (
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    className="shrink-0"
                    aria-label="Clear bot search"
                    onClick={() => setQuery("")}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
              {model.unreadCount > 0 ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="shrink-0"
                  onClick={model.markAllRead}
                >
                  Mark all read
                </Button>
              ) : null}
              <Menu open={createOpen} onOpenChange={setCreateOpen}>
                <MenuTrigger
                  render={<SidebarHeaderIconButton label="New bot" disabled={!canCreate} />}
                >
                  <PlusIcon />
                </MenuTrigger>
                <MenuPopup align="end" className="w-64">
                  {createEntries.map((entry) => (
                    <MenuItem key={entry.id} onClick={entry.run}>
                      {entry.icon}
                      {entry.label}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Add a team</MenuGroupLabel>
                    {BOT_TEAM_TEMPLATES.map((template) => (
                      <MenuItem key={template.id} onClick={() => void addTeam(template)}>
                        <UsersIcon />
                        <div className="flex min-w-0 flex-col">
                          <span>{template.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {template.description}
                          </span>
                        </div>
                      </MenuItem>
                    ))}
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            </div>
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1">
          {model.botsQuery.error && !data ? (
            <p className="px-2 py-1.5 text-sm text-destructive" role="alert">
              {model.botsQuery.error}
            </p>
          ) : !data ? (
            <div className="flex flex-col gap-px" role="status" aria-label="Loading bots">
              {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                <span key={index} aria-hidden className="flex h-13 items-center gap-2.5 px-2">
                  <span className="size-9 shrink-0 rounded-full bg-sidebar-row-active" />
                  <span className="flex flex-1 flex-col gap-2">
                    <span className="h-2 w-1/2 rounded-sm bg-sidebar-row-active" />
                    <span className="h-2 w-5/6 rounded-sm bg-sidebar-row-active" />
                  </span>
                </span>
              ))}
            </div>
          ) : bots.length === 0 && channels.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-2 py-6 text-sm text-sidebar-muted-foreground">
              <p>No bots yet</p>
              <Button
                type="button"
                variant="outline"
                disabled={!canCreate}
                onClick={() => setCreateOpen(true)}
              >
                <PlusIcon />
                New bot or channel
              </Button>
            </div>
          ) : shown.length === 0 && shownChannels.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-sidebar-muted-foreground">
              No bots or channels match.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {groups.needsYou.length > 0 ? (
                <BotsGroup label="Needs you" showLabel>
                  {renderRows(groups.needsYou, "needs-you")}
                </BotsGroup>
              ) : null}
              {groups.pinned.length > 0 ? (
                <BotsGroup label="Pinned" showLabel>
                  {renderRows(groups.pinned, "pinned")}
                </BotsGroup>
              ) : null}
              {groups.bots.length > 0 ? (
                <BotsGroup label="Bots" showLabel={groups.labelBots}>
                  {renderRows(groups.bots, "bots")}
                </BotsGroup>
              ) : null}
              {groups.hidden.length > 0 ? (
                <div role="group" aria-label="Hidden">
                  <button
                    type="button"
                    aria-expanded={showHidden}
                    onClick={() => setHiddenOpen(!showHidden)}
                    className="mx-2 mt-1 mb-0.5 flex h-6 items-center gap-1 rounded-sm text-xs font-semibold text-sidebar-muted-foreground hover:text-sidebar-foreground"
                  >
                    <ChevronRightIcon className={cn("size-3", showHidden && "rotate-90")} />
                    Hidden ({groups.hidden.length})
                  </button>
                  {showHidden ? (
                    <ul className="flex flex-col gap-px">{renderRows(groups.hidden, "hidden")}</ul>
                  ) : null}
                </div>
              ) : null}
              {activeChannels.length > 0 ? (
                <BotsGroup label="Channels" showLabel>
                  {renderChannelRows(activeChannels)}
                </BotsGroup>
              ) : null}
              {deletedChannels.length > 0 ? (
                <BotsGroup label="Deleted channels" showLabel>
                  {renderChannelRows(deletedChannels)}
                </BotsGroup>
              ) : null}
            </div>
          )}
          <span className="sr-only" aria-live="polite">
            {announcement}
          </span>
        </SidebarGroup>
      </SidebarContent>
      {editor !== null ? (
        <BotEditorDialog
          key={editor.bot?.id ?? "new"}
          environmentId={environmentId}
          bot={editor.bot}
          dispatcher={dispatcher}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {channelEditor !== null ? (
        <BotChannelDialog
          key={channelEditor.channel?.id ?? "new"}
          environmentId={environmentId}
          bots={bots}
          channel={channelEditor.channel}
          onClose={() => setChannelEditor(null)}
          onCreated={openChannel}
        />
      ) : null}
    </>
  );
}

function SidebarChannelRow({
  channel,
  bots,
  active,
  onOpen,
  onMenu,
}: {
  channel: BotChannel;
  bots: ReadonlyArray<Bot>;
  active: boolean;
  onOpen: () => void;
  onMenu: (position: { x: number; y: number }) => void;
}) {
  return (
    <li className="group/channel-row relative list-none rounded-md">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`#${channel.name}`}
        onClick={(event) => {
          if (event.button === 0) onOpen();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md ps-2 pe-8 text-left text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
          channel.archived && "text-sidebar-muted-foreground",
        )}
      >
        <BotFaceCluster memberIds={channel.memberIds} bots={bots} />
        <span className="min-w-0 truncate">#{channel.name}</span>
      </button>
      <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 opacity-0 group-hover/channel-row:opacity-100 group-focus-within/channel-row:opacity-100 pointer-coarse:opacity-100">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Actions for #${channel.name}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <EllipsisIcon />
        </Button>
      </span>
    </li>
  );
}

function BotsGroup({
  label,
  showLabel,
  children,
}: {
  label: string;
  showLabel: boolean;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label}>
      {showLabel ? (
        <h3
          aria-hidden
          className="mx-2 mt-1 mb-0.5 text-xs font-semibold text-sidebar-muted-foreground"
        >
          {label}
        </h3>
      ) : null}
      <ul className="flex flex-col gap-px">{children}</ul>
    </div>
  );
}

const BADGE_CLASS: Record<BotStatus["kind"], string> = {
  waiting: "bg-warning text-background",
  failed: "bg-destructive text-background",
  limited: "bg-sidebar-control-surface text-warning-foreground",
  working: "bg-info text-background",
  unread: "bg-primary text-primary-foreground",
  responded: "bg-success text-background",
};

function BotStatusBadge({ status, now }: { status: BotStatus; now: number }) {
  return (
    <span
      role="img"
      aria-label={botStatusLabel(status, now)}
      className={cn(
        "absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center gap-0.5 rounded-full px-1 text-xs leading-none font-semibold tabular-nums ring-2 ring-sidebar [&>svg]:size-2.5",
        BADGE_CLASS[status.kind],
      )}
    >
      {status.kind === "waiting" ? (
        "!"
      ) : status.kind === "failed" ? (
        <AlertTriangleIcon />
      ) : status.kind === "limited" ? (
        <ClockIcon />
      ) : status.kind === "working" ? (
        // Static dots: a looping animation repaints on every frame.
        <>
          <span className="size-0.5 rounded-full bg-current" />
          <span className="size-0.5 rounded-full bg-current" />
          <span className="size-0.5 rounded-full bg-current" />
        </>
      ) : status.kind === "unread" ? (
        Math.min(status.count, 99)
      ) : (
        <CheckIcon />
      )}
    </span>
  );
}

function SidebarBotRow({
  bot,
  status,
  now,
  meta,
  preview,
  roleTag,
  stateLabel,
  active,
  dragOver,
  buttonRef,
  dragProps,
  onOpen,
  onSettings,
  onMenu,
  onKeyDown,
}: {
  bot: Bot;
  status: BotStatus | null;
  now: number;
  meta: BotRowMeta | null;
  preview: string;
  roleTag: string | null;
  stateLabel: string;
  active: boolean;
  dragOver: boolean;
  buttonRef: (button: HTMLButtonElement | null) => void;
  dragProps: Pick<
    React.ComponentProps<"li">,
    "draggable" | "onDragStart" | "onDragOver" | "onDragLeave" | "onDrop" | "onDragEnd"
  >;
  onOpen: () => void;
  onSettings: () => void;
  onMenu: (position: { x: number; y: number }) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  return (
    <li
      className={cn(
        "group/bot-row relative list-none rounded-md",
        dragOver && "ring-1 ring-inset ring-ring",
      )}
      {...dragProps}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`Chat with ${bot.name}${stateLabel ? ` (${stateLabel})` : ""}`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={(event) => {
          if (event.button === 0) onOpen();
        }}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex min-h-13 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md py-1.5 ps-2 pe-2 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <span className={cn("relative shrink-0", bot.paused && "opacity-50 grayscale")}>
          <BotAvatar bot={bot} size="md" />
          {status !== null ? <BotStatusBadge status={status} now={now} /> : null}
        </span>
        <span
          className={cn(
            "flex min-w-0 flex-1 flex-col gap-px",
            bot.paused && "opacity-50 grayscale",
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 shrink truncate text-sm font-semibold text-foreground">
              {bot.name}
            </span>
            {roleTag !== null ? (
              <span className="min-w-0 truncate rounded-sm bg-sidebar-row-active px-1 text-xs text-sidebar-muted-foreground group-hover/bot-row:invisible group-focus-within/bot-row:invisible">
                {roleTag}
              </span>
            ) : null}
            {meta !== null ? <BotRowMetaLabel meta={meta} /> : null}
          </span>
          <span
            className={cn("block truncate text-xs text-muted-foreground", bot.paused && "italic")}
          >
            {preview}
          </span>
        </span>
      </button>
      <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 gap-0.5 opacity-0 group-hover/bot-row:opacity-100 group-focus-within/bot-row:opacity-100 pointer-coarse:opacity-100">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Actions for ${bot.name}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          <EllipsisIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`${bot.name} settings`}
          onClick={onSettings}
        >
          <SettingsIcon />
        </Button>
      </span>
    </li>
  );
}

function BotRowMetaLabel({ meta }: { meta: BotRowMeta }) {
  const hideOnHover = "group-hover/bot-row:invisible group-focus-within/bot-row:invisible";
  if (meta.kind === "chip") {
    return (
      <span
        className={cn(
          "ms-auto shrink-0 rounded-full bg-warning/16 px-1.5 text-xs font-semibold text-warning-foreground",
          hideOnHover,
        )}
      >
        {meta.label}
      </span>
    );
  }
  if (meta.kind === "limit") {
    return (
      <span
        className={cn(
          "ms-auto inline-flex shrink-0 items-center gap-0.5 rounded-full bg-sidebar-row-active px-1.5 text-xs font-semibold text-warning-foreground tabular-nums",
          hideOnHover,
        )}
      >
        <ClockIcon className="size-3" />
        {meta.label}
      </span>
    );
  }
  return (
    <time
      className={cn(
        "ms-auto shrink-0 text-xs text-sidebar-muted-foreground tabular-nums",
        hideOnHover,
      )}
    >
      {meta.label}
    </time>
  );
}
