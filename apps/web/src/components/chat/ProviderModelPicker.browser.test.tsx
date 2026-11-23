import {
  DEFAULT_CLIENT_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerTeamSetup } from "./ComposerTeamSetup";
import { ComposerPickerFooter } from "./ComposerModelEffort";
import { ProviderModelPicker } from "./ProviderModelPicker";

it("keeps each registry image when adding a model from another ACP agent", async () => {
  const icons = [
    "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg",
    "https://cdn.agentclientprotocol.com/registry/v1/latest/picker-by-id.svg",
  ];
  const cache = await caches.open("t3-acp-registry-icons-v1");
  await using _cachedIcons = {
    async [Symbol.asyncDispose]() {
      await Promise.all(icons.map((url) => cache.delete(url)));
    },
  };
  for (const [index, url] of icons.entries()) {
    await cache.put(
      url,
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${11 + index * 6}" height="10"><path d="M0 0h10v10H0z"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
      ),
    );
  }
  const entries = deriveProviderInstanceEntries(
    ["First", "Second"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `${name} agent`,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  ).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { acpRegistryIconUrl: icons[0] } : { acpRegistryAgentId: "picker-by-id" }),
  }));
  const first = { instanceId: entries[0]!.instanceId, model: "first" };
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  function Picker() {
    const [selection, setSelection] = useState<ReadonlyArray<ModelSelection>>([first]);
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={first.instanceId}
        model={first.model}
        {...(selection.length > 1 ? { selectedModels: selection } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onToggleModel={(instanceId, model) => setSelection([...selection, { instanceId, model }])}
        onInstanceModelChange={(instanceId, model) => setSelection([{ instanceId, model }])}
      />
    );
  }

  await using screen = await render(<Picker />);
  const imageWidths = () =>
    Array.from(
      screen.container.querySelectorAll<HTMLImageElement>("[data-chat-provider-model-picker] img"),
      (image) => image.naturalWidth,
    );
  await vi.waitFor(() => expect(imageWidths()).toEqual([11]));
  await screen.getByRole("button", { name: "First model", exact: true }).click();
  await page.getByRole("button", { name: "Second agent", exact: true }).click();
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name: /Second model/ }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(imageWidths()).toEqual([11, 17]));
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker({ onViewUsage }: { onViewUsage: () => void }) {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        getModelEffort={(_, slug) =>
          slug === "original"
            ? { label: "High", tier: "high" }
            : slug === "second"
              ? { label: "Medium", tier: "medium" }
              : null
        }
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
        footer={<ComposerPickerFooter onViewUsage={onViewUsage} />}
      />
    );
  }

  const onViewUsage = vi.fn();
  await using screen = await render(<Picker onViewUsage={onViewUsage} />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await expect
    .element(page.getByRole("option", { name: /Original model/ }).getByText("High"))
    .toBeVisible();
  await expect
    .element(page.getByRole("option", { name: /Second model/ }).getByText("Medium"))
    .toBeVisible();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await page.getByRole("button", { name: "View Usage" }).click();
  expect(onViewUsage).toHaveBeenCalledOnce();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("opens on the active provider when every favorite belongs to a disabled provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: name === "Codex",
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex, claude] = entries;
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: claude!.instanceId, model: "claude" }],
  });
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Codex model/ })).toBeVisible();
});

it("keeps the touch keyboard down while choosing a provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex] = entries;
  const matchMedia = window.matchMedia.bind(window);
  using _touch = vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === "(pointer: coarse)"
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as MediaQueryList)
      : matchMedia(query),
  );

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  const popup = search.element().closest('[data-slot="popover-popup"]');
  await vi.waitFor(() => expect(document.activeElement).toBe(popup));

  await page.getByRole("button", { name: /^Claude/ }).click();
  await expect.element(page.getByRole("option", { name: /Claude model/ })).toBeVisible();
  await expect.element(search).not.toHaveFocus();
});

