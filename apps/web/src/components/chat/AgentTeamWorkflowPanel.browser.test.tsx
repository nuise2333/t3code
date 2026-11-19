import "~/index.css";
import { agentTeamProgress } from "@t3tools/client-runtime/routing";
import {
  NodeId,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AgentTeamWorkflowPanel } from "./AgentTeamWorkflowPanel";

const threadId = ThreadId.make("thread:lead");
const codex = ProviderInstanceId.make("codex");
const minute = (n: number) =>
  DateTime.makeUnsafe(`2026-11-17T09:${String(n).padStart(2, "0")}:00.000Z`);

function task(
  id: string,
  status: OrchestrationV2Subagent["status"],
  extra: Partial<OrchestrationV2Subagent>,
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId,
    runId: null,
    parentNodeId: NodeId.make("node:root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: codex,
    providerThreadId: null,
    childThreadId: ThreadId.make(`thread:${id}`),
    nativeTaskRef: null,
    prompt: `Assignment for ${id}`,
    title: null,
    model: "gpt-6",
    modelSelection: { instanceId: codex, model: "gpt-6" },
    status,
    result: null,
    startedAt: minute(0),
    completedAt: null,
    updatedAt: minute(0),
    ...extra,
  };
}

it("walks a team's handovers by keyboard and opens or stops a member's task", async () => {
  const onOpenThread = vi.fn();
  const onStopTask = vi.fn(async () => {});
  const lead = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
  await using screen = await render(
    <div className="h-150 w-96">
      <AgentTeamWorkflowPanel
        team={{
          name: "Crew",
          summary: "Opus leads GPT-6",
          leadLabel: "Opus",
          lead,
          workers: [
            { label: "GPT-6", selection: { instanceId: codex, model: "gpt-6" } },
            { label: "Fable", selection: { instanceId: codex, model: "fable" } },
          ],
          progress: agentTeamProgress({
            threadId,
            team: null,
            providers: [],
            subagents: [
              task("map", "completed", {
                title: "Map the parser",
                startedAt: minute(0),
                completedAt: minute(2),
                result: "Parser mapped",
              }),
              task("fix", "running", { title: "Fix the tokenizer", startedAt: minute(3) }),
            ],
          }),
        }}
        providers={[]}
        onOpenThread={onOpenThread}
        onStopTask={onStopTask}
      />
    </div>,
  );
  const agents = screen.getByRole("region", { name: "Agents" });
  await expect.element(agents.getByText("Lead")).toBeVisible();
  await expect.element(agents.getByText("Waiting on workers")).toBeVisible();
  await expect.element(agents.getByText(/Working · Fix the tokenizer/)).toBeVisible();
  await expect.element(agents.getByText("1/2 done")).toBeVisible();
  await expect.element(agents.getByText("Idle")).toBeVisible();
  const first = screen.getByRole("button", { name: /Map the parser/ });
  const second = screen.getByRole("button", { name: /Fix the tokenizer/ });
  await expect.element(second.getByText("Round 2")).toBeVisible();
  await expect
    .element(screen.getByRole("progressbar"))
    .toHaveAttribute("aria-valuetext", "1 of 2 done");

  first.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(first).toHaveAttribute("aria-expanded", "true");
  await expect
    .element(screen.getByRole("region", { name: /Map the parser/ }).getByText("Parser mapped"))
    .toBeVisible();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(first).toHaveAttribute("aria-expanded", "false");

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(second).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const details = screen.getByRole("region", { name: /Fix the tokenizer/ });
  await details.getByRole("button", { name: "Open thread" }).click();
  expect(onOpenThread).toHaveBeenCalledWith("thread:fix");
  await details.getByRole("button", { name: "Stop" }).click();
  expect(onStopTask).toHaveBeenCalledWith("fix");
});
