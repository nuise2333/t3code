import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId, RunId, type AssistantCitation } from "@t3tools/contracts";
import { createRef, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-workbench-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

async function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1000px; display: flex; flex-direction: column;";
  return render(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
    { container },
  );
}

describe("TimelineOutlineRail", () => {
  it("filters user questions, jumps to the selected turn, and collapses expanded steps", async () => {
    const props = baseProps();
    const runId = RunId.make("run-fold-1");
    const longReply = "Detailed explanation line.\n\n".repeat(40);
    const entries: Entry[] = [
      message("How do we configure Vite proxy?", {}, "user-1"),
      work("work-1", {
        runId,
        label: "Read vite.config.ts",
        toolTitle: "Read file",
        tone: "tool",
        toolLifecycleStatus: "completed",
      }),
      work("work-2", {
        runId,
        label: "Check server ports",
        toolTitle: "Run command",
        tone: "tool",
        toolLifecycleStatus: "completed",
      }),
      message(longReply, { role: "assistant", runId }, "assistant-1"),
      message("Why does WebSocket reconnect?", {}, "user-2"),
      message(longReply, { role: "assistant" }, "assistant-2"),
      message("Fix CSS outline flicker", {}, "user-3"),
      message(longReply, { role: "assistant" }, "assistant-3"),
    ];

    await using screen = await renderTimeline(entries, props);
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));

    // Open the outline popover from the top rail trigger.
    const trigger = screen.getByRole("button", { name: "Conversation outline" });
    await userEvent.click(trigger);

    const popover = screen.getByTestId("timeline-outline-popover");
    await expect.element(popover).toBeVisible();
    await expect.element(screen.getByText("Outline · 3")).toBeVisible();

    // Filter down to the first question.
    const filterInput = screen.getByRole("searchbox", { name: "Filter questions" });
    await userEvent.type(filterInput, "Vite proxy");
    await vi.waitFor(() => {
      const items = screen.container.querySelectorAll("[data-outline-item-id]");
      expect(items).toHaveLength(1);
      expect(items[0]?.textContent).toContain("How do we configure Vite proxy?");
    });

    // Click the filtered item to jump to the top turn.
    const matchButton =
      screen.container.querySelector<HTMLButtonElement>("[data-outline-item-id]")!;
    await userEvent.click(matchButton);

    await vi.waitFor(() => {
      expect(screen.container.querySelector('[data-testid="timeline-outline-popover"]')).toBeNull();
      const firstRow = screen.container.querySelector('[data-message-id="user-1"]');
      expect(firstRow).not.toBeNull();
    });

    // Expand the work fold on turn 1, then collapse all steps from the outline popover.
    const expandFoldButton = [
      ...screen.container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((btn) => btn.getAttribute("aria-expanded") === "false");
    expect(expandFoldButton).toBeDefined();
    await userEvent.click(expandFoldButton!);
    await vi.waitFor(() => expect(expandFoldButton!.getAttribute("aria-expanded")).toBe("true"));

    await userEvent.click(trigger);
    const collapseAllButton = screen.getByRole("button", { name: "Collapse all steps" });
    await expect.element(collapseAllButton).toBeEnabled();
    await userEvent.click(collapseAllButton);

    await vi.waitFor(() => expect(expandFoldButton!.getAttribute("aria-expanded")).toBe("false"));
  });
});

describe("TimelineContextMenu", () => {
  it("opens on right-click with message actions, disables Ask aside with a draft, and supports citations", async () => {
    let draftPresent = false;
    const onAskAsideWithCitation = vi.fn((_citation: AssistantCitation) => true);
    const onAskAsideEmpty = vi.fn(() => true);
    const onCompactContext = vi.fn();
    const onFreshSession = vi.fn();
    const onOpenModelPicker = vi.fn();

    const entries: Entry[] = [
      message("Check this snippet please", {}, "user-ctx-1"),
      message(
        "Here is the important sentence in the reply.",
        { role: "assistant" },
        "assistant-ctx-1",
      ),
    ];

    await using screen = await renderTimeline(entries, {
      hasComposerDraft: () => draftPresent,
      sideChatAvailable: true,
      onAskAsideAboutAssistantText: onAskAsideWithCitation,
      onAskAsideEmpty,
      onCompactContext,
      compactDisabled: false,
      onFreshSession,
      freshSessionDisabled: false,
      onOpenModelPicker,
    });

    const assistantTextEl = screen.container.querySelector<HTMLElement>(
      '[data-message-id="assistant-ctx-1"] p',
    )!;
    expect(assistantTextEl).not.toBeNull();

    // Right-click without selection -> Ask aside starts /btw empty.
    await act(async () => {
      assistantTextEl.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 200,
          clientY: 200,
        }),
      );
    });

    await expect.element(page.getByRole("menuitem", { name: "Copy message" })).toBeVisible();
    const askAsideItem = page.getByRole("menuitem", { name: /Ask aside/ });
    await expect.element(askAsideItem).toBeVisible();
    await userEvent.click(askAsideItem);
    expect(onAskAsideEmpty).toHaveBeenCalledTimes(1);

    // Quick slash commands that exist in T3 work from the menu.
    await act(async () => {
      assistantTextEl.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 200,
          clientY: 200,
        }),
      );
    });
    await userEvent.click(page.getByRole("menuitem", { name: /Compact context/ }));
    expect(onCompactContext).toHaveBeenCalledTimes(1);

    // Selecting assistant text and right-clicking routes Ask aside through citation path.
    const textNode = assistantTextEl.firstChild!;
    await act(async () => {
      const range = document.createRange();
      range.setStart(textNode, 12);
      range.setEnd(textNode, 30);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      assistantTextEl.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 200,
          clientY: 200,
        }),
      );
    });

    await expect.element(page.getByRole("menuitem", { name: "Copy selection" })).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: /Ask aside/ }));
    expect(onAskAsideWithCitation).toHaveBeenCalledTimes(1);
    expect(onAskAsideWithCitation.mock.calls[0]?.[0].text).toBe("important sentence");

    // When the composer holds a draft, Ask aside is disabled.
    draftPresent = true;
    await act(async () => {
      window.getSelection()?.removeAllRanges();
      assistantTextEl.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 200,
          clientY: 200,
        }),
      );
    });
    await expect
      .element(page.getByRole("menuitem", { name: /Ask aside/ }))
      .toHaveAttribute("aria-disabled", "true");

    // Keyboard Escape closes the menu.
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="timeline-context-menu"]')).toBeNull();
    });
  });
});

describe("Code block @ citation in MessagesTimeline", () => {
  it("cites an assistant code block via the existing assistant citation path", async () => {
    const onCiteAssistantText = vi.fn((_citation: AssistantCitation) => true);
    const entries: Entry[] = [
      message("Show me a command", {}, "user-code-1"),
      message(
        "Run this:\n\n```ts\nexport const port = 3773;\n```\n",
        { role: "assistant" },
        "assistant-code-1",
      ),
    ];

    await using screen = await renderTimeline(entries, {
      onCiteAssistantText,
    });

    const citeButton = screen.getByRole("button", { name: "Cite code block in composer" });
    await expect.element(citeButton).toBeVisible();
    await userEvent.click(citeButton);

    expect(onCiteAssistantText).toHaveBeenCalledTimes(1);
    const citation = onCiteAssistantText.mock.calls[0]?.[0];
    expect(citation?.messageId).toBe(MessageId.make("assistant-code-1"));
    expect(citation?.text).toContain("export const port = 3773;");
  });
});
