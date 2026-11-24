import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/entities"), () => ({
  useServerConfigs: (() => new Map()) as never,
}));

import { render } from "../../../test/render";
import { ComposerTelemetryVial } from "./ComposerTelemetryVial";

const ENV_ID = EnvironmentId.make("environment");
const INSTANCE_ID = ProviderInstanceId.make("antigravity");
const PROVIDER_THREAD_ID = ProviderThreadId.make("provider-thread-1");

function makeProvider(usedPercent = 70): ServerProvider {
  return {
    provider: "antigravity",
    driver: "antigravity",
    instanceId: INSTANCE_ID,
    displayName: "Gemini",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-23T02:00:00.000Z",
    slashCommands: [],
    skills: [],
    models: [],
    usageLimits: {
      checkedAt: "2026-11-23T02:00:00.000Z",
      windows: [
        {
          id: "5h",
          label: "5h window",
          usedPercent,
          resetsAt: "2026-11-23T04:30:00.000Z",
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPercent: 30,
        },
      ],
    },
  } as unknown as ServerProvider;
}

function makeClaudeProvider(): ServerProvider {
  return {
    ...makeProvider(),
    provider: "claudeAgent",
    driver: "claudeAgent",
    instanceId: ProviderInstanceId.make("claudeAgent"),
    displayName: "Claude",
    usageLimits: {
      checkedAt: "2026-11-23T02:00:00.000Z",
      windows: [{ id: "opus", label: "Opus weekly", usedPercent: 10 }],
    },
  } as unknown as ServerProvider;
}

function makeContextWindow(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    usedTokens: 20_480,
    totalProcessedTokens: null,
    maxTokens: 512_000,
    remainingTokens: 491_520,
    usedPercentage: 4,
    remainingPercentage: 96,
    inputTokens: 20_000,
    cachedInputTokens: 0,
    outputTokens: 307,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: 2,
    durationMs: 10_000,
    compactsAutomatically: true,
    autoCompactThreshold: null,
    cost: null,
    updatedAt: "2026-11-23T02:00:10.000Z",
    ...overrides,
  };
}

it("opens the context vial popover with quotas and runs the compact action", async () => {
  const onCompactContext = vi.fn();
  await using screen = await render(
    <div className="@container/composer-surface w-160">
      <ComposerTelemetryVial
        environmentId={ENV_ID}
        contextWindow={makeContextWindow()}
        activeProviderThreadId={PROVIDER_THREAD_ID}
        providerTurns={[
          {
            id: "turn-1" as never,
            providerThreadId: PROVIDER_THREAD_ID,
            nodeId: "node-1" as never,
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-11-23T02:00:00.000Z"),
            completedAt: DateTime.makeUnsafe("2026-11-23T02:00:10.000Z"),
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              inputTokens: 20_000,
              cachedInputTokens: 0,
              outputTokens: 307,
              hasSubagents: false,
            },
          },
        ]}
        providerInstanceId={INSTANCE_ID}
        providers={[makeClaudeProvider(), makeProvider(70)]}
        usageLimitSources={[]}
        modelLabel="Gemini 4 Neon"
        modelSlug="gemini-4-neon"
        isStreaming={false}
        compactDisabled={false}
        onCompactContext={onCompactContext}
      />
    </div>,
    // Isolated popover interaction test; no routes are navigated.
    { router: false },
  );

  const trigger = screen.getByRole("button", { name: /Context window 4% used/i });
  await expect.element(trigger).toBeVisible();
  await expect.element(screen.getByText("30.7")).toBeVisible();
  await expect.element(screen.getByText("0.0%")).toBeVisible();
  await expect.element(screen.getByText("4%")).toBeVisible();

  await userEvent.click(trigger);

  await expect.element(page.getByText("4% used")).toBeVisible();
  await expect.element(page.getByText("20k / 512k tokens")).toBeVisible();
  await expect.element(page.getByText("Tight")).toBeVisible();
  await expect.element(page.getByText("5h window")).toBeVisible();
  // Every provider with quotas gets a tab; the thread's provider is shown first.
  const quotaTabs = page.getByRole("group", { name: "Provider quotas" });
  await expect
    .element(quotaTabs.getByRole("button", { name: "Gemini" }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.click(quotaTabs.getByRole("button", { name: "Claude" }));
  await expect.element(page.getByText("Opus weekly")).toBeVisible();
  await userEvent.click(quotaTabs.getByRole("button", { name: "Gemini" }));
  await expect.element(page.getByText("5h window")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Tools" }));
  await expect.element(page.getByText(/Tool Output · ~/)).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Compact" }));
  expect(onCompactContext).toHaveBeenCalledTimes(1);
});

it("disables Compact when compactDisabled is true and omits unavailable speed/cache", async () => {
  const onCompactContext = vi.fn();
  await using screen = await render(
    <div className="@container/composer-surface w-160">
      <ComposerTelemetryVial
        environmentId={ENV_ID}
        contextWindow={makeContextWindow({
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          durationMs: null,
        })}
        providerTurns={[]}
        providerInstanceId={INSTANCE_ID}
        providers={[makeProvider(90)]}
        usageLimitSources={[]}
        modelLabel="Claude Sonnet"
        modelSlug="claude-sonnet-4-6"
        isStreaming={false}
        compactDisabled
        onCompactContext={onCompactContext}
      />
    </div>,
    // Isolated popover interaction test; no routes are navigated.
    { router: false },
  );

  const trigger = screen.getByRole("button", { name: /Context window 4% used/i });
  await expect.element(trigger).not.toHaveTextContent("tok/s");
  await expect.element(trigger).not.toHaveTextContent("cache");

  await userEvent.click(trigger);
  await expect.element(page.getByText("Low quota")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Compact" })).toBeDisabled();
  expect(onCompactContext).not.toHaveBeenCalled();
});
