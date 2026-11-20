import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  type Bot,
  type BotColor,
  type EnvironmentId,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { useScratchProject } from "../../hooks/useScratchProject";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { reportBotFailure, useBotModelContext } from "./botShared";
import {
  BOT_AVATARS,
  BOT_COLORS,
  botDraftErrors,
  botToDraft,
  botUpsertInputFromDraft,
  emptyBotDraft,
  type BotDraft,
} from "./botsPage.logic";

// Project ids are trimmed, so the leading space never matches one.
const NO_PROJECT = " none";

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

export function BotEditorDialog({
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
  readonly onSaved?: (bot: Bot) => void;
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
  readonly onSaved: ((bot: Bot) => void) | undefined;
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
        reportBotFailure("Could not save the bot", squashAtomCommandFailure(result));
      }
      return;
    }
    onSaved?.(result.value.bot);
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
