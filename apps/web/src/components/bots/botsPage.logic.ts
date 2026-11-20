import {
  BOT_HANDLE_PATTERN,
  BOT_INSTRUCTIONS_MAX_CHARS,
  DEFAULT_RUNTIME_MODE,
  MAX_BOTS,
  type Bot,
  type BotColor,
  BotId,
  type BotMemory,
  type BotTask,
  type BotTaskStatus,
  type BotUpsertInput,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ScheduledTask,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";

export const BOT_COLORS: ReadonlyArray<BotColor> = [
  "slate",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
];

export const BOT_AVATARS = ["🤖", "🧭", "🛠️", "🧪", "🔍", "📚", "✍️", "🎨", "📈", "🛡️"] as const;

export interface BotDraft {
  readonly id: BotId | null;
  readonly name: string;
  readonly handle: string;
  readonly title: string;
  readonly instructions: string;
  readonly dispatcher: boolean;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  /** Empty means the server's "No project" scratch project. */
  readonly projectId: ProjectId | "";
  readonly avatar: string;
  readonly color: BotColor;
}

export function emptyBotDraft(modelSelection: ModelSelection | null): BotDraft {
  return {
    id: null,
    name: "",
    handle: "",
    title: "",
    instructions: "",
    dispatcher: false,
    modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    projectId: "",
    avatar: "🤖",
    color: "blue",
  };
}

/** `inScratch`: the bot lives in "No project", which the editor shows as a blank project. */
export function botToDraft(bot: Bot, inScratch: boolean): BotDraft {
  return {
    id: bot.id,
    name: bot.name,
    handle: bot.handle,
    title: bot.title,
    instructions: bot.instructions,
    dispatcher: bot.dispatcher,
    modelSelection: bot.modelSelection,
    runtimeMode: bot.runtimeMode,
    projectId: inScratch ? "" : bot.projectId,
    avatar: bot.avatar,
    color: bot.color,
  };
}

export function botDraftErrors(draft: BotDraft): ReadonlyArray<string> {
  const errors: Array<string> = [];
  const name = draft.name.trim();
  if (name === "") errors.push("Add a name.");
  else if (name.length > 60) errors.push("Keep the name under 60 characters.");
  const handle = draft.handle.trim();
  if (handle !== "" && !BOT_HANDLE_PATTERN.test(handle)) {
    errors.push("Use lowercase letters, digits and dashes for the handle, such as builder.");
  }
  if (draft.title.length > 80) errors.push("Keep the title under 80 characters.");
  if (draft.instructions.length > BOT_INSTRUCTIONS_MAX_CHARS) {
    errors.push(`Keep the instructions under ${BOT_INSTRUCTIONS_MAX_CHARS} characters.`);
  }
  if (draft.modelSelection === null) errors.push("Pick a model.");
  return errors;
}

/** Null while the draft has errors; see `botDraftErrors`. */
export function botUpsertInputFromDraft(draft: BotDraft): BotUpsertInput | null {
  if (botDraftErrors(draft).length > 0 || draft.modelSelection === null) return null;
  const handle = draft.handle.trim();
  return {
    ...(draft.id === null ? {} : { id: draft.id }),
    name: draft.name.trim(),
    ...(handle === "" ? {} : { handle }),
    title: draft.title.trim(),
    instructions: draft.instructions.trim(),
    dispatcher: draft.dispatcher,
    modelSelection: draft.modelSelection,
    runtimeMode: draft.runtimeMode,
    // Blank on an edit moves the bot back to "No project"; a new bot gets it by default.
    ...(draft.projectId !== ""
      ? { projectId: draft.projectId }
      : draft.id === null
        ? {}
        : { projectId: null }),
    avatar: draft.avatar.trim() || "🤖",
    color: draft.color,
  };
}

export interface BotTemplate {
  readonly name: string;
  readonly title: string;
  readonly instructions: string;
  readonly dispatcher: boolean;
  readonly avatar: string;
  readonly color: BotColor;
}

export interface BotTeamTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly bots: ReadonlyArray<BotTemplate>;
}

const DISPATCHER_INSTRUCTIONS = (team: string) =>
  [
    `You lead the ${team}. People talk to you first.`,
    "Split each request into clear pieces of work and send each piece to the teammate whose title fits it, with everything they need to know.",
    "Do small questions yourself. Track what you handed out, check what comes back, and answer with one combined result.",
    "When a teammate is stuck or a result looks wrong, say so plainly and decide the next step.",
  ].join("\n");

