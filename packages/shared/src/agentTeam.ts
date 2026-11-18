import type {
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
