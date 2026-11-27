import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadAgentTeam,
  ThreadId,
} from "@t3tools/contracts";
import { type ComponentProps, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { ComposerControlsBar } from "./ComposerControlsBar";
import { draftThreadAssistsAtom } from "./threadAssistsDraft";

const mocks = vi.hoisted(() => ({
  serverConfigs: new Map<string, unknown>(),
  updateSettings: vi.fn(),
  runCommand: vi.fn(),
  applyThreadModelPick: vi.fn(),
}));

vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useServerConfigs: () => mocks.serverConfigs,
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useUpdateEnvironmentSettings: () => mocks.updateSettings,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.runCommand }));
vi.mock("./useApplyThreadModelPick", () => ({
  useApplyThreadModelPick: () => mocks.applyThreadModelPick,
}));
vi.mock("./ComposerThreadAssists", () => ({ ComposerThreadAssists: () => null }));

const environmentId = EnvironmentId.make("env-team");
const codex = ProviderInstanceId.make("codex");
const alpha: ModelSelection = { instanceId: codex, model: "alpha" };
const betaHigh: ModelSelection = {
  instanceId: codex,
  model: "beta",
  options: [{ id: "thought_level", value: "high" }],
};
const contentTeam = {
  id: "content",
  name: "Content team",
  strategy: "order" as const,
  team: true,
  members: [betaHigh, alpha],
};
const provider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: ["Alpha", "Beta"].map((name) => ({
    slug: name.toLowerCase(),
    name: `${name} model`,
    isCustom: false,
    capabilities: {},
  })),
  slashCommands: [],
  skills: [],
};
const entries = deriveProviderInstanceEntries([provider]);

/** The remembered automatic team is Best; Balanced has a lead and Cheap has none. */
function setup() {
  mocks.updateSettings.mockReset();
  mocks.runCommand.mockReset();
  mocks.applyThreadModelPick.mockReset();
  mocks.serverConfigs = new Map([
    [
      environmentId,
      {
        environment: { capabilities: { agentTeams: true, routingGroups: true } },
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          routingGroups: [contentTeam],
          agentTeamDefault: "best",
          agentTeamLeads: { balanced: betaHigh },
        },
      },
    ],
  ]);
}

type BarProps = ComponentProps<typeof ComposerControlsBar>;

function Bar(
  props: Pick<BarProps, "routeKind" | "routeThreadRef" | "draftId" | "onProviderModelSelect"> & {
    readonly agentTeam?: ThreadAgentTeam | null;
  },
) {
  const [open, setOpen] = useState(true);
  return (
    <AppAtomRegistryProvider>
      <ComposerControlsBar
        environmentId={environmentId}
        workspaceCwd={null}
        routeKind={props.routeKind}
        routeThreadRef={props.routeThreadRef}
        draftId={props.draftId}
        selectedProvider={provider.driver}
        selectedInstanceId={codex}
        selectedModel="alpha"
        selectedProviderModels={provider.models}
        composerModelOptions={null}
        reportedModelSelection={null}
        promptUltrathink="none"
        onPromptEdit={() => {}}
        effortDisplay="label"
        permissionsShownInStrip={false}
        compatibleRuntimeMode="approval-required"
        defaultRuntimeMode="approval-required"
        compatibleRuntimeModeOptions={[]}
        handleRuntimeModeChange={() => {}}
        composerControlsCollapsed={false}
        composerControlsHidden={false}
        restingHiddenBlockCount={0}
        iconOnlyBlockCount={0}
        showProviderUnavailable={false}
        providerSetupInstanceId={undefined}
        onOpenProviderSetup={() => {}}
        providerCatalogPending={false}
        isSendBusy={false}
        multipleModelsEnabled={false}
        multipleModelSelections={null}
        onMultipleModelSelectionsChange={() => {}}
        selectedModelSelection={alpha}
        onProviderModelSelect={props.onProviderModelSelect}
        activeThreadModelSelection={alpha}
        activeThreadRouting={null}
        activeThreadAgentTeam={props.agentTeam}
        activeThreadAssists={undefined}
        selectedModelForPickerWithCustomFallback="alpha"
        lockedProvider={null}
        lockedContinuationGroupKey={null}
        providerInstanceEntries={entries}
        keybindings={[]}
        modelOptionsByInstance={new Map([[codex, provider.models]])}
        terminalOpen={false}
        modelPickerOpen={open}
        onModelPickerOpenChange={setOpen}
        modelPickerIconClassName={undefined}
        getModelDisabledReason={() => null}
      />
    </AppAtomRegistryProvider>
  );
}

const pickTeam = async (name: RegExp) => {
  const row = page.getByRole("option", { name });
  await row.click();
  await expect.element(row).toHaveAttribute("aria-checked", "true");
};
const pickAlphaInItsProviderTab = async () => {
  await page.getByRole("button", { name: /^Codex/ }).click();
  await page.getByRole("option", { name: /Alpha model/ }).click();
};

