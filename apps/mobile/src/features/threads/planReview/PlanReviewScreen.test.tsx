import { RegistryContext } from "@effect/atom-react";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "@t3tools/client-runtime/planReview";
import type { EnvironmentId, PlanId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const environmentId = "env" as EnvironmentId;
const threadId = "thread" as ThreadId;
const planId = "plan-2" as PlanId;

const harness = vi.hoisted(() => ({
  goBack: vi.fn(),
  enqueue: vi.fn(async (_message: unknown) => {}),
  setDraftSettings: vi.fn(),
  nextId: 0,
}));

type Children = { children?: ReactNode };
type Press = { onPress?: () => void; disabled?: boolean; accessibilityLabel?: string };

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled, accessibilityLabel }: Children & Press) => (
    <div role="button" aria-label={accessibilityLabel} onClick={disabled ? undefined : onPress}>
      {children}
    </div>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: harness.goBack }),
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
  AppTextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => (
    <textarea
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: (props: Press & { label: string }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../../components/ui/IconButton", () => ({
  IconButton: (props: Press) => (
    <button type="button" aria-label={props.accessibilityLabel} onClick={props.onPress} />
  ),
}));
vi.mock("../../../components/ui/KeyboardSheetBody", () => ({
  KeyboardSheetBody: ({ children, toolbar }: Children & { toolbar?: ReactNode }) => (
    <div>
      {children}
      {toolbar}
    </div>
  ),
}));
vi.mock("../../../components/ui/SegmentedControl", () => ({
  SegmentedControl: (props: {
    options: ReadonlyArray<{ value: string; label: string }>;
    onSelect: (value: string) => void;
  }) => (
    <>
      {props.options.map((option) => (
        <button key={option.value} type="button" onClick={() => props.onSelect(option.value)}>
          {option.label}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../../../components/ui/SheetHeader", () => ({
  SheetHeader: (props: { title: string; subtitle?: string }) => (
    <h1>
      {props.title} {props.subtitle}
    </h1>
  ),
}));
vi.mock("../../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../../i18n/I18nProvider", () => ({
  I18nProvider: ({ children }: Children) => children,
  useGT:
    () =>
    (text: string, values: Record<string, unknown> = {}) =>
      text.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
      ),
}));
vi.mock("../../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: (props: { markdown: string }) => <p>{props.markdown}</p>,
}));
vi.mock("../../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("../../../lib/uuid", () => ({ uuidv4: () => `note-${(harness.nextId += 1)}` }));
vi.mock("../../../lib/commandMetadata", () => ({
  makeQueuedMessageMetadata: () => ({
    messageId: "message",
    commandId: "command",
    createdAt: "2026-11-27T00:00:00.000Z",
  }),
}));
vi.mock("../../../lib/atomic-file", () => ({ writeFileAtomically: vi.fn() }));
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    exists = false;
  },
  Paths: { document: "" },
}));
vi.mock("@t3tools/client-runtime/state/thread-execution", () => ({
  deriveThreadStructureRuntime: () => null,
}));
vi.mock("../../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../../state/entities", () => {
  const providers = [{ instanceId: "codex", showInteractionModeToggle: true }];
  return { useEnvironmentServerConfig: () => ({ providers }) };
});
vi.mock("../../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
}));
vi.mock("../../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: harness.enqueue }));
vi.mock("../../../state/use-thread-outbox", () => ({ useThreadOutboxMessages: () => ({}) }));
vi.mock("../../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => ({}),
  updateComposerDraftSettings: harness.setDraftSettings,
}));
vi.mock("../../../state/use-thread-detail", () => {
  const plan = { kind: "proposed_plan", threadId: "thread", runId: null, nodeId: "node" };
  const structure = {
    environmentId: "env",
    projection: {
      thread: {
        id: "thread",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
      },
      plans: [
        {
          ...plan,
          id: "plan-1",
          status: "superseded",
          markdown: "# Plan\n\n- Step one\n- Step two",
        },
        {
          ...plan,
          id: "plan-2",
          status: "active",
          markdown: "# Plan\n\n- Step one\n- Step 2 revised",
          previousPlanId: "plan-1",
          revision: 2,
        },
      ],
      visibleTurnItems: [],
    },
  };
  return { useQuietThreadStructure: () => structure };
});

