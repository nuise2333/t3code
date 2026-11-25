import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type RouteDecision, type RoutingGroup } from "@t3tools/contracts";
import { agentTeamHandsTo } from "@t3tools/shared/agentTeam";

import {
  activeAgentTeam,
  agentTeamLeadPrompt,
  agentTeamMemberTask,
  agentTeamTarget,
  autoTeamLeadPrompt,
} from "./AgentTeam.ts";

const claude = ProviderInstanceId.make("claude_fake");
const codex = ProviderInstanceId.make("codex_fake");

const team: RoutingGroup = {
  id: "reviewers",
  name: "Reviewers",
  strategy: "order",
  team: true,
  members: [
    { instanceId: claude, model: "opus-fake", options: [{ id: "effort", value: "high" }] },
    { instanceId: codex, model: "gpt-fake" },
  ],
};

const launchedOn = (
  member: { instanceId: ProviderInstanceId; model: string },
  teamFlag = true,
): RouteDecision => ({
  taskClass: "implement",
  effort: null,
  applied: false,
  reasons: [],
  group: {
    id: "reviewers",
    name: "Reviewers",
    via: "picker",
    ...(teamFlag ? { team: true as const } : {}),
    chosen: 0,
    member,
    skipped: [],
  },
});

const teamId = (active: ReturnType<typeof activeAgentTeam>) =>
  active === null ? null : active.kind === "saved" ? active.team.id : active.id;

describe("activeAgentTeam", () => {
  it("reads an automatic team without any saved team", () => {
    const active = activeAgentTeam({
      routing: null,
      agentTeam: { id: "auto-balanced", name: "Balanced team" },
      modelSelection: { instanceId: codex, model: "gpt-fake" },
      groups: [],
    });
    expect(active).toMatchObject({ kind: "auto", auto: "balanced", name: "Balanced team" });
    if (active?.kind !== "auto") return;
    const prompt = autoTeamLeadPrompt(active, "");
    expect(prompt).toContain("Leave `target` out and set `subtask`");
    expect(prompt).toContain("best value among widely used models");
    expect(prompt).not.toContain("At most two rounds");
    const best = activeAgentTeam({
      routing: null,
      agentTeam: { id: "auto-best", name: "Best team" },
      modelSelection: { instanceId: claude, model: "opus-fake" },
      groups: [],
    });
    if (best?.kind !== "auto") throw new Error("expected the Best team");
    expect(autoTeamLeadPrompt(best, "")).toContain("At most two rounds");
  });

  const lead = { instanceId: claude, model: "opus-fake" };
  const other = { instanceId: codex, model: "gpt-fake" };

  it("leads only while the thread keeps its launch member and the team exists", () => {
    const routing = launchedOn(lead);
    const leads = (input: Partial<Parameters<typeof activeAgentTeam>[0]>) =>
      activeAgentTeam({
        routing,
        agentTeam: undefined,
        modelSelection: lead,
        groups: [team],
        ...input,
      });
    expect(teamId(leads({}))).toBe("reviewers");
    // Picking another model leaves the team.
    expect(leads({ modelSelection: other })).toBeNull();
    // A deleted team, or a group that was not a team at launch, leads nothing.
    expect(leads({ groups: [] })).toBeNull();
    expect(leads({ routing: launchedOn(lead, false) })).toBeNull();
    const { team: _team, ...plainGroup } = team;
    expect(leads({ groups: [plainGroup] })).toBeNull();
  });

  it("follows a team the user turned on or off after launch", () => {
    const turnedOn = { id: "reviewers", name: "Reviewers" };
    // Turned on in a thread that launched on its own: whichever model the thread runs leads.
    expect(
      teamId(
        activeAgentTeam({
          routing: null,
          agentTeam: turnedOn,
          modelSelection: other,
          groups: [team],
        }),
      ),
    ).toBe("reviewers");
    // Turned off, even in a thread that launched through the team.
    expect(
      activeAgentTeam({
        routing: launchedOn(lead),
        agentTeam: null,
        modelSelection: lead,
        groups: [team],
      }),
    ).toBeNull();
    // A team turned on and then deleted leads nothing.
    expect(
      activeAgentTeam({ routing: null, agentTeam: turnedOn, modelSelection: lead, groups: [] }),
    ).toBeNull();
  });
});

