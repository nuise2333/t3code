import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentTeamMembersProblem, realignMemberRoles } from "./agentTeam.ts";

const member = (model: string) => ({ instanceId: ProviderInstanceId.make("codex"), model });
const role = (name: string) => ({ name, description: "", instructions: "" });

describe("agent team roles", () => {
  it("needs names only where members can't be told apart", () => {
    const members = [member("a"), member("b"), member("b")];
    expect(agentTeamMembersProblem({ members: members.slice(0, 2) })).toBeNull();
    expect(agentTeamMembersProblem({ members })).toMatch(/same model/);
    expect(
      agentTeamMembersProblem({ members, memberRoles: [role(""), role(""), role("Y")] }),
    ).toBeNull();
    expect(
      agentTeamMembersProblem({ members, memberRoles: [role(""), role("X"), role(" x ")] }),
    ).toMatch(/named "x"/);
  });

  it("keeps roles with their members when a client that doesn't know them saves", () => {
    const saved = {
      members: [member("a"), member("b"), member("b")],
      memberRoles: [role("A"), role("B1"), role("B2")],
    };
    expect(
      realignMemberRoles(saved, [member("b"), member("c"), member("a"), member("b")])?.map(
        (entry) => entry.name,
      ),
    ).toEqual(["B1", "", "A", "B2"]);

    const names = (members: Parameters<typeof realignMemberRoles>[1]) =>
      realignMemberRoles(effort, members)?.map((entry) => entry.name);
    const at = (value: string) => ({ ...member("b"), options: [{ id: "effort", value }] });
    const effort = { members: [at("low"), at("high")], memberRoles: [role("Low"), role("High")] };
    const three = {
      members: [member("a"), member("b"), member("c")],
      memberRoles: [role("A"), role("B"), role("C")],
    };
    // A model edited to a teammate's, and a swap saved together with an edit, lose no role.
    for (const [models, expected] of [
      ["bbc", "ABC"],
      ["bxc", "BAC"],
      ["xbc", "ABC"],
      ["cab", "CAB"],
      ["ac", "AC"],
    ] as const) {
      expect(
        realignMemberRoles(three, [...models].map(member))
          ?.map((entry) => entry.name)
          .join(""),
      ).toBe(expected);
    }
    // Swapped rows on one model follow their options; a changed effort or model keeps its place.
    expect(names([at("high"), at("low")])).toEqual(["High", "Low"]);
    expect(names([at("low"), at("max")])).toEqual(["Low", "High"]);
    expect(names([member("c"), at("high")])).toEqual(["Low", "High"]);
  });
});
