import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  MAX_BOT_MEMORIES,
  BOT_MEMORY_MAX_CHARS,
  type Bot,
  type BotColor,
  type BotMemory,
  type BotTask,
  type EnvironmentId,
  type ProjectId,
  type RuntimeMode,
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

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useNowMinute } from "../../hooks/useNowMinute";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "../../providerInstances";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useProjects, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduleLabel, scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  BOT_AVATARS,
  BOT_COLORS,
  BOT_TASK_STATUS_LABELS,
  BOT_TEAM_TEMPLATES,
  botDraftErrors,
  botModelLabel,
  botSchedules,
  botTaskStatusVariant,
  botToDraft,
  botUpsertInputFromDraft,
  emptyBotDraft,
  memoriesForBot,
  sortBots,
  tasksByBot,
  templateUpsertInputs,
  type BotDraft,
  type BotTeamTemplate,
} from "./botsPage.logic";

const RECENT_TASK_LIMIT = 10;
// Project ids are trimmed, so the leading space never matches one.
const NO_PROJECT = " none";

const COLOR_CLASS: Record<BotColor, string> = {
  slate: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  green: "bg-green-500/15 text-green-700 dark:text-green-300",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  pink: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
};

const COLOR_SWATCH_CLASS: Record<BotColor, string> = {
  slate: "bg-slate-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
};

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

export function BotsPage() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const [pickedEnvironmentId, setPickedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    pickedEnvironmentId !== null && connectedIds.includes(pickedEnvironmentId)
      ? pickedEnvironmentId
      : primaryEnvironmentId !== null && connectedIds.includes(primaryEnvironmentId)
        ? primaryEnvironmentId
        : (connectedIds[0] ?? null);
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
              <BotsEnvironment key={environmentId} environmentId={environmentId} />
            )}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}

function useBotModelContext(environmentId: EnvironmentId, projectId: ProjectId | null) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, projectId);
  return {
    settings,
    providers,
    entries,
    defaultModel: scheduledTaskDefaultModel(settings, null, entries),
  };
}

type EditorState = { readonly bot: Bot | null } | null;

function BotsEnvironment({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const schedulesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canOperate = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const upsertBot = useAtomCommand(serverEnvironment.upsertBot, { label: "bot upsert" });
  const { entries, defaultModel } = useBotModelContext(environmentId, null);
  const [selectedBotId, setSelectedBotId] = useState<Bot["id"] | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [addingTeam, setAddingTeam] = useState(false);

  const data = botsQuery.data;
  const bots = data ? sortBots(data.bots) : [];
  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? bots[0] ?? null;
  const dispatcher = bots.find((bot) => bot.dispatcher) ?? null;

  const addTeam = async (template: BotTeamTemplate) => {
    if (addingTeam || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = templateUpsertInputs(template, defaultModel, bots.length);
    if (!result.ok) {
      reportFailure(`Could not add ${template.name}`, result.error);
      return;
    }
    if (dispatcher !== null) {
      const message = `Add ${template.name}?\nIts dispatcher replaces ${dispatcher.name} as the dispatcher.`;
      const confirmed = (await requestConfirmDialog(message)) ?? window.confirm(message);
      if (!confirmed) return;
    }
    setAddingTeam(true);
    for (const input of result.inputs) {
      const saved = await upsertBot({ environmentId, input });
      if (saved._tag === "Failure") {
        if (!isAtomCommandInterrupted(saved)) {
          reportFailure(`Could not add ${input.name}`, squashAtomCommandFailure(saved));
        }
        break;
      }
    }
    setAddingTeam(false);
  };

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
                  onClick={() => setSelectedBotId(bot.id)}
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
          onSaved={(bot) => setSelectedBotId(bot.id)}
        />
      ) : null}
    </>
  );
}