it("runs a new thread on its team's lead until a model is picked in a provider tab", async () => {
  setup();
  const draftId = DraftId.make("draft-team-lead");
  const onProviderModelSelect = vi.fn();
  const draft = () => useComposerDraftStore.getState().getComposerDraft(draftId);
  const team = () => appAtomRegistry.get(draftThreadAssistsAtom(draftId)).agentTeam;
  await using _screen = await render(
    <Bar
      routeKind="draft"
      routeThreadRef={scopeThreadRef(environmentId, ThreadId.make("thread-draft"))}
      draftId={draftId}
      onProviderModelSelect={onProviderModelSelect}
    />,
  );

  await pickTeam(/Content team/);
  expect(draft()).toMatchObject({
    routingGroupId: "content",
    modelSelectionByProvider: { [codex]: betaHigh },
  });
  expect(team()).toEqual({ id: "content", name: "Content team" });

  await pickTeam(/Balanced team/);
  expect(mocks.updateSettings).toHaveBeenLastCalledWith({ agentTeamDefault: "balanced" });
  expect(draft()?.routingGroupId).toBeUndefined();
  expect(draft()?.modelSelectionByProvider[codex]).toEqual(betaHigh);
  expect(team()).toEqual({ id: "auto-balanced", name: "Balanced team" });

  // Cheap has no lead, so the draft keeps the model it has.
  await pickTeam(/Cheap team/);
  expect(draft()?.modelSelectionByProvider[codex]).toEqual(betaHigh);
  expect(team()).toEqual({ id: "auto-cheap", name: "Cheap team" });
  // Switching to a lead is not a pick in the list: it left no team on the way.
  expect(onProviderModelSelect).not.toHaveBeenCalled();
  expect(mocks.updateSettings).not.toHaveBeenCalledWith({ agentTeamDefault: null });

  await pickAlphaInItsProviderTab();
  expect(onProviderModelSelect).toHaveBeenCalledWith(codex, "alpha");
  expect(team()).toBeNull();
  expect(mocks.updateSettings).toHaveBeenLastCalledWith({ agentTeamDefault: null });
});

it("switches a started thread to its team's lead and leaves the team on a model pick", async () => {
  setup();
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-team-lead"));
  // Stands in for the composer's own pick, which stores the model with its remembered options.
  const onProviderModelSelect = vi.fn((instanceId: ProviderInstanceId, model: string) => {
    useComposerDraftStore
      .getState()
      .setModelSelection(
        threadRef,
        { instanceId, model },
        { explicit: true, replaceOptions: true },
      );
  });
  const shown = () =>
    useComposerDraftStore.getState().getComposerDraft(threadRef)?.modelSelectionByProvider[codex];
  const teamChange = (agentTeam: ThreadAgentTeam | null) => ({
    environmentId,
    input: { threadId: threadRef.threadId, agentTeam },
  });
  // The thread's team comes back from the server, so each accepted change is rendered again.
  const bar = (agentTeam: ThreadAgentTeam | null) => (
    <Bar
      routeKind="server"
      routeThreadRef={threadRef}
      draftId={null}
      onProviderModelSelect={onProviderModelSelect}
      agentTeam={agentTeam}
    />
  );
  const content = { id: "content", name: "Content team" };
  const balanced = { id: "auto-balanced", name: "Balanced team" };
  await using screen = await render(bar({ id: "auto-cheap", name: "Cheap team" }));

  await page.getByRole("option", { name: /Content team/ }).click();
  expect(onProviderModelSelect).toHaveBeenLastCalledWith(codex, "beta", { focusComposer: false });
  expect(shown()).toEqual(betaHigh);
  expect(mocks.applyThreadModelPick).toHaveBeenCalledWith(threadRef);
  expect(mocks.runCommand).toHaveBeenLastCalledWith(teamChange(content));
  await screen.rerender(bar(content));

  await page.getByRole("option", { name: /Balanced team/ }).click();
  expect(mocks.runCommand).toHaveBeenLastCalledWith(teamChange(balanced));
  expect(shown()).toEqual(betaHigh);
  expect(mocks.runCommand).not.toHaveBeenCalledWith(teamChange(null));
  await screen.rerender(bar(balanced));

  await pickAlphaInItsProviderTab();
  expect(onProviderModelSelect).toHaveBeenLastCalledWith(codex, "alpha");
  expect(mocks.runCommand).toHaveBeenLastCalledWith(teamChange(null));
  expect(mocks.updateSettings).toHaveBeenLastCalledWith({ agentTeamDefault: null });
});

it("keeps a started thread out of a team whose lead it cannot switch to", async () => {
  setup();
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-team-locked"));
  // The composer refuses the switch, as it does across providers or checkouts.
  const onProviderModelSelect = vi.fn();
  await using _screen = await render(
    <Bar
      routeKind="server"
      routeThreadRef={threadRef}
      draftId={null}
      onProviderModelSelect={onProviderModelSelect}
      agentTeam={{ id: "auto-cheap", name: "Cheap team" }}
    />,
  );

  await page.getByRole("option", { name: /Content team/ }).click();
  expect(onProviderModelSelect).toHaveBeenLastCalledWith(codex, "beta", { focusComposer: false });
  expect(mocks.runCommand).not.toHaveBeenCalled();
  await page.getByRole("option", { name: /Balanced team/ }).click();
  expect(mocks.runCommand).not.toHaveBeenCalled();
  expect(mocks.updateSettings).not.toHaveBeenCalledWith({ agentTeamDefault: "balanced" });
});
