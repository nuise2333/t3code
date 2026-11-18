import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_COUNCIL_DEFAULTS,
  type CouncilSettings,
  type EnvironmentId,
  type ThreadCouncil,
  type ThreadId,
  type ThreadTokenSaver,
  type TokenSaverSettings,
} from "@t3tools/contracts";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useServerConfigs } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useStableCallback } from "../../hooks/useStableCallback";
import { ComposerCouncilControl } from "./ComposerCouncilControl";
import { ComposerTokenSaverControl, EMPTY_TOKEN_SAVER } from "./ComposerTokenSaverControl";
import { draftThreadAssistsAtom, type DraftThreadAssists } from "./threadAssistsDraft";

const NO_DRAFT_ATOM = draftThreadAssistsAtom("");

/** What a running thread has; absent fields read as off. */
export interface ThreadAssistsState {
  readonly tokenSaver: ThreadTokenSaver | null | undefined;
  readonly council: ThreadCouncil | null | undefined;
  /** False for side chats and delegated tasks, which never convene a Council. */
  readonly councilApplies: boolean;
}

const settingsOf = (council: CouncilSettings): CouncilSettings => ({
  target: council.target,
  maxRounds: council.maxRounds,
  reviewers: council.reviewers,
});

/**
 * The token saver and Council controls for the composer. A new thread's choices wait on its
 * draft and launch with it; a running thread's change reaches its next message.
 */
export function ComposerThreadAssists(props: {
  readonly environmentId: EnvironmentId;
  readonly serverThreadId: ThreadId | undefined;
  readonly draftId: string | null | undefined;
  readonly thread: ThreadAssistsState | undefined;
  readonly size: "sm" | "xs";
}) {
  const serverConfig = useServerConfigs().get(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, "thread update");
  const draftAtom =
    props.serverThreadId === undefined && props.draftId
      ? draftThreadAssistsAtom(props.draftId)
      : NO_DRAFT_ATOM;
  const draft = useAtomValue(draftAtom);
  const setDraft = (patch: DraftThreadAssists) =>
    appAtomRegistry.set(draftAtom, { ...appAtomRegistry.get(draftAtom), ...patch });

  const defaultSaver = serverConfig?.settings.tokenSaverDefault ?? null;
  const councilDefaults = serverConfig?.settings.councilDefaults ?? DEFAULT_COUNCIL_DEFAULTS;
  const onServer = props.serverThreadId !== undefined;

  const saver: TokenSaverSettings = onServer
    ? (props.thread?.tokenSaver ?? EMPTY_TOKEN_SAVER)
    : draft.tokenSaver !== undefined
      ? (draft.tokenSaver ?? EMPTY_TOKEN_SAVER)
      : (defaultSaver ?? EMPTY_TOKEN_SAVER);
  const council: CouncilSettings | null = onServer
    ? (props.thread?.council ?? null)
    : draft.council !== undefined
      ? draft.council
      : councilDefaults.newThreads
        ? settingsOf(councilDefaults)
        : null;

  const dispatch = (patch: {
    readonly tokenSaver?: TokenSaverSettings | null;
    readonly council?: CouncilSettings | null;
  }) => {
    if (props.serverThreadId === undefined) {
      setDraft(patch);
      return;
    }
    void updateThreadMetadata({
      environmentId: props.environmentId,
      input: { threadId: props.serverThreadId, ...patch },
    });
  };
  const changeSaver = useStableCallback((next: TokenSaverSettings) =>
    dispatch({ tokenSaver: { packs: next.packs, level: next.level } }),
  );
  const changeDefaultSaver = useStableCallback((next: TokenSaverSettings | null) =>
    updateSettings({ tokenSaverDefault: next }),
  );
  const toggleCouncil = useStableCallback((on: boolean) =>
    dispatch({ council: on ? (council ?? settingsOf(councilDefaults)) : null }),
  );
  const changeCouncil = useStableCallback((next: CouncilSettings) => {
    // The panel's settings become the defaults; they reach this thread only while it is on.
    updateSettings({ councilDefaults: { ...councilDefaults, ...next } });
    if (council !== null) dispatch({ council: next });
  });
  const changeNewThreads = useStableCallback((on: boolean) =>
    updateSettings({ councilDefaults: { ...councilDefaults, newThreads: on } }),
  );

  if (serverConfig?.environment.capabilities.threadAssists !== true) return null;
  const councilApplies = !onServer || props.thread?.councilApplies !== false;
  return (
    <>
      <ComposerTokenSaverControl
        saver={saver}
        defaultSaver={defaultSaver}
        rtk={serverConfig.environment.capabilities.rtk === true}
        size={props.size}
        onChange={changeSaver}
        onDefaultChange={changeDefaultSaver}
      />
      {councilApplies ? (
        <ComposerCouncilControl
          on={council !== null}
          settings={council ?? settingsOf(councilDefaults)}
          newThreadsOn={councilDefaults.newThreads}
          size={props.size}
          onToggle={toggleCouncil}
          onSettingsChange={changeCouncil}
          onNewThreadsChange={changeNewThreads}
        />
      ) : null}
    </>
  );
}
