import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type Bot,
  type BotId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { BotAvatar, BOT_AVATAR_SIZE_CLASS } from "./BotAvatar";
import { channelFaces } from "./botChannels.logic";
import {
  resolveBotsEnvironmentId,
  templateUpsertInputs,
  type BotTeamTemplate,
} from "./botsPage.logic";

export function reportBotFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** A channel's members as overlapping faces: up to four, or three and a "+N". */
export function BotFaceCluster({
  memberIds,
  bots,
  size = "xs",
}: {
  readonly memberIds: ReadonlyArray<BotId>;
  readonly bots: ReadonlyArray<Bot>;
  readonly size?: "xs" | "sm";
}) {
  const { shown, extra } = channelFaces(memberIds, bots);
  if (shown.length === 0) {
    return (
      <span
        aria-hidden
        className={`flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ${BOT_AVATAR_SIZE_CLASS[size]}`}
      >
        #
      </span>
    );
  }
  return (
    <span aria-hidden className="flex shrink-0 items-center -space-x-1.5">
      {shown.map((bot) => (
        <span key={bot.id} className="rounded-full ring-2 ring-background">
          <BotAvatar bot={bot} size={size} />
        </span>
      ))}
      {extra > 0 ? (
        <span
          className={`flex items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-background ${BOT_AVATAR_SIZE_CLASS[size]}`}
        >
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

/** The environment bots are shown for when the viewer has not picked one. */
export function useDefaultBotsEnvironmentId(picked: EnvironmentId | null = null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  return resolveBotsEnvironmentId(picked, primaryEnvironmentId, connectedIds);
}

export function useBotModelContext(environmentId: EnvironmentId, projectId: ProjectId | null) {
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

/** Opening, pausing, duplicating and deleting a bot, shared by the Bots page and the sidebar. */
export function useBotActions(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  const openChat = useAtomCommand(serverEnvironment.openBotChat, { label: "bot open chat" });
  const deleteBot = useAtomCommand(serverEnvironment.deleteBot, { label: "bot delete" });
  const setBotPaused = useAtomCommand(serverEnvironment.setBotPaused, { label: "bot set paused" });
  const upsertBot = useAtomCommand(serverEnvironment.upsertBot, { label: "bot upsert" });
  const [busy, setBusy] = useState(false);

  const openBotChat = async (bot: Bot) => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result = await openChat({ environmentId, input: { id: bot.id } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportBotFailure(`Could not open ${bot.name}'s chat`, squashAtomCommandFailure(result));
      }
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
    });
  };

  /** Whether the bot was deleted. */
  const removeBot = async (bot: Bot): Promise<boolean> => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    const message = `Delete ${bot.name}?\nIts memories and task list go with it. Its chat and task threads stay as ordinary threads, and schedules made in its chat keep running there.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return false;
    setBusy(true);
    const result = await deleteBot({ environmentId, input: { id: bot.id } });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportBotFailure(`Could not delete ${bot.name}`, squashAtomCommandFailure(result));
      }
      return false;
    }
    return true;
  };

  const setPaused = async (bot: Bot, paused: boolean) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = await setBotPaused({ environmentId, input: { id: bot.id, paused } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportBotFailure(
          `Could not ${paused ? "pause" : "resume"} ${bot.name}`,
          squashAtomCommandFailure(result),
        );
      }
      return;
    }
    toastManager.add({ type: "success", title: `${bot.name} ${paused ? "paused" : "resumed"}` });
  };

  /** The copy is never the dispatcher, since a team has only one; the server picks its handle. */
  const duplicateBot = async (bot: Bot) => {
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const name = `${[...bot.name].slice(0, 55).join("")} copy`;
    const result = await upsertBot({
      environmentId,
      input: {
        name,
        title: bot.title,
        instructions: bot.instructions,
        dispatcher: false,
        modelSelection: bot.modelSelection,
        runtimeMode: bot.runtimeMode,
        projectId: bot.projectId,
        avatar: bot.avatar,
        color: bot.color,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportBotFailure(`Could not duplicate ${bot.name}`, squashAtomCommandFailure(result));
      }
      return;
    }
    toastManager.add({ type: "success", title: `${name} created` });
  };

  return { busy, openBotChat, removeBot, setPaused, duplicateBot };
}

export function useAddBotTeam(
  environmentId: EnvironmentId,
  bots: ReadonlyArray<Bot>,
  defaultModel: ModelSelection | null,
) {
  const upsertBot = useAtomCommand(serverEnvironment.upsertBot, { label: "bot upsert" });
  const [addingTeam, setAddingTeam] = useState(false);
  const dispatcher = bots.find((bot) => bot.dispatcher) ?? null;

  const addTeam = async (template: BotTeamTemplate) => {
    if (addingTeam || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const result = templateUpsertInputs(template, defaultModel, bots.length);
    if (!result.ok) {
      reportBotFailure(`Could not add ${template.name}`, result.error);
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
          reportBotFailure(`Could not add ${input.name}`, squashAtomCommandFailure(saved));
        }
        break;
      }
    }
    setAddingTeam(false);
  };

  return { addTeam, addingTeam };
}
