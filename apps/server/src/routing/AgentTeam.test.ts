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
    expect(leads({})?.id).toBe("reviewers");
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
      activeAgentTeam({ routing: null, agentTeam: turnedOn, modelSelection: other, groups: [team] })
        ?.id,
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
