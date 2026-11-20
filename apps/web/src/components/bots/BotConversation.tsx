import {
  AuthOrchestrationOperateScope,
  type Bot,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  LeafIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SettingsIcon,
} from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useBotSeen } from "../sidebar/useSidebarBotsModel";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatar, useBotActions } from "./botShared";
import { botSuggestions } from "./botConversation.logic";
import { BotEditorDialog } from "./BotEditorDialog";
import { activeBotId } from "./botsPage.logic";

const NO_BOTS: ReadonlyArray<Bot> = [];

export interface ThreadBot {
  readonly bot: Bot;
  readonly dispatcher: Bot | null;
  /** When the chat was last read before this visit; null on a first visit. */
  readonly unreadAfter: number | null;
}

/** The bot whose own chat this thread is, or null for any other thread. */
export function useThreadBot(threadRef: ScopedThreadRef | null): ThreadBot | null {
  const environmentId = threadRef?.environmentId ?? null;
  const botsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.botsLive({ environmentId, input: {} }),
  );
  const bots = botsQuery.data?.bots ?? NO_BOTS;
  const botId = environmentId === null ? null : activeBotId(bots, environmentId, threadRef);
  const bot = botId === null ? null : (bots.find((candidate) => candidate.id === botId) ?? null);
  const [seen] = useBotSeen();
  // The sidebar marks the open chat read right away, so keep the mark from when it opened.
  const visitKey =
    bot === null || threadRef === null ? null : `${threadRef.environmentId}\0${bot.id}`;
  const [visit, setVisit] = useState<{
    readonly key: string | null;
    readonly unreadAfter: number | null;
  }>({ key: null, unreadAfter: null });
  let unreadAfter = visit.unreadAfter;
  if (visit.key !== visitKey) {
    unreadAfter = bot === null ? null : (seen[bot.id] ?? null);
    setVisit({ key: visitKey, unreadAfter });
  }
  if (bot === null) return null;
  return {
    bot,
    dispatcher: bots.find((candidate) => candidate.dispatcher) ?? null,
    unreadAfter,
  };
}

function TooltipButton({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function useBotEditor(environmentId: EnvironmentId, threadBot: ThreadBot) {
  const [open, setOpen] = useState(false);
  const dialog: ReactNode = open ? (
    <BotEditorDialog
      key={threadBot.bot.id}
      environmentId={environmentId}
      bot={threadBot.bot}
      dispatcher={threadBot.dispatcher}
      onClose={() => setOpen(false)}
    />
  ) : null;
  return { openEditor: () => setOpen(true), dialog };
}

/** The bot chat's header title: who it is (opens settings), pause or resume, and settings. */
export function BotChatCrumb({
  environmentId,
  threadBot,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadBot: ThreadBot;
}) {
  const { bot } = threadBot;
  const { setPaused } = useBotActions(environmentId);
  const { openEditor, dialog } = useBotEditor(environmentId, threadBot);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <TooltipButton label="Profile, instructions and model">
        <button
          type="button"
          aria-label={`${bot.name} settings`}
          onClick={openEditor}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-sm font-medium text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <BotAvatar bot={bot} size="xs" />
          <h2 className="min-w-0 truncate">{bot.name}</h2>
        </button>
      </TooltipButton>
      {bot.paused ? <span className="shrink-0 text-xs text-muted-foreground">Paused</span> : null}
      <TooltipButton
        label={
          bot.paused
            ? "Resume: schedules and messages continue"
            : "Pause: stop work and hold schedules and messages"
        }
      >
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`${bot.paused ? "Resume" : "Pause"} ${bot.name}`}
          aria-pressed={bot.paused}
          disabled={!canOperate}
          onClick={() => void setPaused(bot, !bot.paused)}
        >
          {bot.paused ? <PlayIcon /> : <PauseIcon />}
        </Button>
      </TooltipButton>
      <TooltipButton label="Settings">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`${bot.name} settings`}
          onClick={openEditor}
        >
          <SettingsIcon />
        </Button>
      </TooltipButton>
      {dialog}
    </span>
  );
}

/** An empty bot chat: who it is, three things to ask, and setup shortcuts. */
export function BotWelcome({
  environmentId,
  threadBot,
  onSuggest,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadBot: ThreadBot;
  readonly onSuggest: (text: string) => void;
}) {
  const { bot } = threadBot;
  const navigate = useNavigate();
  const { openEditor, dialog } = useBotEditor(environmentId, threadBot);
  const openDetails = () => void navigate({ to: "/bots", search: { bot: bot.id } });
  return (
    <div className="flex max-w-md flex-col items-center gap-3 text-center">
      <BotAvatar bot={bot} size="xl" />
      <div>
        <h2 className="text-lg font-medium text-foreground">{bot.name} is ready.</h2>
        <p className="text-sm text-muted-foreground">Ask, then watch it work.</p>
      </div>
      <div role="group" aria-label="Suggestions" className="flex flex-col items-stretch gap-1.5">
        {botSuggestions(`${bot.title} ${bot.name}`).map((text) => (
          <Button key={text} variant="outline" size="sm-multiline" onClick={() => onSuggest(text)}>
            {text}
          </Button>
        ))}
      </div>
      <div role="group" aria-label={`Set up ${bot.name}`} className="flex flex-wrap gap-1">
        <Button variant="ghost-muted" size="xs" onClick={openEditor}>
          <PencilIcon />
          Instructions
        </Button>
        <Button variant="ghost-muted" size="xs" onClick={openDetails}>
          <LeafIcon />
          Memory
        </Button>
        <Button variant="ghost-muted" size="xs" onClick={openDetails}>
          <CalendarClockIcon />
          Schedules
        </Button>
      </div>
      {dialog}
    </div>
  );
}
