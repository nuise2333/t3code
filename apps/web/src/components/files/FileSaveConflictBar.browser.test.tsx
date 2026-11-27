import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const sessions = vi.hoisted(() => ({
  listener: null as ((conflict: unknown) => void) | null,
  resolved: [] as string[],
}));

vi.mock(import("./fileSaveSessions"), async (original) => ({
  ...(await original()),
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

import { FileSaveConflictBar } from "./FileSaveConflictBar";

const target = { environmentId: EnvironmentId.make("env"), cwd: "/w", relativePath: "a.md" };
const conflict = { base: "one\ntwo\n", disk: "ONE (agent)\ntwo\n", local: "one (mine)\ntwo\n" };

it.each([
  ["Keep mine", conflict.local],
  ["Use disk version", conflict.disk],
])("writes the version picked with %s", async (button, written) => {
  sessions.resolved.length = 0;
  await using screen = await render(<FileSaveConflictBar target={target} />, { router: false }); // Reads no route.
  await vi.waitFor(() => expect(sessions.listener).not.toBeNull());
  expect(screen.getByRole("alert").query()).toBeNull();
  sessions.listener!(conflict);
  await screen.getByRole("button", { name: button }).click();
  expect(sessions.resolved).toEqual([written]);
});

it("writes both sides, marked, with Insert conflict markers", async () => {
  sessions.resolved.length = 0;
  await using screen = await render(<FileSaveConflictBar target={target} />, { router: false }); // Reads no route.
  await vi.waitFor(() => expect(sessions.listener).not.toBeNull());
  sessions.listener!(conflict);
  await screen.getByRole("button", { name: "Insert conflict markers" }).click();
  expect(sessions.resolved[0]).toContain("one (mine)");
  expect(sessions.resolved[0]).toContain("ONE (agent)");
  expect(sessions.resolved[0]).toContain("<<<<<<<");
});
