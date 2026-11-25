import type {
  AgentTeamRole,
  ModelSelection,
  RouteDecision,
  RoutingGroup,
  ThreadAgentTeam,
} from "@t3tools/contracts";

export interface ThreadAgentTeamInput {
  readonly routing: RouteDecision | null | undefined;
  /** What the user turned on or off after launch; absent when they never did. */
  readonly agentTeam: ThreadAgentTeam | null | undefined;
  readonly modelSelection: Pick<ModelSelection, "instanceId" | "model">;
}

/**
 * The team a thread leads, as an id and the name it was given, without checking that the team
 * still exists. A team turned on after launch is led by whichever model the thread runs; one the
 * thread launched through is led only while the thread keeps the member it launched on.
 */
export function threadAgentTeamRef(input: ThreadAgentTeamInput): ThreadAgentTeam | null {
  if (input.agentTeam !== undefined) return input.agentTeam;
  const decision = input.routing?.group;
  if (decision?.team !== true) return null;
  if (
    decision.member.instanceId !== input.modelSelection.instanceId ||
    decision.member.model !== input.modelSelection.model
  ) {
    return null;
  }
  return { id: decision.id, name: decision.name };
}

/** The saved team a thread leads; a deleted team, or one no longer a team, leads nothing. */
export function threadAgentTeam(
  input: ThreadAgentTeamInput & { readonly groups: ReadonlyArray<RoutingGroup> },
): RoutingGroup | null {
  const ref = threadAgentTeamRef(input);
  if (ref === null) return null;
  const team = input.groups.find((group) => group.id === ref.id);
  return team?.team === true ? team : null;
}

/** A member's role by its place in the team, when it has anything set. */
export function agentTeamRole(
  team: Pick<RoutingGroup, "memberRoles">,
  index: number,
): AgentTeamRole | null {
  const role = team.memberRoles?.[index];
  if (role === undefined) return null;
  const trimmed = {
    name: role.name.trim(),
    description: role.description.trim(),
    instructions: role.instructions.trim(),
  };
  return trimmed.name || trimmed.description || trimmed.instructions ? trimmed : null;
}

/** The places of the teammates a named member may hand part of its task to. */
export function agentTeamHandsTo(
  team: Pick<RoutingGroup, "members" | "memberRoles" | "memberFlows">,
  index: number,
): ReadonlyArray<number> {
  const nameAt = (at: number) => agentTeamRole(team, at)?.name.toLowerCase() ?? "";
  const from = nameAt(index);
  if (from === "" || !team.memberFlows) return [];
  const names = new Set(
    team.memberFlows.flatMap((flow) =>
      flow.from.trim().toLowerCase() === from ? [flow.to.trim().toLowerCase()] : [],
    ),
  );
  return [...team.members.keys()].filter((at) => at !== index && names.has(nameAt(at)));
}

const memberKey = (member: Pick<ModelSelection, "instanceId" | "model">) =>
  `${member.instanceId}\u0000${member.model}`;

const optionsKey = (member: ModelSelection) =>
  `${memberKey(member)}\u0000${(member.options ?? [])
    .map((option) => `${option.id}=${String(option.value)}`)
    .sort()
    .join()}`;

/** Why a lead could not pick each member apart, or null. Names are matched without case. */
export function agentTeamMembersProblem(
  team: Pick<RoutingGroup, "members" | "memberRoles">,
): string | null {
  const names = new Set<string>();
  const unnamed = new Set<string>();
  for (const [index, member] of team.members.entries()) {
    const name = agentTeamRole(team, index)?.name ?? "";
    if (name === "") {
      if (unnamed.has(memberKey(member))) {
        return "Two members use the same model. Name one, so the lead can tell them apart.";
      }
      unnamed.add(memberKey(member));
    } else {
      if (names.has(name.toLowerCase())) return `Two members are named "${name}".`;
      names.add(name.toLowerCase());
    }
  }
  return null;
}

/**
 * Moves roles along when a client that doesn't know them reorders, adds, edits or removes members:
 * to the same model with the same options, then the same model, then in order.
 */
export function realignMemberRoles(
  saved: Pick<RoutingGroup, "members" | "memberRoles">,
  members: RoutingGroup["members"],
): RoutingGroup["memberRoles"] {
  const roles = saved.memberRoles;
  if (roles === undefined || roles.length === 0) return roles;
  const left = new Set(saved.members.keys());
  const placed = new Map<number, number>();
  const place = (
    matches: (from: ModelSelection, to: ModelSelection) => boolean,
    anywhere: boolean,
  ) => {
    for (const [to, member] of members.entries()) {
      if (placed.has(to)) continue;
      const fits = (at: number) => left.has(at) && matches(saved.members[at]!, member);
      // A row that stayed where it was comes before one that moved.
      const from = fits(to) ? to : anywhere ? [...left].find(fits) : undefined;
      if (from === undefined) continue;
      placed.set(to, from);
      left.delete(from);
    }
  };
  for (const anywhere of [false, true]) {
    place((from, to) => optionsKey(from) === optionsKey(to), anywhere);
  }
  for (const anywhere of [false, true]) {
    place((from, to) => memberKey(from) === memberKey(to), anywhere);
  }
  if (members.length === saved.members.length) {
    // Same count: the rows left over changed model, in the order they were.
    const rest = [...left].sort((a, b) => a - b);
    for (const to of members.keys()) {
      if (!placed.has(to)) placed.set(to, rest.shift() ?? -1);
    }
  }
  return members.map(
    (_member, to) => roles[placed.get(to) ?? -1] ?? { name: "", description: "", instructions: "" },
  );
}

/**
 * A team's flows after a client that doesn't know flows saved it: a flow stays only while both
 * names stay on the models and options they were on, so none passes to another member.
 */
export function keptMemberFlows(
  saved: Pick<RoutingGroup, "members" | "memberRoles" | "memberFlows">,
  next: Pick<RoutingGroup, "members" | "memberRoles">,
): RoutingGroup["memberFlows"] {
  const keys = (team: Pick<RoutingGroup, "members" | "memberRoles">) =>
    new Map(
      team.members.map((member, at) => [
        agentTeamRole(team, at)?.name.toLowerCase() ?? "",
        optionsKey(member),
      ]),
    );
  const before = keys(saved);
  const after = keys(next);
  const kept = (name: string) => {
    const key = name.trim().toLowerCase();
    return before.get(key) !== undefined && before.get(key) === after.get(key);
  };
  return saved.memberFlows?.filter((flow) => kept(flow.from) && kept(flow.to));
}

/** Who the members are and which hand work to which; equal while neither was edited. */
export function agentTeamFlowsKey(
  team: Pick<RoutingGroup, "members" | "memberRoles" | "memberFlows">,
): string {
  return JSON.stringify(
    team.members.map((member, at) => [
      optionsKey(member),
      agentTeamRole(team, at)?.name ?? "",
      agentTeamHandsTo(team, at),
    ]),
  );
}
