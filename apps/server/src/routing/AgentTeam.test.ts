import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type RouteDecision, type RoutingGroup } from "@t3tools/contracts";

import { activeAgentTeam, agentTeamLeadPrompt, agentTeamTarget } from "./AgentTeam.ts";

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

describe("activeAgentTeam", () => {
  it("leads only while the thread keeps its launch member and the team exists", () => {
    const routing = launchedOn({ instanceId: claude, model: "opus-fake" });
    const lead = { instanceId: claude, model: "opus-fake" };
    expect(activeAgentTeam({ routing, modelSelection: lead, groups: [team] })?.id).toBe(
      "reviewers",
    );
    // Picking another model leaves the team.
    expect(
      activeAgentTeam({
        routing,
        modelSelection: { instanceId: codex, model: "gpt-fake" },
        groups: [team],
      }),
    ).toBeNull();
    // A deleted team, or a group that was not a team at launch, leads nothing.
    expect(activeAgentTeam({ routing, modelSelection: lead, groups: [] })).toBeNull();
    expect(
      activeAgentTeam({
        routing: launchedOn(lead, false),
        modelSelection: lead,
        groups: [team],
      }),
    ).toBeNull();
    const { team: _team, ...plainGroup } = team;
    expect(activeAgentTeam({ routing, modelSelection: lead, groups: [plainGroup] })).toBeNull();
  });
});

describe("agentTeamTarget", () => {
  it("fits a member target and fills its saved options", () => {
    expect(agentTeamTarget(team, { model: "opus-fake" })).toEqual({
      ok: true,
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
    ).toEqual({ ok: true, target: { providerInstanceId: codex, model: "gpt-fake", options: [] } });
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
});
