import {
  type AutoTeamKind,
  autoTeamKind,
  type ModelSelection,
  type RoutingGroup,
} from "@t3tools/contracts";
import type { AgentTeamLeads } from "@t3tools/contracts/settings";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { msg } from "gt-react";

/** Automatic teams as shown; the contract's English names stay the saved data. */
export const AUTO_TEAM_TEXT: Record<
  AutoTeamKind,
  { readonly name: string; readonly description: string }
> = {
  cheap: {
    name: msg("Cheap team"),
    description: msg("Fast, cheap, capable Chinese models"),
  },
  balanced: {
    name: msg("Balanced team"),
    description: msg("Best value among widely used models"),
  },
  best: {
    name: msg("Best team"),
    description: msg("Strongest model for each subtask"),
  },
};

/** An automatic team's name follows the UI language; a saved team keeps the name it was given. */
export function teamDisplayName(
  team: { readonly id: string; readonly name: string },
  translate: (text: string) => string,
): string {
  const kind = autoTeamKind(team.id);
  return kind === null ? team.name : translate(AUTO_TEAM_TEXT[kind].name);
}

type TeamPick =
  | { readonly kind: "saved"; readonly team: Pick<RoutingGroup, "members"> }
  | { readonly kind: "auto"; readonly auto: AutoTeamKind };

/**
 * The model a thread runs on once it works as this team: a saved team's first member with its
 * options, or the lead set for an automatic team. Null keeps the thread's own model.
 */
export function teamLeadSelection(
  pick: TeamPick,
  leads: AgentTeamLeads | undefined,
): ModelSelection | null {
  if (pick.kind === "saved") return pick.team.members[0] ?? null;
  return leads?.[pick.auto] ?? null;
}

/**
 * What picking a model in the picker's own list does to the team. Only that pick leaves a team;
 * the switch to a team's lead never comes through here.
 */
export function modelPickTeamExit(input: {
  readonly activeTeamId: string | null;
  readonly defaultAutoTeam: AutoTeamKind | null | undefined;
}): { readonly leaveTeam: boolean; readonly forgetDefault: boolean } {
  const leaveTeam = input.activeTeamId !== null;
  return { leaveTeam, forgetDefault: leaveTeam && input.defaultAutoTeam != null };
}

/**
 * What to save on a started thread once it was asked to switch to the lead: the lead with its
 * options, or null when the switch did not land (a provider this thread cannot move to) or the
 * thread already runs exactly that.
 */
export function leadSelectionToApply(
  shown: ModelSelection,
  lead: ModelSelection,
): ModelSelection | null {
  if (shown.instanceId !== lead.instanceId || shown.model !== lead.model) return null;
  return modelSelectionsEqual(shown, lead) ? null : lead;
}

/**
 * The settings patch that sets one automatic team's lead. Saved settings merge key by key, so the
 * lead always carries `options`: left out, the earlier lead's effort would stay on the new model.
 */
export function agentTeamLeadPatch(
  current: AgentTeamLeads | undefined,
  kind: AutoTeamKind,
  lead: ModelSelection,
): { readonly agentTeamLeads: AgentTeamLeads } {
  return {
    agentTeamLeads: {
      ...current,
      [kind]: {
        instanceId: lead.instanceId,
        model: lead.model,
        options: [...(lead.options ?? [])],
      },
    },
  };
}
