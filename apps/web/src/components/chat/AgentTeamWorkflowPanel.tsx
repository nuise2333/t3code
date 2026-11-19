import type { AgentTeamProgress, AgentTeamTaskRow } from "@t3tools/client-runtime/routing";
import {
  formatModelSelectionEffort,
  REASONING_EFFORT_OPTION_IDS,
} from "@t3tools/client-runtime/state/thread-execution";
import type { ModelSelection, ServerProvider, ThreadId } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  ArrowUpRightIcon,
  BotIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  SquareIcon,
  UsersIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { AGENT_TEAM_STATUS_LABELS, AgentTeamStatusIcon, agentTeamTitle } from "./AgentTeamStrip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** The team a thread leads and how far its work is, for the strip and the workflow panel. */
export interface AgentTeamView {
  readonly name: string;
  /** Such as "Opus 5.5 leads GPT-6.1, Gemini 4". */
  readonly summary: string;
  /** The lead's model label, such as "Opus 5.5". */
  readonly leadLabel: string;
  readonly lead: ModelSelection;
  readonly progress: AgentTeamProgress;
  /** A saved team's workers, listed before they get a task; T3 picks an automatic team's. */
  readonly workers?: ReadonlyArray<{ readonly label: string; readonly selection: ModelSelection }>;
}

type AgentState = AgentTeamTaskRow["status"] | "planning" | "reviewing" | "waiting" | "idle";

/** One agent of the team and what it does now, for the panel's Agents list. */
interface AgentTeamAgent {
  readonly key: string;
  readonly role: "lead" | "worker";
  readonly label: string;
  readonly selection: ModelSelection;
  readonly driver: AgentTeamTaskRow["driver"] | undefined;
  readonly state: AgentState;
  /** What it is on now, or what it did last. */
  readonly activity: string | null;
  readonly done: number;
  readonly total: number;
}

const AGENT_STATE_LABELS: Record<AgentState, string> = {
  ...AGENT_TEAM_STATUS_LABELS,
  planning: "Planning",
  reviewing: "Reviewing",
  waiting: "Waiting on workers",
  idle: "Idle",
};

const selectionKey = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `${selection.instanceId}\u0000${selection.model}`;

/** The lead, then each worker with its latest task: working, else how its last task ended. */
function agentTeamAgents(team: AgentTeamView): ReadonlyArray<AgentTeamAgent> {
  const { progress } = team;
  const lead: AgentTeamAgent = {
    key: `lead:${selectionKey(team.lead)}`,
    role: "lead",
    label: team.leadLabel,
    selection: team.lead,
    driver: undefined,
    state: progress.lead ?? (progress.working > 0 ? "waiting" : "idle"),
    activity: progress.lead === null ? null : LEAD_STEP[progress.lead].detail,
    done: 0,
    total: 0,
  };
  const workers = new Map<
    string,
    { label: string; selection: ModelSelection; rows: AgentTeamTaskRow[] }
  >();
  for (const worker of team.workers ?? []) {
    workers.set(selectionKey(worker.selection), { ...worker, rows: [] });
  }
  for (const row of progress.rows) {
    const key = selectionKey(row.selection);
    const worker = workers.get(key);
    if (worker) worker.rows.push(row);
    else workers.set(key, { label: row.member, selection: row.selection, rows: [row] });
  }
  return [
    lead,
    ...[...workers].map(([key, worker]): AgentTeamAgent => {
      const current = worker.rows.find((row) => row.status === "working") ?? worker.rows.at(-1);
      return {
        key: `worker:${key}`,
        role: "worker",
        label: worker.label,
        selection: worker.selection,
        driver: worker.rows[0]?.driver,
        state: current?.status ?? "idle",
        activity:
          current === undefined
            ? null
            : current.status === "working"
              ? (current.progress ?? current.title)
              : current.title,
        done: worker.rows.filter((row) => row.status === "done").length,
        total: worker.rows.length,
      };
    }),
  ];
}

const LEAD_STEP: Record<
  NonNullable<AgentTeamProgress["lead"]>,
  { readonly title: string; readonly detail: string }
