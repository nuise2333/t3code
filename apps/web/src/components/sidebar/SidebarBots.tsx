import { useAtomValue } from "@effect/atom-react";
import type { Bot, ContextMenuItem, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  EllipsisIcon,
  InfoIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { BotEditorDialog } from "../bots/BotEditorDialog";
import {
  BotAvatar,
  useAddBotTeam,
  useBotActions,
  useBotModelContext,
  useDefaultBotsEnvironmentId,
} from "../bots/botShared";
import {
  BOT_TEAM_TEMPLATES,
  activeBotId,
  filterBots,
  sortBots,
  workingBotIds,
} from "../bots/botsPage.logic";
import { Badge } from "../ui/badge";
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
import {
  SidebarContent,
  SidebarGroup,
  SidebarInput,
  SidebarMenuButton,
  useSidebar,
} from "../ui/sidebar";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

type BotRowAction = "open" | "edit" | "details" | "delete";

const NO_BOTS: ReadonlyArray<Bot> = [];

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

function SidebarBotsEnvironment({
  environmentId,
  activeThreadRef,
}: {
  environmentId: EnvironmentId;
  activeThreadRef: ScopedThreadRef | null;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const canOperate = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const { defaultModel } = useBotModelContext(environmentId, null);
  const data = botsQuery.data;
  const bots = data ? sortBots(data.bots) : NO_BOTS;
  const { addTeam, addingTeam } = useAddBotTeam(environmentId, bots, defaultModel);
  const { busy, openBotChat, removeBot } = useBotActions(environmentId);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ readonly bot: Bot | null } | null>(null);

  const shownBots = filterBots(bots, query);
  const currentBotId = activeBotId(bots, environmentId, activeThreadRef);
  const working = workingBotIds(data?.tasks ?? []);
  const dispatcher = bots.find((bot) => bot.dispatcher) ?? null;
  const canCreate = canOperate && data !== undefined && !addingTeam;

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const runAction = (action: BotRowAction, bot: Bot) => {
    switch (action) {
      case "open":
        closeMobileSidebar();
        void openBotChat(bot);
        return;
      case "edit":
        setEditor({ bot });
        return;
      case "details":
        closeMobileSidebar();
        void navigate({ to: "/bots", search: { bot: bot.id } });
        return;
      case "delete":
        void removeBot(bot);
        return;
    }
  };

  const showRowContextMenu = (bot: Bot, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const items: ContextMenuItem<BotRowAction>[] = [
      { id: "open", label: "Open chat", icon: "message-square", disabled: !canOperate || busy },
      { id: "edit", label: "Edit", icon: "pencil", disabled: !canOperate },
      { id: "details", label: "Details", icon: "settings" },
      {
        id: "delete",
        label: "Delete",
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
                  aria-label="Search bots"
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
              <Menu>
                <MenuTrigger
                  render={<SidebarHeaderIconButton label="New bot" disabled={!canCreate} />}
                >
                  <PlusIcon />
                </MenuTrigger>
                <MenuPopup align="end" className="w-64">
                  <MenuItem onClick={() => setEditor({ bot: null })}>
                    <PlusIcon />
                    New bot
                  </MenuItem>
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
          {botsQuery.error && !data ? (
            <p className="px-2 py-1.5 text-sm text-destructive" role="alert">
              {botsQuery.error}
            </p>
          ) : !data ? (
            <p className="px-2 py-1.5 text-sm text-sidebar-muted-foreground" role="status">
              Loading bots…
            </p>
          ) : bots.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="px-2 pt-2 pb-1.5 text-sm text-sidebar-muted-foreground">No bots yet</p>
              <SidebarMenuButton
                variant="outline"
                disabled={!canCreate}
                onClick={() => setEditor({ bot: null })}
              >
                <PlusIcon />
                <span>New bot</span>
              </SidebarMenuButton>
              {BOT_TEAM_TEMPLATES.map((template) => (
                <SidebarMenuButton
                  key={template.id}
                  disabled={!canCreate}
                  onClick={() => void addTeam(template)}
                >
                  <UsersIcon />
                  <span>Add the {template.name.toLowerCase()}</span>
                </SidebarMenuButton>
              ))}
            </div>
          ) : shownBots.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-sidebar-muted-foreground">No matching bots</p>
          ) : (
            <ul className="flex flex-col gap-px" aria-label="Bots">
              {shownBots.map((bot) => (
                <SidebarBotRow
                  key={bot.id}
                  bot={bot}
                  active={bot.id === currentBotId}
                  working={working.has(bot.id)}
                  canOperate={canOperate}
                  busy={busy}
                  onAction={(action) => runAction(action, bot)}
                  onContextMenu={(position) => showRowContextMenu(bot, position)}
                />
              ))}
            </ul>
          )}
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
    </>
  );
}

function SidebarBotRow({
  bot,
  active,
  working,
  canOperate,
  busy,
  onAction,
  onContextMenu,
}: {
  bot: Bot;
  active: boolean;
  working: boolean;
  canOperate: boolean;
  busy: boolean;
  onAction: (action: BotRowAction) => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}) {
  return (
    <li className="group/bot-row relative list-none">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-busy={busy || undefined}
        onClick={() => onAction("open")}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "flex h-11 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md ps-2 pe-9 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <BotAvatar bot={bot} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{bot.name}</span>
            {bot.dispatcher ? (
              <Badge size="sm" variant="info">
                Dispatcher
              </Badge>
            ) : null}
            {working ? (
              <span
                role="img"
                aria-label="Working"
                className="size-1.5 shrink-0 rounded-full bg-info"
              />
            ) : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            @{bot.handle}
            {bot.title ? ` · ${bot.title}` : ""}
          </span>
        </span>
      </button>
      <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 opacity-0 group-hover/bot-row:opacity-100 group-focus-within/bot-row:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100">
        <Menu>
          <MenuTrigger
            render={
              <Button size="icon-xs" variant="ghost-muted" aria-label={`Actions for ${bot.name}`} />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!canOperate || busy} onClick={() => onAction("open")}>
              <MessageSquareIcon />
              Open chat
            </MenuItem>
            <MenuItem disabled={!canOperate} onClick={() => onAction("edit")}>
              <PencilIcon />
              Edit
            </MenuItem>
            <MenuItem onClick={() => onAction("details")}>
              <InfoIcon />
              Details
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={!canOperate || busy}
              onClick={() => onAction("delete")}
            >
              <Trash2Icon />
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </li>
  );
}
