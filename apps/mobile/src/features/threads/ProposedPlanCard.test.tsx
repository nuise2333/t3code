import { RegistryContext } from "@effect/atom-react";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  let resolveFile = (_text: string) => {};
  const fileText = new Promise<string>((resolve) => {
    resolveFile = resolve;
  });
  return {
    navigate: vi.fn(),
    decide: vi.fn(async () => true),
    fileText,
    resolveFile: (text: string) => resolveFile(text),
  };
});

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({ View: ({ children }: Children) => <div>{children}</div> }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: harness.navigate }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/Chip", () => ({
  Chip: (props: { label: string }) => <span>{props.label}</span>,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn(), prompt: vi.fn() }));
vi.mock("../../i18n/I18nProvider", () => ({
  I18nProvider: ({ children }: Children) => children,
  useGT: () => (text: string) => text,
}));
vi.mock("../../state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const denied = Atom.make(false);
  return { projectEnvironment: { writeFile: { permissionAtom: () => denied } } };
});
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./CopyTextButton", () => ({ CopyTextButton: () => null }));
vi.mock("./planReview/usePlanDecision", () => ({
  usePlanDecision: () => ({
    structure: undefined,
    blockedReason: null,
    sending: null,
    decide: harness.decide,
  }),
}));
vi.mock("../../lib/atomic-file", () => ({ writeFileAtomically: vi.fn() }));
vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    exists = true;
    text = () => harness.fileText;
  },
  Paths: { document: "" },
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { ProposedPlanCard } from "./ProposedPlanCard";

const plan = {
  type: "proposed_plan",
  threadId: "thread",
  planId: "plan",
  markdown: "# Plan\n\n- Step one",
  streaming: false,
};

it("waits for the saved notes before a plan can be reviewed or approved", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ProposedPlanCard
          environmentId={"env" as never}
          workspaceRoot={null}
          plan={plan as never}
          renderMarkdown={(text) => <p>{text}</p>}
        />
      </RegistryContext.Provider>,
    ),
  );

  // Approving now would send the plan without the notes on disk, then clear them.
  expect(button("Review").disabled).toBe(true);
  expect(button("Approve and implement").disabled).toBe(true);
  await act(async () => button("Approve and implement").click());
  expect(harness.decide).not.toHaveBeenCalled();

  const saved = { annotations: [{ id: "a", action: "delete", quote: "Step one" }], general: "" };
  await act(async () =>
    harness.resolveFile(JSON.stringify({ drafts: { "env:thread:plan": saved } })),
  );
  expect(button("Review").disabled).toBe(false);
  await act(async () => button("Approve and implement").click());
  expect(harness.navigate).toHaveBeenCalledWith("ThreadPlanReview", {
    environmentId: "env",
    threadId: "thread",
    planId: "plan",
  });
  expect(harness.decide).not.toHaveBeenCalled();
  act(() => root.unmount());
});