> = {
  planning: {
    title: "Lead is planning",
    detail: "No task handed over yet",
  },
  reviewing: {
    title: "Lead is reviewing",
    detail: "Checking results and deciding the next handover",
  },
};

/**
 * A team's run in the right panel: where it stands, then every handover from the lead in order,
 * each with what was asked, what came back, and a way into the member's thread.
 */
export function AgentTeamWorkflowPanel(props: {
  readonly team: AgentTeamView | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  /** Stops one delegated task; absent where the thread cannot stop tasks. */
  readonly onStopTask?: ((taskId: string) => Promise<void>) | undefined;
}) {
  const { team, onStopTask } = props;
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [stopping, setStopping] = useState(false);

  if (team === null) {
    return (
      <PanelNotice title="No team on this thread">
        Pick a team in the model picker's Agent team tab to have this thread lead one.
      </PanelNotice>
    );
  }

  const { progress } = team;
  const { rows } = progress;
  const stoppable = rows.filter((row) => row.stoppable);
  const stop = async (taskIds: ReadonlyArray<string>) => {
    if (!onStopTask || stopping) return;
    setStopping(true);
    await Promise.all(taskIds.map((taskId) => onStopTask(taskId)));
    setStopping(false);
  };
  const setExpanded = (taskId: string, expanded: boolean) =>
    setExpandedIds((current) => {
      if (current.has(taskId) === expanded) return current;
      const next = new Set(current);
      if (expanded) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  const live = progress.working > 0 || progress.lead !== null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-team-workflow">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 pt-2.5 pb-3">
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <UsersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
            {agentTeamTitle(team.name)}
          </h2>
          {onStopTask && stoppable.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost-destructive"
                    disabled={stopping}
                    aria-label={`Stop ${stoppable.length} working ${stoppable.length === 1 ? "task" : "tasks"}`}
                    onClick={() => void stop(stoppable.map((row) => row.id))}
                  />
                }
              >
                <SquareIcon aria-hidden className="size-3 fill-current" />
                Stop
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                Stop {stoppable.length === 1 ? "the working task" : "every working task"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">Led by</span>
          <ModelLine
            label={team.leadLabel}
            selection={team.lead}
            driver={undefined}
            providers={props.providers}
          />
        </div>
        {rows.length > 0 ? (
          <>
            <div
              role="progressbar"
              aria-label="Team tasks done"
              aria-valuemin={0}
              aria-valuemax={rows.length}
              aria-valuenow={progress.done}
              aria-valuetext={`${progress.done} of ${rows.length} done`}
              className="flex h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-success transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${(progress.done / rows.length) * 100}%` }}
              />
              <div
                className="h-full bg-destructive transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${(progress.failed / rows.length) * 100}%` }}
              />
            </div>
            <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="min-w-0 truncate">
                <span className="text-foreground tabular-nums">
                  {progress.done} of {rows.length}
                </span>{" "}
                done
                {progress.working > 0 ? ` · ${progress.working} working` : ""}
                {progress.failed > 0 ? ` · ${progress.failed} failed` : ""}
              </span>
              <Tooltip>
                <TooltipTrigger render={<span className="shrink-0" />}>
                  <AgentElapsed
                    agent={{
                      status: live ? "running" : "completed",
                      startedAt: progress.startedAt,
                      completedAt: progress.completedAt,
                    }}
                  />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Since the first task started</TooltipPopup>
              </Tooltip>
            </div>
          </>
        ) : null}
      </header>
      <ScrollArea scrollFade className="min-h-0 flex-1">
        <AgentList agents={agentTeamAgents(team)} providers={props.providers} />
        <h3 className="px-3 pt-1 text-2xs font-medium text-muted-foreground select-none">
          Handovers
        </h3>
        {rows.length === 0 && progress.lead === null ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No tasks yet. The lead delegates to members as it plans.
          </p>
        ) : (
          <ol aria-label="Team workflow" className="flex flex-col p-3" onKeyDown={moveBetweenSteps}>
            {rows.map((row, index) => (
              <WorkflowStep
                key={row.id}
                row={row}
                last={index === rows.length - 1 && progress.lead === null}
                expanded={expandedIds.has(row.id)}
                providers={props.providers}
                stopping={stopping}
                onExpandedChange={(expanded) => setExpanded(row.id, expanded)}
                onOpenThread={props.onOpenThread}
                onStop={onStopTask ? () => void stop([row.id]) : undefined}
              />
            ))}
            {progress.lead === null ? null : (
              <li className="flex gap-2.5">
                <StepRail last>
                  <LoaderCircleIcon
                    aria-label="Working"
                    className="size-3.5 shrink-0 animate-spin text-info motion-reduce:animate-none"
                  />
                </StepRail>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-1.5 py-1">
                  <span className="truncate text-xs font-medium">
                    {LEAD_STEP[progress.lead].title}
                  </span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {team.leadLabel} · {LEAD_STEP[progress.lead].detail}
                  </span>
                </div>
              </li>
            )}
          </ol>
        )}
      </ScrollArea>
    </div>
  );
}

function AgentStateIcon(props: { readonly state: AgentState }) {
  const { state } = props;
  if (state === "working" || state === "done" || state === "failed" || state === "stopped") {
    return <AgentTeamStatusIcon status={state} />;
  }
  if (state === "planning" || state === "reviewing") {
    return (
      <LoaderCircleIcon
        aria-label={AGENT_STATE_LABELS[state]}
        className="size-3.5 shrink-0 animate-spin text-info motion-reduce:animate-none"
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={AGENT_STATE_LABELS[state]}
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "waiting" ? "bg-info/60" : "bg-muted-foreground/40",
      )}
    />
  );
}