it("lists agent teams in a tab under Favorites and closes on a pick", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex] = entries;
  const onSelect = vi.fn();

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
      teams={{
        activeId: "content",
        saved: [{ id: "content", name: "Content team", summary: "Opus leads Fable" }],
        disabledReason: null,
        onSelect,
      }}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  const sidebar = document.querySelector("[data-model-picker-sidebar]")!;
  const tabs = Array.from(sidebar.querySelectorAll("button"), (button) =>
    button.getAttribute("aria-label"),
  );
  expect(tabs.slice(0, 2)).toEqual(["Favorites", "Agent team"]);

  await page.getByRole("button", { name: "Agent team", exact: true }).click();
  await expect
    .element(page.getByRole("option", { name: /Content team/ }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("option", { name: /Balanced team/ }).click();
  expect(onSelect).toHaveBeenCalledWith({ kind: "auto", auto: "balanced" });
  await expect.element(page.getByPlaceholder("Search models...")).not.toBeInTheDocument();
});

it("opens a team thread on its team and shows the setup beside the list", async () => {
  const entries = deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [{ slug: "codex", name: "Codex model", isCustom: false, capabilities: {} }],
      slashCommands: [],
      skills: [],
    },
  ]);
  const [codex] = entries;
  const onSelect = vi.fn();

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      triggerLabel="Content team"
      triggerIcon={<span data-testid="team-icon" />}
      onInstanceModelChange={() => {}}
      effortColumn={<div>Effort levels</div>}
      teams={{
        activeId: "content",
        saved: [{ id: "content", name: "Content team", summary: "Opus leads Fable" }],
        disabledReason: null,
        onSelect,
        setupColumn: <div>Team setup body</div>,
      }}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Choose model" });
  await expect.element(trigger).toHaveTextContent("Content team");
  await expect.element(screen.getByTestId("team-icon")).toBeInTheDocument();
  await trigger.click();
  await expect.element(page.getByText("Team setup body")).toBeVisible();
  await expect.element(page.getByText("Effort levels")).not.toBeInTheDocument();
  await page.getByRole("option", { name: /Balanced team/ }).click();
  expect(onSelect).toHaveBeenCalledWith({ kind: "auto", auto: "balanced" });
  await expect.element(page.getByText("Team setup body")).toBeVisible();

  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect.element(page.getByText("Effort levels")).toBeVisible();
  await expect.element(page.getByText("Team setup body")).not.toBeInTheDocument();
});

it("edits the team setup inside the picker without closing it", async () => {
  const entries = deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("codex"),
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
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              currentValue: "medium",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        }),
      })),
      slashCommands: [],
      skills: [],
    },
  ]);
  const [codex] = entries;
  const onApply = vi.fn();
  const onSaveTeams = vi.fn();

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="alpha"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
      effortColumn={<div>Effort levels</div>}
      teams={{
        activeId: null,
        saved: [],
        disabledReason: null,
        onSelect: () => {},
        setupColumn: (
          <ComposerTeamSetup
            teams={[]}
            active={null}
            newThread={false}
            entries={entries}
            currentSelection={{ instanceId: codex!.instanceId, model: "alpha" }}
            sharedGuidance=""
            onDone={() => {}}
            onSaveTeams={onSaveTeams}
            onApply={onApply}
            onDisable={() => {}}
          />
        ),
      }}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await page.getByRole("button", { name: "Agent team", exact: true }).click();
  const setup = page.getByRole("form", { name: "Architect & workers" });
  await expect.element(setup).toBeVisible();
  await setup.getByRole("combobox", { name: "Worker 1 model" }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill("bet");
  await expect.element(page.getByRole("option", { name: /Alpha model/ })).not.toBeInTheDocument();
  await page.getByRole("option", { name: /Beta model/ }).click();
  await setup.getByRole("textbox").fill("Plan first");
  const efforts = setup.element().querySelectorAll("[data-team-member-effort] button");
  expect(efforts).toHaveLength(2);
  (efforts[1] as HTMLButtonElement).click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect.element(setup).toBeVisible();
  await setup.getByRole("button", { name: "Save setup" }).click();
  expect(onApply).toHaveBeenCalledWith(
    expect.objectContaining({
      leadGuidance: "Plan first",
      members: [
        { instanceId: codex!.instanceId, model: "alpha" },
        {
          instanceId: codex!.instanceId,
          model: "beta",
          options: [{ id: "thought_level", value: "high" }],
        },
      ],
    }),
  );
});
