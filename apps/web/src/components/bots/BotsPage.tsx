import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  MAX_BOT_MEMORIES,
  BOT_MEMORY_MAX_CHARS,
  type Bot,
  type BotMemory,
  type BotTask,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { type ProviderInstanceEntry } from "../../providerInstances";
import { useConnectedEnvironmentIds, useEnvironments } from "../../state/environments";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotEditorDialog } from "./BotEditorDialog";
import {
  BotAvatar,
  reportBotFailure,
  useAddBotTeam,
  useBotActions,
  useBotModelContext,
  useDefaultBotsEnvironmentId,
} from "./botShared";
import {
  BOT_TASK_STATUS_LABELS,
  BOT_TEAM_TEMPLATES,
  botModelLabel,
  botSchedules,
  botTaskStatusVariant,
  memoriesForBot,
  sortBots,
  tasksByBot,
} from "./botsPage.logic";

const RECENT_TASK_LIMIT = 10;
export function BotsPage({ selectedBotId }: { readonly selectedBotId: Bot["id"] | null }) {
  const navigate = useNavigate();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const [pickedEnvironmentId, setPickedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId = useDefaultBotsEnvironmentId(pickedEnvironmentId);
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="text-sm font-medium text-foreground">Bots</h1>
          {connectedIds.length > 1 && environmentId !== null ? (
            <div className="[-webkit-app-region:no-drag]">
              <Select
                value={environmentId}
                onValueChange={(id) => {
                  if (id) setPickedEnvironmentId(id);
                }}
              >
                <SelectTrigger size="sm" aria-label="Environment">
                  <SelectValue>{labelOf(environmentId)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connectedIds.map((id) => (
                    <SelectItem key={id} value={id} label={labelOf(id)}>
                      {labelOf(id)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </WorkspacePageHeader>
        <div className="scrollbar-gutter-both flex-1 overflow-y-auto">
          <WorkspacePageContainer width="wide">
            {environmentId === null ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BotIcon />
                  </EmptyMedia>
                  <EmptyTitle>No environments available</EmptyTitle>
                  <EmptyDescription>Connect an environment to manage its bots.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <BotsEnvironment
                key={environmentId}
                environmentId={environmentId}
                selectedBotId={selectedBotId}
                onSelectBot={(id) =>
                  void navigate({ to: "/bots", search: { bot: id }, replace: true })
                }
              />
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

type EditorState = { readonly bot: Bot | null } | null;

function BotsEnvironment({
  environmentId,
  selectedBotId,
  onSelectBot,
}: {
  readonly environmentId: EnvironmentId;
  readonly selectedBotId: Bot["id"] | null;
  readonly onSelectBot: (id: Bot["id"]) => void;
}) {
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const schedulesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canOperate = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const { entries, defaultModel } = useBotModelContext(environmentId, null);
  const [editor, setEditor] = useState<EditorState>(null);

  const data = botsQuery.data;
  const bots = data ? sortBots(data.bots) : [];
  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? bots[0] ?? null;
  const dispatcher = bots.find((bot) => bot.dispatcher) ?? null;

  const { addTeam, addingTeam } = useAddBotTeam(environmentId, bots, defaultModel);

  const teamMenu = (
    <Menu>
      <MenuTrigger
        render={
          <Button size="sm" variant="outline" disabled={!canOperate || addingTeam || !data} />
        }
      >
        <UsersIcon />
        Add a team
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {BOT_TEAM_TEMPLATES.map((template) => (
          <MenuItem key={template.id} onClick={() => void addTeam(template)}>
            <div className="flex min-w-0 flex-col">
              <span>{template.name}</span>
              <span className="text-xs text-muted-foreground">{template.description}</span>
            </div>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold text-foreground">Bots</h2>
          <p className="text-sm text-muted-foreground">
            Named agents with their own chat, instructions and memories. The dispatcher splits
            requests and hands the pieces to the others.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {teamMenu}
          <Button
            size="sm"
            disabled={!canOperate || !data}
            onClick={() => setEditor({ bot: null })}
          >
            <PlusIcon />
            New bot
          </Button>
        </div>
      </div>

      {botsQuery.error && !data ? (
        <p className="text-sm text-destructive" role="alert">
          {botsQuery.error}
        </p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading bots…
        </p>
      ) : bots.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>No bots yet</EmptyTitle>
            <EmptyDescription>
              Start from a team template or create a bot from scratch.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              {BOT_TEAM_TEMPLATES.map((template) => (
                <Button
                  key={template.id}
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || addingTeam}
                  onClick={() => void addTeam(template)}
                >
                  <UsersIcon />
                  {template.name}
                </Button>
              ))}
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <ul className="flex flex-col gap-1" aria-label="Bots">
            {bots.map((bot) => (
              <li key={bot.id}>
                <button
                  type="button"
                  aria-current={bot.id === selectedBot?.id ? "true" : undefined}
                  onClick={() => onSelectBot(bot.id)}
                  className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent aria-[current=true]:bg-accent"
                >
                  <BotAvatar bot={bot} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {bot.name}
                      </span>
                      {bot.dispatcher ? (
                        <Badge size="sm" variant="info">
                          Dispatcher
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      @{bot.handle}
                      {bot.title ? ` · ${bot.title}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selectedBot ? (
            <BotDetail
              key={selectedBot.id}
              environmentId={environmentId}
              bot={selectedBot}
              memories={memoriesForBot(data.memories, selectedBot.id)}
              tasks={tasksByBot(data.tasks).get(selectedBot.id) ?? []}
              schedules={botSchedules(schedulesQuery.data?.tasks ?? [], selectedBot)}
              timeZone={schedulesQuery.data?.timeZone}
              bots={bots}
              entries={entries}
              canOperate={canOperate}
              onEdit={() => setEditor({ bot: selectedBot })}
            />
          ) : null}
        </div>
      )}

      {editor !== null ? (
        <BotEditorDialog
          key={editor.bot?.id ?? "new"}
          environmentId={environmentId}
          bot={editor.bot}
          dispatcher={dispatcher}
          onClose={() => setEditor(null)}
          onSaved={(bot) => onSelectBot(bot.id)}
        />
      ) : null}
    </>
  );
}

function DetailSection({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function BotDetail({
  environmentId,
  bot,
  memories,
  tasks,
  schedules,
  timeZone,
  bots,
  entries,
  canOperate,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly memories: ReadonlyArray<BotMemory>;
  readonly tasks: ReadonlyArray<BotTask>;
  readonly schedules: ReadonlyArray<ScheduledTask>;
  readonly timeZone: string | undefined;
  readonly bots: ReadonlyArray<Bot>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly canOperate: boolean;
  readonly onEdit: () => void;
}) {
  const { busy, openBotChat, removeBot } = useBotActions(environmentId);
  const nowMs = Date.parse(useNowMinute());

  const recentTasks = tasks.slice(0, RECENT_TASK_LIMIT);
  const botName = (id: Bot["id"] | null) =>
    id === null ? "you" : (bots.find((entry) => entry.id === id)?.name ?? "a removed bot");

  return (
    <div className="min-w-0 space-y-6 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start gap-3">
        <BotAvatar bot={bot} size="lg" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-foreground">{bot.name}</h2>
            {bot.dispatcher ? <Badge variant="info">Dispatcher</Badge> : null}
          </div>
          <p className="truncate text-sm text-muted-foreground">
            @{bot.handle}
            {bot.title ? ` · ${bot.title}` : ""}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {botModelLabel(bot.modelSelection, entries)} ·{" "}
            {runtimeModeConfig[bot.runtimeMode].label}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" disabled={busy || !canOperate} onClick={() => void openBotChat(bot)}>
            <MessageSquareIcon />
            Open chat
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`Edit ${bot.name}`}
            disabled={busy || !canOperate}
            onClick={onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            aria-label={`Delete ${bot.name}`}
            disabled={busy || !canOperate}
            onClick={() => void removeBot(bot)}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <DetailSection title="Instructions">
        <p className="line-clamp-6 text-sm whitespace-pre-wrap text-muted-foreground">
          {bot.instructions.trim() || "No instructions yet. Edit the bot to describe its job."}
        </p>
      </DetailSection>

      <BotMemories
        environmentId={environmentId}
        bot={bot}
        memories={memories}
        canOperate={canOperate}
      />

      <DetailSection title="Recent tasks">
        {recentTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recent tasks. Teammates hand {bot.name} work with a message from their chat.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {recentTasks.map((task) => (
              <li key={task.taskId} className="flex min-w-0 items-center gap-2 py-1.5">
                <Badge size="sm" variant={botTaskStatusVariant(task.status)}>
                  {BOT_TASK_STATUS_LABELS[task.status]}
                </Badge>
                <BotThreadLink
                  environmentId={environmentId}
                  threadId={task.threadId}
                  fallback={task.title}
                />
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  from {botName(task.requesterBotId)} ·{" "}
                  {formatRelativeTimeLabel(task.updatedAt, nowMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Schedules">
        {schedules.length === 0 ? null : (
          <ul className="divide-y divide-border/60">
            {schedules.map((task) => (
              <li key={task.id} className="flex min-w-0 items-center gap-2 py-1.5">
                <Link
                  to="/settings/scheduled-tasks"
                  search={{ environmentId, taskId: task.id }}
                  className="min-w-0 flex-1 truncate text-sm text-foreground hover:underline"
                >
                  {task.title}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {task.enabled ? scheduleLabel(task.schedule, timeZone, task.nextRunAt) : "Paused"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          To schedule work, ask {bot.name} in its chat, such as “every weekday at 9, summarize new
          issues”. Manage schedules in{" "}
          <Link to="/settings/scheduled-tasks" className="underline underline-offset-2">
            Settings → Scheduled tasks
          </Link>
          .
        </p>
      </DetailSection>
    </div>
  );
}

function BotThreadLink({
  environmentId,
  threadId,
  fallback,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly fallback: string;
}) {
  const ref = scopeThreadRef(environmentId, threadId);
  const title = useQuietThreadShell(ref)?.title.trim();
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
      className="min-w-0 truncate text-sm text-foreground underline-offset-2 hover:underline"
    >
      {title || fallback.trim() || "Open task"}
    </Link>
  );
}

function BotMemories({
  environmentId,
  bot,
  memories,
  canOperate,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly memories: ReadonlyArray<BotMemory>;
  readonly canOperate: boolean;
}) {
  const addMemory = useAtomCommand(serverEnvironment.addBotMemory, { label: "bot memory add" });
  const deleteMemory = useAtomCommand(serverEnvironment.deleteBotMemory, {
    label: "bot memory delete",
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const full = memories.length >= MAX_BOT_MEMORIES;

  const submit = async () => {
    const trimmed = text.trim();
    if (
      busy ||
      trimmed === "" ||
      full ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusy(true);
    const result = await addMemory({ environmentId, input: { botId: bot.id, text: trimmed } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportBotFailure("Could not add the memory", squashAtomCommandFailure(result));
      }
      return;
    }
    setText("");
  };

  const remove = async (memory: BotMemory) => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result = await deleteMemory({ environmentId, input: { id: memory.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportBotFailure("Could not forget the memory", squashAtomCommandFailure(result));
    }
  };

  return (
    <DetailSection
      title="Memories"
      action={
        <span className="text-xs text-muted-foreground">
          {memories.length}/{MAX_BOT_MEMORIES}
        </span>
      }
    >
      {memories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {bot.name} remembers lasting facts and preferences here, on its own or when you add them.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {memories.map((memory) => (
            <li key={memory.id} className="flex min-w-0 items-start gap-2 py-1.5">
              <span className="min-w-0 flex-1 text-sm break-words text-foreground">
                {memory.text}
              </span>
              <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                {memory.source === "user" ? "You" : bot.name}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Forget this memory"
                disabled={busy || !canOperate}
                onClick={() => void remove(memory)}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Input
          aria-label={`Add a memory for ${bot.name}`}
          placeholder={full ? "Memory is full; forget one first." : "Add a memory"}
          maxLength={BOT_MEMORY_MAX_CHARS}
          value={text}
          disabled={busy || !canOperate || full}
          onChange={(event) => setText(event.target.value)}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={busy || !canOperate || full || text.trim() === ""}
        >
          Add
        </Button>
      </form>
    </DetailSection>
  );
}