describe("agentTeamTarget", () => {
  it("fits a member target and fills its saved options", () => {
    expect(agentTeamTarget(team, { model: "opus-fake" })).toEqual({
      ok: true,
      index: 0,
      target: {
        providerInstanceId: claude,
        model: "opus-fake",
        options: [{ id: "effort", value: "high" }],
      },
    });
    expect(
      agentTeamTarget(team, {
        driverKind: "codex" as never,
        providerInstanceId: codex,
        model: "gpt-fake",
        options: [],
      }),
    ).toEqual({
      ok: true,
      index: 1,
      target: { providerInstanceId: codex, model: "gpt-fake", options: [] },
    });
  });

  it("refuses models outside the team, an ambiguous target, and other environments", () => {
    for (const target of [
      { model: "haiku-fake" },
      { providerInstanceId: codex, model: "opus-fake" },
      undefined,
      { model: "gpt-fake", environmentId: "env-other" as never },
    ]) {
      const result = agentTeamTarget(team, target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("model `gpt-fake`");
    }
  });
});

describe("named members", () => {
  const role = (name: string, description = "", instructions = "") => ({
    name,
    description,
    instructions,
  });
  const named: RoutingGroup = {
    ...team,
    members: [...team.members, { instanceId: codex, model: "gpt-fake" }],
    memberRoles: [
      role(""),
      role("Builder", "Writes the code", "Run the tests."),
      role("Reviewer", "Checks diffs"),
    ],
    sharedGuidance: "Answer in Chinese.",
  };

  it("tells members on one model apart by name", () => {
    expect(agentTeamTarget(named, undefined, " reviewer ")).toMatchObject({ ok: true, index: 2 });
    const oneNamed = { ...named, memberRoles: [role(""), role(""), role("Reviewer")] };
    expect(agentTeamTarget(oneNamed, { model: "gpt-fake" })).toMatchObject({ ok: true, index: 1 });
    expect(agentTeamTarget(oneNamed, undefined, "Reviewer")).toMatchObject({ index: 2 });
    for (const result of [
      // A target that fits several models never falls to the one without a name.
      agentTeamTarget(oneNamed, undefined),
      agentTeamTarget(
        { ...named, members: named.members.map((m) => ({ ...m, instanceId: codex })) },
        { providerInstanceId: codex },
      ),
      agentTeamTarget(named, { model: "gpt-fake" }),
      agentTeamTarget(named, undefined, "Nobody"),
      agentTeamTarget(named, { model: "opus-fake" }, "Reviewer"),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("member `Reviewer`");
    }
  });

  it("tells the lead each role, and a member its own role with the team's guidance", () => {
    const prompt = agentTeamLeadPrompt(named, "");
    expect(prompt).toContain(
      "- member `Builder`, providerInstanceId `codex_fake`, model `gpt-fake`: Writes the code",
    );
    expect(prompt).toContain("Answer in Chinese.");
    expect(prompt).not.toContain("Run the tests.");
    const task = agentTeamMemberTask(named, 1, "Build it");
    expect(task.startsWith("Build it\n")).toBe(true);
    expect(task).toContain("Run the tests.");
    expect(task).toContain("Answer in Chinese.");
    expect(task).not.toContain("Checks diffs");
    expect(agentTeamMemberTask(team, 1, "Build it")).toBe("Build it");
  });

  it("lets a member hand work only where the user drew it, and no further", () => {
    const flows = {
      ...named,
      memberFlows: [
        { from: "builder", to: "Reviewer" },
        { from: "Builder", to: "Gone" },
      ],
    };
    expect(agentTeamHandsTo(flows, 1)).toEqual([2]);
    expect(agentTeamHandsTo(flows, 2)).toEqual([]);
    expect(agentTeamLeadPrompt(flows, "")).toContain("(may hand parts to `Reviewer`)");
    expect(agentTeamMemberTask(flows, 1, "Build it")).toContain("to `Reviewer` with");
    const handed = agentTeamMemberTask(flows, 1, "Build it", "Planner");
    expect(handed).toContain('Your teammate "Planner" gave you');
    expect(handed).not.toContain("delegate_task");
    const allowed = agentTeamHandsTo(flows, 1);
    expect(agentTeamTarget(flows, undefined, "Reviewer", allowed)).toMatchObject({ index: 2 });
    for (const result of [
      agentTeamTarget(flows, undefined, "Builder", allowed),
      agentTeamTarget(flows, { model: "opus-fake" }, undefined, allowed),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toContain("opus-fake");
    }
  });
});

describe("agentTeamLeadPrompt", () => {
  it("lists members with their options and adds the user's guidance", () => {
    const prompt = agentTeamLeadPrompt(team, "  Never edit files yourself.  ");
    expect(prompt).toContain('<t3_code_agent_team name="Reviewers">');
    expect(prompt).toContain(
      "- providerInstanceId `claude_fake`, model `opus-fake` (effort: high)",
    );
    expect(prompt).toContain("Lead guidance from the user:\nNever edit files yourself.");
    expect(agentTeamLeadPrompt(team, "")).not.toContain("Lead guidance");
  });

  it("prefers the team's own guidance and states its limit", () => {
    const own = { ...team, leadGuidance: "Only plan.", maxParallel: 2 };
    const prompt = agentTeamLeadPrompt(own, "Shared guidance.");
    expect(prompt).toContain("Lead guidance from the user:\nOnly plan.");
    expect(prompt).not.toContain("Shared guidance.");
    expect(prompt).toContain("At most 2 tasks run at once");
    // Empty guidance and an unlimited team fall back to the shared text and say no limit.
    const plain = agentTeamLeadPrompt({ ...team, leadGuidance: "", maxParallel: 0 }, "Shared.");
    expect(plain).toContain("Lead guidance from the user:\nShared.");
    expect(plain).not.toContain("At most");
  });
});
