import "../../index.css";

import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The draft route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("the new-thread project picker follows the manual sidebar project order", async () => {
  using _environment = installFakeEnvironment([], {
    extraProjects: [
      { id: ProjectId.make("project-alpha"), title: "alpha" },
      { id: ProjectId.make("project-beta"), title: "beta" },
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarProjectSortOrder: "manual",
  });
  useUiStateStore.setState({
    projectOrder: [
      `${ENVIRONMENT_ID}:/workspace/beta`,
      `${ENVIRONMENT_ID}:/workspace/render`,
      `${ENVIRONMENT_ID}:/workspace/alpha`,
    ],
  });
  using _order = { [Symbol.dispose]: () => useUiStateStore.setState({ projectOrder: [] }) };
  const draftId = DraftId.make("draft-manual-order");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  // The shell snapshot has arrived once the sidebar lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!trigger) throw new Error("The draft project picker did not render.");
  await userEvent.click(page.elementLocator(trigger));
  await expect.element(page.getByRole("option", { name: "beta" })).toBeVisible();

  // The draft's own project leads; the rest keep the sidebar's order.
  await vi.waitFor(() => {
    expect(
      page
        .getByRole("option")
        .elements()
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/render$/),
      expect.stringMatching(/beta$/),
      expect.stringMatching(/alpha$/),
      "Add project",
    ]);
  });
});

it("keeps the draft hero headline and usage panel top-left and clear of the bottom-pinned composer and mascots", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    homeStudioPanel: true,
    opticalMascot: "crab",
  });
  const draftId = DraftId.make("draft-hero-layout");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });

  await page.viewport(1440, 900);
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await vi.waitFor(() => {
    const headline = document.querySelector<HTMLElement>('[data-draft-hero-top="true"] h1');
    const panel = document.querySelector<HTMLElement>('[data-home-studio="panel"]');
    const meta = document.querySelector<HTMLElement>('[data-draft-hero-composer-meta="true"]');
    const composer = document.querySelector<HTMLElement>('[data-slot="composer-host"]');
    const mascot = document.querySelector<HTMLElement>(".optical-mascot");
    expect(headline).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(meta).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(mascot).not.toBeNull();

    const headlineRect = headline!.getBoundingClientRect();
    const panelRect = panel!.getBoundingClientRect();
    const metaRect = meta!.getBoundingClientRect();
    const composerRect = composer!.getBoundingClientRect();
    const mascotRect = mascot!.getBoundingClientRect();

    // Headline and usage panel sit at the top-left; composer is pinned near the bottom.
    expect(headlineRect.top).toBeLessThan(panelRect.top);
    expect(panelRect.bottom).toBeLessThan(mascotRect.top);
    expect(panelRect.bottom).toBeLessThan(metaRect.top);
    expect(metaRect.bottom).toBeLessThan(composerRect.top);
    expect(composerRect.bottom).toBeGreaterThan(window.innerHeight - 100);
    expect(panel!.scrollHeight).toBeLessThanOrEqual(panel!.clientHeight + 1);
  });

  // Very short windows hide the usage panel rather than scrolling or overlapping.
  await page.viewport(1280, 500);
  await vi.waitFor(() => {
    const panel = document.querySelector<HTMLElement>('[data-home-studio="panel"]');
    expect(panel?.getBoundingClientRect().height ?? 0).toBe(0);
  });
});
