import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const sessions = vi.hoisted(() => ({
  listener: null as ((conflict: unknown) => void) | null,
  resolved: [] as string[],
  changed: [] as string[],
}));

vi.mock(import("./fileSaveSessions"), async (original) => ({
  ...(await original()),
  changeFileSaveSession: (_target, contents) => {
    sessions.changed.push(contents);
  },
  subscribeFileSaveConflict: (_target, listener) => {
    sessions.listener = listener as (conflict: unknown) => void;
    return () => {
      sessions.listener = null;
    };
  },
  resolveFileSaveConflict: (_target, contents) => {
    sessions.resolved.push(contents);
  },
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { FileMarkdownEditor } from "./FileMarkdownEditor";

function setup() {
  sessions.listener = null;
  sessions.resolved.length = 0;
  sessions.changed.length = 0;
}

it("shows a refused save as a conflict, keeps the draft, and settles it through the session", async () => {
  setup();
  const environmentId = EnvironmentId.make("conflict-test");
  await using screen = await render(
    <FileMarkdownEditor
      environmentId={environmentId}
      cwd="/workspace"
      relativePath="notes.md"
      contents={"one\n\ntwo\n"}
      threadRef={{ environmentId, threadId: ThreadId.make("thread-1") }}
      workspaceMutationId={null}
    />,
    { router: false }, // The editor reads no route.
  );
  await vi.waitFor(() => expect(sessions.listener).not.toBeNull());
  // The session refused a write: the disk changed the same line the draft did.
  sessions.listener!({
    base: "one\n\ntwo\n",
    disk: "ONE (agent)\n\ntwo\n",
    local: "one (mine)\n\ntwo\n",
  });
  await expect
    .element(screen.getByText("This file changed on disk", { exact: false }))
    .toBeVisible();
  await expect.element(screen.getByText("one (mine)")).toBeVisible();

  await screen.getByRole("button", { name: "Keep mine" }).click();
  expect(sessions.resolved).toEqual(["one (mine)\n\ntwo\n"]);
  expect(screen.getByText("This file changed on disk", { exact: false }).query()).toBeNull();
});

it("settles a refused save with the disk's version when chosen", async () => {
  setup();
  const environmentId = EnvironmentId.make("conflict-test");
  await using screen = await render(
    <FileMarkdownEditor
      environmentId={environmentId}
      cwd="/workspace"
      relativePath="notes.md"
      contents={"one\n\ntwo\n"}
      threadRef={{ environmentId, threadId: ThreadId.make("thread-1") }}
      workspaceMutationId={null}
    />,
    { router: false }, // The editor reads no route.
  );
  await vi.waitFor(() => expect(sessions.listener).not.toBeNull());
  sessions.listener!({
    base: "one\n\ntwo\n",
    disk: "ONE (agent)\n\ntwo\n",
    local: "one (mine)\n\ntwo\n",
  });
  await screen.getByRole("button", { name: "Use disk version" }).click();
  expect(sessions.resolved).toEqual(["ONE (agent)\n\ntwo\n"]);
  await expect.element(screen.getByText("ONE (agent)")).toBeVisible();
});
