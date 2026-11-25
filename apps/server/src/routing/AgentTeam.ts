import {
  AUTO_TEAMS,
  autoTeamKind,
  type AutoTeamKind,
  type ModelSelection,
  type OrchestratorMcpTarget,
  type RouteDecision,
  type RoutingGroup,
  type ThreadAgentTeam,
} from "@t3tools/contracts";
import { agentTeamRole, threadAgentTeamRef } from "@t3tools/shared/agentTeam";

/** A saved team with its members, or an automatic team whose workers T3 picks per task. */
export type ActiveTeam =
  | { readonly kind: "saved"; readonly team: RoutingGroup }
  | {
      readonly kind: "auto";
      readonly auto: AutoTeamKind;
      readonly id: string;
      readonly name: string;
      readonly description: string;
    };

/**
 * The team a thread leads, and only while a saved team still exists. One the user turned on after
 * launch is led by the thread's model; one it launched through, only while it keeps that member.
 */
export function activeAgentTeam(input: {
  readonly routing: RouteDecision | null | undefined;
  readonly agentTeam: ThreadAgentTeam | null | undefined;
  readonly modelSelection: Pick<ModelSelection, "instanceId" | "model">;
  readonly groups: ReadonlyArray<RoutingGroup>;
}): ActiveTeam | null {
  const ref = threadAgentTeamRef(input);
  if (ref === null) return null;
  const auto = autoTeamKind(ref.id);
  const autoTeam = AUTO_TEAMS.find((team) => team.kind === auto);
  if (auto !== null && autoTeam) {
    return {
      kind: "auto",
      auto,
      id: autoTeam.id,
      name: autoTeam.name,
      description: autoTeam.description,
    };
  }
  const team = input.groups.find((group) => group.id === ref.id);
  return team?.team === true ? { kind: "saved", team } : null;
}

export const activeTeamName = (team: ActiveTeam) =>
  team.kind === "saved" ? team.team.name : team.name;

/** An automatic team's rules: the lead leaves the model out and T3 picks one per task. */
export function autoTeamLeadPrompt(
  team: Extract<ActiveTeam, { kind: "auto" }>,
  guidance: string,
): string {
  const extra = guidance.trim();
  return [
    `<t3_code_agent_team name="${escapeAttribute(team.name)}">`,
    `You lead the automatic agent team "${team.name}" the user picked for this thread. Plan the work, split it into self-contained tasks, and hand each to a worker with \`delegate_task\`. Leave \`target\` out and set \`subtask\`: T3 picks each worker's model for it (${team.description.toLowerCase()}). Name a model only when the user asks for one. Independent tasks run in parallel. Check each result, then answer the user yourself; do small steps yourself.`,
    ...SUBTASK_RULES,
    ...(team.auto === "best" ? BEST_TEAM_RULES : []),
    ...(extra === "" ? [] : ["", "Lead guidance from the user:", extra]),
    "</t3_code_agent_team>",
  ].join("\n");
}

const SUBTASK_RULES = [
  "",
  "`subtask` is what the task mostly tests; split a task that mixes several. Set `role` too:",
  "- Coding: `backend` services, data, algorithms, tests; `frontend` page behavior and state; `visual` interface design; `reasoning` hard problems, plans, root causes; `maintainability` refactors and code review.",
  "- Reading: `intent` what someone really wants; `instructions` strict rules and formats; `synthesis` research and merging sources; `accuracy` fact checks and translation.",
  "- Writing: `expression` polished wording and UI copy; `completeness` full drafts; `style` tone for an audience; `structure` outlines and long documents.",
];

/** Best team's division of labor; the benchmark boards decide which model takes each subtask. */
const BEST_TEAM_RULES = [
  "",
  "- Do it yourself: edits of a few dozen lines and review fixes. A handoff costs more than a small task.",
  "- `implementation`, `test`: only self-contained modules whose interface is settled, such as backend, algorithms, data processing or performance. Give the interface, acceptance criteria and the sibling places to change. When it returns, read its diff and run the tests yourself.",
  "- `design`: for a large plan, an independent plan written in parallel with yours; give it the user's own words and needed context, never your draft or leaning. Also an adviser on UI copy and interaction after your first version, told who the page is for and what it should get done.",
  "- `research`: multi-step browsing or research across many sources; state the question, scope and what to bring back, with sources.",
  "- `review`: a final review before you report done. Only findings that would lose data, miscompute money, bypass permissions, send a wrong message or break a release, with how it happens, block; the rest are suggestions. At most two rounds, then let the user decide.",
  "Merge an independent plan into yours: where they differ, the code and live data decide; check what it marks as a guess. Tell the user what both agreed on, what you took from it, what you rejected and why, and lay out a split you cannot settle for the user to decide.",
];

function modelLabel(member: ModelSelection): string {
  const options = (member.options ?? []).map((option) => `${option.id}: ${String(option.value)}`);
  return `providerInstanceId \`${member.instanceId}\`, model \`${member.model}\`${options.length === 0 ? "" : ` (${options.join(", ")})`}`;
}