/** Every agent of the team, one row each: its model, role, state and current work. */
function AgentList(props: {
  readonly agents: ReadonlyArray<AgentTeamAgent>;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  return (
    <section aria-label="Agents" className="flex flex-col gap-1 px-3 pt-3 pb-2">
      <h3 className="text-2xs font-medium text-muted-foreground select-none">Agents</h3>
      <ul className="flex flex-col gap-1">
        {props.agents.map((agent) => (
          <li
            key={agent.key}
            data-agent-team-agent={agent.role}
            data-agent-state={agent.state}
            className="flex min-w-0 items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5"
          >
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              <AgentStateIcon state={agent.state} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                <span className="min-w-0 flex-1 font-medium">
                  <ModelLine
                    label={agent.label}
                    selection={agent.selection}
                    driver={agent.driver}
                    providers={props.providers}
                  />
                </span>
                {agent.role === "lead" ? (
                  <Badge variant="outline" size="sm">
                    Lead
                  </Badge>
                ) : agent.total > 0 ? (
                  <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                    {agent.done}/{agent.total} done
                  </span>
                ) : null}
              </span>
              <span className="truncate text-2xs text-muted-foreground">
                {AGENT_STATE_LABELS[agent.state]}
                {agent.activity ? ` · ${agent.activity}` : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Up, Down, Home and End move between the steps' own buttons, not the controls inside one. */
function moveBetweenSteps(event: KeyboardEvent<HTMLOListElement>) {
  if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-team-step]")) return;
  const steps = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-team-step]")];
  const index = steps.indexOf(event.target);
  const next =
    event.key === "ArrowDown"
      ? steps[index + 1]
      : event.key === "ArrowUp"
        ? steps[index - 1]
        : event.key === "Home"
          ? steps[0]
          : event.key === "End"
            ? steps.at(-1)
            : undefined;
  if (!next) return;
  event.preventDefault();
  next.focus();
}

function WorkflowStep(props: {
  readonly row: AgentTeamTaskRow;
  readonly last: boolean;
  readonly expanded: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly stopping: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onStop: (() => void) | undefined;
}) {
  const { row, expanded } = props;
  const detailsId = `agent-team-step-${row.id}`;
  const childThreadId = row.childThreadId;
  return (
    <li className="flex gap-2.5">
      <StepRail last={props.last}>
        <AgentTeamStatusIcon status={row.status} />
      </StepRail>
      <div className="flex min-w-0 flex-1 flex-col pb-2">
        <button
          type="button"
          data-team-step
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          aria-keyshortcuts="ArrowRight ArrowLeft"
          className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-1.5 py-1 text-start outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => props.onExpandedChange(!expanded)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            props.onExpandedChange(event.key === "ArrowRight");
          }}
        >
          <span className="flex w-full min-w-0 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
            {row.round > 1 ? (
              <Tooltip>
                <TooltipTrigger render={<Badge variant="warning" size="sm" />}>
                  Round {row.round}
                </TooltipTrigger>
                <TooltipPopup>{row.member} got this after its earlier task ended</TooltipPopup>
              </Tooltip>
            ) : null}
            <span className="shrink-0 text-muted-foreground">
              <AgentElapsed
                agent={{
                  status: row.status === "working" ? "running" : "completed",
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                }}
                compact
              />
            </span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                expanded && "rotate-90",
              )}
            />
          </span>
          <span className="flex w-full min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <ModelLine
              label={row.member}
              selection={row.selection}
              driver={row.driver}
              providers={props.providers}
            />
            <span className="shrink-0">· {AGENT_TEAM_STATUS_LABELS[row.status]}</span>
          </span>
        </button>
        {expanded ? (
          <div
            id={detailsId}
            role="region"
            aria-label={`${row.title} details`}
            className="mt-1 ms-1.5 flex min-w-0 flex-col gap-2 rounded-md border border-border/60 bg-muted/40 px-2.5 py-2"
          >
            <StepExcerpt label="Assignment">{row.brief}</StepExcerpt>
            {row.progress === null ? null : (
              <StepExcerpt label="Latest update">{row.progress}</StepExcerpt>
            )}
            {row.report === null ? null : <StepExcerpt label="Result">{row.report}</StepExcerpt>}
            {childThreadId === null && !(row.stoppable && props.onStop) ? null : (
              <div className="flex flex-wrap items-center gap-1.5">
                {childThreadId === null ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => props.onOpenThread(childThreadId)}
                  >
                    <ArrowUpRightIcon aria-hidden />
                    Open thread
                  </Button>
                )}
                {row.stoppable && props.onStop ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={props.stopping}
                    onClick={props.onStop}
                  >
                    <SquareIcon aria-hidden className="size-3 fill-current" />
                    Stop
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** A step's status mark and, below it, the line that hands over to the next step. */
function StepRail(props: { readonly last: boolean; readonly children: ReactNode }) {
  return (
    <div className="flex w-5 shrink-0 flex-col items-center">
      <span className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border border-border/70">
        {props.children}
      </span>
      {props.last ? null : <span aria-hidden className="my-0.5 w-px flex-1 bg-border" />}
    </div>
  );
}

function StepExcerpt(props: { readonly label: string; readonly children: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="text-2xs font-medium text-muted-foreground select-none">{props.label}</h3>
      <p className="max-h-40 overflow-y-auto text-xs break-words whitespace-pre-wrap text-foreground/90">
        {props.children}
      </p>
    </div>
  );
}

/** A provider icon, the model's name and its effort, as the subagent hover card shows them. */
function ModelLine(props: {
  readonly label: string;
  readonly selection: ModelSelection;
  readonly driver: ServerProvider["driver"] | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const provider = props.providers.find(
    (candidate) => candidate.instanceId === props.selection.instanceId,
  );
  const driver = provider?.driver ?? props.driver;
  const effort =
    formatModelSelectionEffort(props.selection, provider?.models) ??
    REASONING_EFFORT_OPTION_IDS.map((id) =>
      getModelSelectionStringOptionValue(props.selection, id),
    ).find(Boolean);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={provider?.displayName ?? driver}
          accentColor={provider?.accentColor}
          acpRegistryIconUrl={provider?.iconUrl}
          iconClassName="size-3 shrink-0 grayscale opacity-60"
        />
      ) : (
        <BotIcon aria-hidden className="size-3 shrink-0" />
      )}
      <span className="min-w-0 truncate">{props.label}</span>
      {effort ? <span className="shrink-0">· {effort}</span> : null}
    </span>
  );
}

function PanelNotice(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <UsersIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{props.title}</p>
      <p className="max-w-60 text-xs text-muted-foreground">{props.children}</p>
    </div>
  );
}
