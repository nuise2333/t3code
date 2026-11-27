import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const sessions = vi.hoisted(() => ({
  listener: null as ((conflict: unknown) => void) | null,
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
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

import { FileMarkdownEditor } from "./FileMarkdownEditor";

it("hands every keystroke to the save session at once while a refused save waits", async () => {
  sessions.changed.length = 0;
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
  sessions.listener!({ base: "one\n\ntwo\n", disk: "ONE\n\ntwo\n", local: "one\n\ntwo\n" });
  await userEvent.click(screen.getByText("two"));
  await userEvent.keyboard("{End}!");
  // No 150 ms pause: the conflict bar must see this draft if it is clicked right away.
  expect(sessions.changed.at(-1)).toBe("one\n\ntwo!\n");
});