function BotAvatar({ bot, size = "sm" }: { readonly bot: Bot; readonly size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full ${COLOR_CLASS[bot.color]} ${
        size === "lg" ? "size-10 text-xl" : "size-7 text-sm"
      }`}
    >
      {bot.avatar || "🤖"}
    </span>
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
  const navigate = useNavigate();
  const openChat = useAtomCommand(serverEnvironment.openBotChat, { label: "bot open chat" });
  const deleteBot = useAtomCommand(serverEnvironment.deleteBot, { label: "bot delete" });
  const [busy, setBusy] = useState(false);
  const nowMs = Date.parse(useNowMinute());

  const handleOpenChat = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result = await openChat({ environmentId, input: { id: bot.id } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(`Could not open ${bot.name}'s chat`, squashAtomCommandFailure(result));
      }
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
    });
  };

  const handleDelete = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const message = `Delete ${bot.name}?\nIts memories and task list go with it. Its chat and task threads stay as ordinary threads, and schedules made in its chat keep running there.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy(true);
    const result = await deleteBot({ environmentId, input: { id: bot.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(`Could not delete ${bot.name}`, squashAtomCommandFailure(result));
    }
  };

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
          <Button size="sm" disabled={busy || !canOperate} onClick={() => void handleOpenChat()}>
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
            onClick={() => void handleDelete()}
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
        reportFailure("Could not add the memory", squashAtomCommandFailure(result));
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
      reportFailure("Could not forget the memory", squashAtomCommandFailure(result));
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

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

function BotEditorDialog({
  environmentId,
  bot,
  dispatcher,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly dispatcher: Bot | null;
  readonly onClose: () => void;
  readonly onSaved: (bot: Bot) => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      {/* The form owns the draft so a keystroke re-renders it, not the dialog chrome. */}
      <DialogPopup className="max-w-xl">
        <BotEditorForm
          environmentId={environmentId}
          bot={bot}
          dispatcher={dispatcher}
          saving={saving}
          onSavingChange={setSaving}
          onClose={onClose}
          onSaved={onSaved}
        />
      </DialogPopup>
    </Dialog>
  );
}

function BotEditorForm({
  environmentId,
  bot,
  dispatcher,
  saving,
  onSavingChange: setSaving,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly dispatcher: Bot | null;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onClose: () => void;
  readonly onSaved: (bot: Bot) => void;
}) {
  const canOperate = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const upsertBot = useAtomCommand(serverEnvironment.upsertBot, { label: "bot upsert" });
  const { scratchWorkspaceRootFor } = useScratchProject();
  const environmentProjects = useProjects().filter(
    (project) => project.environmentId === environmentId,
  );
  // "No project" stands in for the scratch project, so it is not listed twice.
  const isScratch = (project: (typeof environmentProjects)[number]) =>
    isScratchProject(project, scratchWorkspaceRootFor(environmentId));
  const projects = environmentProjects.filter(
    (project) =>
      !isScratch(project) && (project.archivedAt == null || project.id === bot?.projectId),
  );
  const [draft, setDraft] = useState<BotDraft>(() =>
    bot
      ? botToDraft(
          bot,
          environmentProjects.some((project) => project.id === bot.projectId && isScratch(project)),
        )
      : emptyBotDraft(null),
  );
  const [originalProjectId] = useState(() => draft.projectId);
  const movesChat =
    bot !== null && bot.homeThreadId !== null && draft.projectId !== originalProjectId;
  const { settings, providers, entries, defaultModel } = useBotModelContext(
    environmentId,
    draft.projectId === "" ? null : draft.projectId,
  );
  const selection = draft.modelSelection ?? defaultModel;
  const shownInstanceId = selection?.instanceId ?? entries[0]?.instanceId;
  const shownModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    shownInstanceId,
    shownModel,
  );
  const effectiveDraft: BotDraft = { ...draft, modelSelection: selection };
  const errors = botDraftErrors(effectiveDraft);
  const [showErrors, setShowErrors] = useState(false);
  const update = (patch: Partial<BotDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const otherDispatcher = dispatcher !== null && dispatcher.id !== bot?.id ? dispatcher : null;
  const selectedProject = projects.find((project) => project.id === draft.projectId);

  const submit = async () => {
    if (saving || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const input = botUpsertInputFromDraft(effectiveDraft);
    if (input === null) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    const result = await upsertBot({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save the bot", squashAtomCommandFailure(result));
      }
      return;
    }
    onSaved(result.value.bot);
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{bot ? `Edit ${bot.name}` : "New bot"}</DialogTitle>
        <DialogDescription>
          A bot has its own chat, instructions and memories. Teammates reach it by its handle.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="bot-name">
              <Input
                id="bot-name"
                maxLength={60}
                placeholder="Builder"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field
              label="Handle"
              {...(bot === null ? { hint: "Blank: from the name" } : {})}
              htmlFor="bot-handle"
            >
              <Input
                id="bot-handle"
                maxLength={32}
                placeholder="builder"
                value={draft.handle}
                onChange={(event) => update({ handle: event.target.value.toLowerCase() })}
              />
            </Field>
          </div>
          <Field label="Title" htmlFor="bot-title">
            <Input
              id="bot-title"
              maxLength={80}
              placeholder="Code reviewer"
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </Field>
          <Field label="Instructions" htmlFor="bot-instructions">
            <Textarea
              id="bot-instructions"
              className="max-h-64 overflow-y-auto"
              placeholder="Duties, how it works, and its personality."
              value={draft.instructions}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Avatar" htmlFor="bot-avatar">
              <Select
                value={draft.avatar}
                onValueChange={(avatar) => {
                  if (avatar) update({ avatar });
                }}
              >
                <SelectTrigger size="sm" id="bot-avatar">
                  <SelectValue>{draft.avatar}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(BOT_AVATARS as ReadonlyArray<string>).includes(draft.avatar) ? null : (
                    <SelectItem value={draft.avatar} label={draft.avatar}>
                      {draft.avatar}
                    </SelectItem>
                  )}
                  {BOT_AVATARS.map((avatar) => (
                    <SelectItem key={avatar} value={avatar} label={avatar}>
                      {avatar}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Color" htmlFor="bot-color">
              <Select
                value={draft.color}
                onValueChange={(color) => {
                  if (color) update({ color });
                }}
              >
                <SelectTrigger size="sm" id="bot-color">
                  <SelectValue>
                    <span className="flex items-center gap-2 capitalize">
                      <span
                        className={`size-2.5 rounded-full ${COLOR_SWATCH_CLASS[draft.color]}`}
                      />
                      {draft.color}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {BOT_COLORS.map((color) => (
                    <SelectItem key={color} value={color} label={color}>
                      <span className="flex items-center gap-2 capitalize">
                        <span className={`size-2.5 rounded-full ${COLOR_SWATCH_CLASS[color]}`} />
                        {color}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </div>
          <Field label="Model">
            <div>
              {shownInstanceId === undefined ? (
                <p className="text-sm text-muted-foreground">
                  Set up a provider in Settings → Providers first.
                </p>
              ) : (
                <ProviderModelPicker
                  environmentId={environmentId}
                  disabled={saving}
                  activeInstanceId={shownInstanceId}
                  model={shownModel}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) =>
                    update({ modelSelection: { instanceId, model } })
                  }
                />
              )}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Permissions" htmlFor="bot-runtime-mode">
              <Select
                value={draft.runtimeMode}
                onValueChange={(mode: RuntimeMode | null) => {
                  if (mode) update({ runtimeMode: mode });
                }}
              >
                <SelectTrigger size="sm" id="bot-runtime-mode">
                  <SelectValue>{runtimeModeConfig[draft.runtimeMode].label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {runtimeModeOptions.map((mode) => (
                    <SelectItem key={mode} value={mode} label={runtimeModeConfig[mode].label}>
                      {runtimeModeConfig[mode].label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Chat project" htmlFor="bot-project">
              <Select
                value={draft.projectId === "" ? NO_PROJECT : draft.projectId}
                onValueChange={(value) => {
                  if (value === null) return;
                  update({ projectId: value === NO_PROJECT ? "" : (value as ProjectId) });
                }}
              >
                <SelectTrigger size="sm" id="bot-project">
                  <SelectValue>{selectedProject?.title ?? "No project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NO_PROJECT} label="No project">
                    No project
                  </SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id} label={project.title}>
                      <span className="block truncate">{project.title}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {movesChat ? (
                <p className="text-xs text-muted-foreground">
                  The next chat starts in this project. The current chat stays as an ordinary
                  thread, and schedules made in it keep running there.
                </p>
              ) : null}
            </Field>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="bot-dispatcher">Dispatcher</Label>
              <p className="text-xs text-muted-foreground">
                {otherDispatcher && draft.dispatcher
                  ? `Saving makes this bot the dispatcher instead of ${otherDispatcher.name}.`
                  : "Splits requests and hands the pieces to the other bots. One bot at a time."}
              </p>
            </div>
            <Switch
              id="bot-dispatcher"
              checked={draft.dispatcher}
              onCheckedChange={(checked) => update({ dispatcher: checked })}
            />
          </div>
          {showErrors && errors.length > 0 ? (
            <ul className="space-y-0.5 text-sm text-destructive" role="alert">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          Cancel
        </DialogClose>
        <Button size="sm" disabled={!canOperate || saving} onClick={() => void submit()}>
          {bot ? "Save bot" : "Create bot"}
        </Button>
      </DialogFooter>
    </>
  );
}