function memberLabel(team: RoutingGroup, index: number): string {
  const member = team.members[index];
  if (member === undefined) return "";
  const role = agentTeamRole(team, index);
  return [
    "- ",
    role?.name ? `member \`${role.name}\`, ` : "",
    modelLabel(member),
    role?.description ? `: ${role.description}` : "",
  ].join("");
}

const memberList = (team: RoutingGroup) =>
  team.members.map((_member, index) => memberLabel(team, index));

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const hasNames = (team: RoutingGroup) =>
  team.members.some((_member, index) => Boolean(agentTeamRole(team, index)?.name));

/** Rides on every lead turn, so a compacted conversation never loses it. */
export function agentTeamLeadPrompt(team: RoutingGroup, sharedGuidance: string): string {
  // A team's own guidance replaces the one every team shares.
  const extra = (team.leadGuidance?.trim() || sharedGuidance).trim();
  const shared = team.sharedGuidance?.trim() ?? "";
  const limit = team.maxParallel ?? 0;
  return [
    `<t3_code_agent_team name="${escapeAttribute(team.name)}">`,
    `You lead the agent team "${team.name}" the user picked for this thread. Plan the work, split it into self-contained tasks, and hand each to a member with \`delegate_task\`: set \`target.providerInstanceId\` and \`target.model\` to a member below and leave \`target.options\` out to use its saved settings. Independent tasks run in parallel. Check each result, then answer the user yourself. ${hasNames(team) ? "For a named member, set `member` to its name and leave `target` out; T3 adds its own instructions to the task. " : ""}Delegate only to these members; do small steps yourself. If a member's model is out of quota or inaccessible, T3 automatically routes the task to the same model on another agent, or to the next capability level down across agents.`,
    "Members:",
    ...memberList(team),
    ...(limit > 0
      ? [
          `At most ${limit} ${limit === 1 ? "task runs" : "tasks run"} at once; wait for a result before delegating more.`,
        ]
      : []),
    ...(shared === ""
      ? []
      : ["", "Team guidance from the user; T3 adds it to every member's task too:", shared]),
    ...(extra === "" ? [] : ["", "Lead guidance from the user:", extra]),
    "</t3_code_agent_team>",
  ].join("\n");
}

/** A delegated task with who the member is and the team's guidance after it. */
export function agentTeamMemberTask(team: RoutingGroup, index: number, task: string): string {
  const role = agentTeamRole(team, index);
  const shared = team.sharedGuidance?.trim() ?? "";
  if (role === null && shared === "") return task;
  const name = role?.name ?? "";
  return [
    task,
    "",
    `<t3_code_team_member team="${escapeAttribute(team.name)}"${name === "" ? "" : ` name="${escapeAttribute(name)}"`}>`,
    `${name === "" ? "You are a member" : `You are "${name}"`} of the agent team "${team.name}". The team's lead gave you the task above; your final message goes back to it.`,
    ...(role?.description ? ["", "Your role:", role.description] : []),
    ...(role?.instructions ? ["", "Your instructions from the user:", role.instructions] : []),
    ...(shared === "" ? [] : ["", "Team guidance from the user:", shared]),
    "</t3_code_team_member>",
  ].join("\n");
}

export type AgentTeamTargetResult =
  | { readonly ok: true; readonly index: number; readonly target: OrchestratorMcpTarget }
  | { readonly ok: false; readonly message: string };

/**
 * Fits a lead's `delegate_task` target to one member. The member's saved options apply unless the
 * lead gives its own; anything outside the team is refused with the members listed.
 */
export function agentTeamTarget(
  team: RoutingGroup,
  target: OrchestratorMcpTarget | undefined,
  memberName?: string,
): AgentTeamTargetResult {
  const members = memberList(team).join("\n");
  const wanted = memberName?.trim().toLowerCase();
  if (target?.environmentId !== undefined) {
    return {
      ok: false,
      message: `This thread leads the agent team "${team.name}", whose members run here. Omit target.environmentId and pick a member:\n${members}`,
    };
  }
  const candidates = [...team.members.entries()].filter(
    ([index, member]) =>
      (wanted === undefined || agentTeamRole(team, index)?.name.toLowerCase() === wanted) &&
      (target?.model === undefined || member.model === target.model) &&
      (target?.providerInstanceId === undefined || member.instanceId === target.providerInstanceId),
  );
  // Of members on one model, that model alone means the one without a name.
  const oneModel = candidates.every(
    ([, member]) =>
      member.instanceId === candidates[0]?.[1].instanceId &&
      member.model === candidates[0]?.[1].model,
  );
  const unnamed = oneModel ? candidates.filter(([index]) => !agentTeamRole(team, index)?.name) : [];
  const match =
    candidates.length === 1 ? candidates[0] : unnamed.length === 1 ? unnamed[0] : undefined;
  if (match === undefined) {
    return {
      ok: false,
      message: `This thread leads the agent team "${team.name}" and delegates only to its members. Set ${hasNames(team) ? "`member` to a name below, or " : ""}target.providerInstanceId and target.model to one of them:\n${members}`,
    };
  }
  const [index, member] = match;
  const { driverKind: _driverKind, ...rest } = target ?? {};
  return {
    ok: true,
    index,
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