export const BOT_TEAM_TEMPLATES: ReadonlyArray<BotTeamTemplate> = [
  {
    id: "dev-squad",
    name: "Dev squad",
    description: "A dispatcher with a builder, a tester and a reviewer for code changes.",
    bots: [
      {
        name: "Dispatch",
        title: "Dispatcher",
        instructions: DISPATCHER_INSTRUCTIONS("dev squad"),
        dispatcher: true,
        avatar: "🧭",
        color: "violet",
      },
      {
        name: "Builder",
        title: "Software engineer",
        instructions: [
          "You implement features and fixes.",
          "Read the surrounding code first and follow its patterns. Keep changes small and focused on the request.",
          "Run the relevant checks before you report back, and list the files you changed and anything you left undone.",
        ].join("\n"),
        dispatcher: false,
        avatar: "🛠️",
        color: "blue",
      },
      {
        name: "Tester",
        title: "Test engineer",
        instructions: [
          "You prove that changes work and find the ways they break.",
          "Write focused tests for behavior that can break, run them, and reproduce reported bugs before anyone fixes them.",
          "Report what you ran, what passed, what failed, and the exact steps to reproduce each failure.",
        ].join("\n"),
        dispatcher: false,
        avatar: "🧪",
        color: "green",
      },
      {
        name: "Reviewer",
        title: "Code reviewer",
        instructions: [
          "You review changes before they ship.",
          "Look for bugs, missed cases, security problems and needless complexity. Check the change against what was asked.",
          "Rank findings by severity, quote the code you mean, and say clearly when a change is ready.",
        ].join("\n"),
        dispatcher: false,
        avatar: "🔍",
        color: "amber",
      },
    ],
  },
  {
    id: "research-desk",
    name: "Research desk",
    description: "A dispatcher with a researcher and a writer for questions and reports.",
    bots: [
      {
        name: "Desk",
        title: "Dispatcher",
        instructions: DISPATCHER_INSTRUCTIONS("research desk"),
        dispatcher: true,
        avatar: "🧭",
        color: "violet",
      },
      {
        name: "Researcher",
        title: "Researcher",
        instructions: [
          "You find out what is true.",
          "Prefer primary sources: official docs, source code, papers and data. Note where each fact came from.",
          "Separate what you confirmed from what you inferred, and say what you could not find.",
        ].join("\n"),
        dispatcher: false,
        avatar: "📚",
        color: "teal",
      },
      {
        name: "Writer",
        title: "Writer",
        instructions: [
          "You turn findings into clear writing.",
          "Lead with the answer, keep sentences short, and cut anything the reader does not need.",
          "Keep every claim the research supports and flag any gaps instead of filling them.",
        ].join("\n"),
        dispatcher: false,
        avatar: "✍️",
        color: "pink",
      },
    ],
  },
];

export type TemplateInputsResult =
  | { readonly ok: true; readonly inputs: ReadonlyArray<BotUpsertInput> }
  | { readonly ok: false; readonly error: string };

/** Handles are left to the server, which keeps them unique. */
export function templateUpsertInputs(
  template: BotTeamTemplate,
  modelSelection: ModelSelection | null,
  existingBotCount: number,
): TemplateInputsResult {
  if (modelSelection === null) {
    return { ok: false, error: "Set up a provider first; the team needs a model." };
  }
  if (existingBotCount + template.bots.length > MAX_BOTS) {
    return { ok: false, error: `An environment can have at most ${MAX_BOTS} bots.` };
  }
  return {
    ok: true,
    inputs: template.bots.map((bot) => ({
      name: bot.name,
      title: bot.title,
      instructions: bot.instructions,
      dispatcher: bot.dispatcher,
      modelSelection,
      avatar: bot.avatar,
      color: bot.color,
    })),
  };
}

/** The dispatcher first; the rest keep the server's order. */
export function sortBots(bots: ReadonlyArray<Bot>): ReadonlyArray<Bot> {
  return [...bots].sort((left, right) => Number(right.dispatcher) - Number(left.dispatcher));
}

/** A picked environment wins while connected; then the primary one, then the first. */
export function resolveBotsEnvironmentId(
  picked: EnvironmentId | null,
  primary: EnvironmentId | null,
  connected: ReadonlyArray<EnvironmentId>,
): EnvironmentId | null {
  if (picked !== null && connected.includes(picked)) return picked;
  if (primary !== null && connected.includes(primary)) return primary;
  return connected[0] ?? null;
}

export function validateBotsSearch(raw: Record<string, unknown>): { readonly bot?: BotId } {
  return typeof raw.bot === "string" && raw.bot.trim() ? { bot: BotId.make(raw.bot.trim()) } : {};
}

/** The bot whose own chat is the open thread. */
export function activeBotId(
  bots: ReadonlyArray<Bot>,
  environmentId: EnvironmentId,
  activeThreadRef: ScopedThreadRef | null,
): BotId | null {
  if (activeThreadRef === null || activeThreadRef.environmentId !== environmentId) return null;
  return bots.find((bot) => bot.homeThreadId === activeThreadRef.threadId)?.id ?? null;
}

/** Keeps the input order, which the server sends newest first. */
export function tasksByBot(
  tasks: ReadonlyArray<BotTask>,
): ReadonlyMap<BotId, ReadonlyArray<BotTask>> {
  const grouped = new Map<BotId, Array<BotTask>>();
  for (const task of tasks) {
    const list = grouped.get(task.botId);
    if (list) list.push(task);
    else grouped.set(task.botId, [task]);
  }
  return grouped;
}

export function memoriesForBot(
  memories: ReadonlyArray<BotMemory>,
  botId: BotId,
): ReadonlyArray<BotMemory> {
  return memories.filter((memory) => memory.botId === botId);
}

/** Schedules a bot made from its own chat are bound to that chat's thread. */
export function botSchedules(
  tasks: ReadonlyArray<ScheduledTask>,
  bot: Pick<Bot, "homeThreadId">,
): ReadonlyArray<ScheduledTask> {
  if (bot.homeThreadId === null) return [];
  return tasks.filter((task) => task.threadId === bot.homeThreadId);
}

export function botModelLabel(
  selection: ModelSelection,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): string {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  const modelName = model?.shortName ?? model?.name ?? selection.model;
  return entry ? `${entry.displayName} · ${modelName}` : modelName;
}

export const BOT_TASK_STATUS_LABELS: Record<BotTaskStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export function botTaskStatusVariant(
  status: BotTaskStatus,
): "info" | "warning" | "success" | "error" | "secondary" {
  switch (status) {
    case "working":
      return "info";
    case "waiting":
      return "warning";
    case "done":
      return "success";
    case "failed":
      return "error";
    case "stopped":
      return "secondary";
  }
}
