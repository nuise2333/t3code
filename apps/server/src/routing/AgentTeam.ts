import type {
  ModelSelection,
  OrchestratorMcpTarget,
  RouteDecision,
  RoutingGroup,
} from "@t3tools/contracts";

/**
 * The team a thread leads: it launched through a team, still runs the member it launched on, and
 * the team still exists. Picking another model, or deleting the team, makes it an ordinary thread.
 */
export function activeAgentTeam(input: {
  readonly routing: RouteDecision | null | undefined;
  readonly modelSelection: Pick<ModelSelection, "instanceId" | "model">;
  readonly groups: ReadonlyArray<RoutingGroup>;
}): RoutingGroup | null {
  const decision = input.routing?.group;
  if (decision?.team !== true) return null;
  if (
    decision.member.instanceId !== input.modelSelection.instanceId ||
    decision.member.model !== input.modelSelection.model
  ) {
    return null;
  }
  const team = input.groups.find((group) => group.id === decision.id);
  return team?.team === true ? team : null;
}

function memberLabel(member: ModelSelection): string {
  const options = (member.options ?? []).map((option) => `${option.id}: ${String(option.value)}`);
  return `- providerInstanceId \`${member.instanceId}\`, model \`${member.model}\`${options.length === 0 ? "" : ` (${options.join(", ")})`}`;
}

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** Rides on every lead turn, so a compacted conversation never loses it. */
export function agentTeamLeadPrompt(team: RoutingGroup, guidance: string): string {
  const extra = guidance.trim();
  return [
    `<t3_code_agent_team name="${escapeAttribute(team.name)}">`,
    `You lead the agent team "${team.name}" the user picked for this thread. Plan the work, split it into self-contained tasks, and hand each to a member with \`delegate_task\`: set \`target.providerInstanceId\` and \`target.model\` to a member below and leave \`target.options\` out to use its saved settings. Independent tasks run in parallel. Check each result, then answer the user yourself. Delegate only to these members; do small steps yourself.`,
    "Members:",
    ...team.members.map(memberLabel),
    ...(extra === "" ? [] : ["", "Lead guidance from the user:", extra]),
    "</t3_code_agent_team>",
  ].join("\n");
}

export type AgentTeamTargetResult =
  | { readonly ok: true; readonly target: OrchestratorMcpTarget }
  | { readonly ok: false; readonly message: string };

/**
 * Fits a lead's `delegate_task` target to one member. The member's saved options apply unless the
 * lead gives its own; anything outside the team is refused with the members listed.
 */
export function agentTeamTarget(
  team: RoutingGroup,
  target: OrchestratorMcpTarget | undefined,
): AgentTeamTargetResult {
  const members = team.members.map(memberLabel).join("\n");
  if (target?.environmentId !== undefined) {
    return {
      ok: false,
      message: `This thread leads the agent team "${team.name}", whose members run here. Omit target.environmentId and pick a member:\n${members}`,
    };
  }
  const candidates = team.members.filter(
    (member) =>
      (target?.model === undefined || member.model === target.model) &&
      (target?.providerInstanceId === undefined || member.instanceId === target.providerInstanceId),
  );
  const member = candidates.length === 1 ? candidates[0] : undefined;
  if (member === undefined) {
    return {
      ok: false,
      message: `This thread leads the agent team "${team.name}" and delegates only to its members. Set target.providerInstanceId and target.model to one of them:\n${members}`,
    };
  }
  const { driverKind: _driverKind, ...rest } = target ?? {};
  return {
    ok: true,
    target: {
      ...rest,
      providerInstanceId: member.instanceId,
      model: member.model,
      ...(target?.options !== undefined
        ? { options: target.options }
        : member.options === undefined
          ? {}
          : { options: member.options }),
    },
  };
}