import { appAtomRegistry } from "../../../state/atom-registry";
import { clearPlanReviewDraft, planReviewDraftKey } from "./planReviewDrafts";
import { PlanReviewScreen } from "./PlanReviewScreen";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.goBack.mockClear();
  harness.enqueue.mockClear();
  harness.setDraftSettings.mockClear();
  clearPlanReviewDraft(planReviewDraftKey("env:thread", planId));
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <PlanReviewScreen route={{ params: { environmentId, threadId, planId } } as never} />
      </RegistryContext.Provider>,
    ),
  );
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button, [role=button]")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    );
    if (!(found instanceof HTMLElement)) throw new Error(`No button "${label}"`);
    return found;
  };
  return {
    container,
    button,
    press: (label: string) => act(async () => button(label).click()),
    type: (label: string, value: string) =>
      act(() => {
        const input = container.querySelector(`textarea[aria-label="${label}"]`)!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

it("sends a plan back in plan mode with a note for each annotated part", async () => {
  using screen = setup();
  expect(screen.container.textContent).toContain("Review plan Revision 2");
  expect(screen.button("Request changes")).toHaveProperty("disabled", true);

  await screen.press("Step one");
  await screen.press("Delete");
  await screen.press("Step 2 revised");
  await screen.press("Replace");
  expect(screen.button("Save")).toHaveProperty("disabled", true);
  // Typed but never saved: sending must carry it all the same.
  screen.type("Replace with", "Step two, kept");
  expect(screen.container.textContent).toContain("Annotations (2)");

  await screen.press("Request changes");
  expect(harness.enqueue).toHaveBeenCalledOnce();
  expect(harness.enqueue.mock.calls[0]?.[0]).toMatchObject({
    environmentId,
    threadId,
    interactionMode: "plan",
    text: expect.stringContaining(
      [
        "## 1. Remove (line 3)\n> Step one\n\nThe user wants this part left out.",
        "## 2. Replace (line 4)\n> Step 2 revised\n\nReplace with:\nStep two, kept",
      ].join("\n\n"),
    ),
  });
  expect(harness.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("sourceProposedPlan");
  expect(harness.setDraftSettings).toHaveBeenCalledWith("env:thread", { interactionMode: "plan" });
  expect(harness.goBack).toHaveBeenCalledOnce();
});

it("drops a note that never got its text, and approves the plan as it stands", async () => {
  using screen = setup();
  await screen.press("Step one");
  await screen.press("Comment");
  screen.type("Comment", "why?");
  await screen.press("Cancel");
  expect(screen.container.textContent).toContain("Annotations (0)");

  await screen.press("Compare with previous");
  expect(screen.container.textContent).toContain("1 lines added, 1 removed");

  await screen.press("Approve and implement");
  expect(harness.enqueue.mock.calls[0]?.[0]).toMatchObject({
    interactionMode: "default",
    sourceProposedPlan: { threadId, planId },
    text: `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan\n\n- Step one\n- Step 2 revised`,
  });
  expect(harness.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("context");
  expect(harness.goBack).toHaveBeenCalledOnce();
});

it("keeps an approval's notes until the plan is answered, in case it does not go out", async () => {
  using screen = setup();
  await screen.press("Step one");
  await screen.press("Delete");

  await screen.press("Approve and implement");
  expect(harness.enqueue.mock.calls[0]?.[0]).toMatchObject({
    sourceProposedPlan: { threadId, planId },
    text: expect.stringContaining("## 1. Remove (line 3)\n> Step one"),
  });
  expect(screen.container.textContent).toContain("Annotations (1)");
});
