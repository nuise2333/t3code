import {
  AUTO_TEAMS,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  agentTeamLeadPatch,
  newThreadModelSelection,
  leadReachable,
  AUTO_TEAM_TEXT,
  leadSelectionToApply,
  modelPickTeamExit,
  teamDisplayName,
  teamLeadSelection,
} from "./agentTeamPick.logic";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const opusHigh: ModelSelection = {
  instanceId: claude,
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};
const opus: ModelSelection = { instanceId: claude, model: "claude-opus-5-5" };
const gpt: ModelSelection = { instanceId: codex, model: "gpt-6.1" };

describe("teamLeadSelection", () => {
  it("runs a saved team on its first member, options included", () => {
    expect(teamLeadSelection({ kind: "saved", team: { members: [opusHigh, gpt] } }, {})).toBe(
      opusHigh,
    );
    expect(teamLeadSelection({ kind: "saved", team: { members: [] } }, { best: gpt })).toBeNull();
  });

  it("runs an automatic team on the lead set for its kind, or keeps the thread's model", () => {
    const leads = { balanced: opusHigh };
    expect(teamLeadSelection({ kind: "auto", auto: "balanced" }, leads)).toBe(opusHigh);
    expect(teamLeadSelection({ kind: "auto", auto: "cheap" }, leads)).toBeNull();
    expect(teamLeadSelection({ kind: "auto", auto: "best" }, undefined)).toBeNull();
  });
});

describe("modelPickTeamExit", () => {
  it("leaves the team and forgets the automatic default only for a thread in a team", () => {
    expect(
      modelPickTeamExit({ activeTeamId: "auto-balanced", defaultAutoTeam: "balanced" }),
    ).toEqual({ leaveTeam: true, forgetDefault: true });
    expect(modelPickTeamExit({ activeTeamId: "content", defaultAutoTeam: null })).toEqual({
      leaveTeam: true,
      forgetDefault: false,
    });
    expect(modelPickTeamExit({ activeTeamId: null, defaultAutoTeam: "balanced" })).toEqual({
      leaveTeam: false,
      forgetDefault: false,
    });
  });
});

describe("leadSelectionToApply", () => {
  it("saves the lead's options once the thread shows the lead's model", () => {
    expect(leadSelectionToApply(opus, opusHigh)).toBe(opusHigh);
    expect(leadSelectionToApply(opusHigh, opus)).toBe(opus);
  });

  it("saves nothing when the switch did not land or nothing differs", () => {
    expect(leadSelectionToApply(gpt, opusHigh)).toBeNull();
    expect(leadSelectionToApply({ ...opusHigh }, opusHigh)).toBeNull();
  });
});

describe("agentTeamLeadPatch", () => {
  it("drops the earlier lead's effort when the new lead has none", () => {
    const first = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      agentTeamLeadPatch({ cheap: gpt }, "balanced", opusHigh),
    );
    expect(first.agentTeamLeads.balanced).toEqual(opusHigh);
    const next = applyServerSettingsPatch(
      first,
      agentTeamLeadPatch(first.agentTeamLeads, "balanced", gpt),
    );
    expect(next.agentTeamLeads.balanced).toEqual({ ...gpt, options: [] });
    expect(next.agentTeamLeads.cheap).toMatchObject(gpt);
  });
});

describe("automatic team text", () => {
  it("matches the contract's English, so its translations keep resolving", () => {
    for (const team of AUTO_TEAMS) {
      expect(AUTO_TEAM_TEXT[team.kind]).toEqual({ name: team.name, description: team.description });
    }
  });

  it("translates an automatic team's name and leaves a saved team's alone", () => {
    const translate = (text: string) => `zh:${text}`;
    expect(teamDisplayName({ id: "auto-best", name: "Best team" }, translate)).toBe("zh:Best team");
    expect(teamDisplayName({ id: "content", name: "Best team" }, translate)).toBe("Best team");
  });
});

describe("newThreadModelSelection", () => {
  const shown = { instanceId: ProviderInstanceId.make("codex"), model: "shown" };
  const lead = { instanceId: ProviderInstanceId.make("claude"), model: "lead", options: [] };
  const base = {
    shown,
    draftTeam: undefined,
    rememberedKind: "balanced" as const,
    leads: { balanced: lead },
    modelPicked: false,
    routingGroupId: null,
  };
  it("starts a draft on the remembered automatic team on its lead", () => {
    expect(newThreadModelSelection(base)).toStrictEqual(lead);
  });
  it("keeps what the user picked: a model, a routing group, a team choice, or no lead", () => {
    expect(newThreadModelSelection({ ...base, modelPicked: true })).toStrictEqual(shown);
    expect(newThreadModelSelection({ ...base, routingGroupId: "fast" })).toStrictEqual(shown);
    expect(newThreadModelSelection({ ...base, draftTeam: null })).toStrictEqual(shown);
    expect(newThreadModelSelection({ ...base, draftTeam: { id: "auto-best" } })).toStrictEqual(
      shown,
    );
    expect(newThreadModelSelection({ ...base, leads: {} })).toStrictEqual(shown);
    expect(newThreadModelSelection({ ...base, rememberedKind: null })).toStrictEqual(shown);
  });
});

describe("leadReachable", () => {
  const lead = { instanceId: ProviderInstanceId.make("claude"), model: "lead" };
  const entry = { instanceId: "claude", driverKind: "claudeAgent", enabled: true, installed: true };
  it("joins only when the thread can switch to the lead", () => {
    expect(leadReachable(lead, [entry], null)).toBe(true);
    expect(leadReachable(lead, [], null)).toBe(false);
    expect(leadReachable(lead, [{ ...entry, enabled: false }], null)).toBe(false);
    expect(leadReachable(lead, [entry], "codex")).toBe(false);
    expect(leadReachable(lead, [entry], "claudeAgent")).toBe(true);
  });
});
