import {
  AGENT_TEAM_INSTRUCTIONS_MAX_LENGTH,
  AGENT_TEAM_ROLE_DESCRIPTION_MAX_LENGTH,
  AGENT_TEAM_ROLE_NAME_MAX_LENGTH,
  type AgentTeamFlow,
  type AgentTeamRole,
  type RoutingGroup,
} from "@t3tools/contracts";
import { agentTeamHandsTo } from "@t3tools/shared/agentTeam";
import { useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export const EMPTY_TEAM_ROLE: AgentTeamRole = { name: "", description: "", instructions: "" };

/** A row of a team being edited; its key outlives renames and moves, so flows point at it. */
interface TeamRow {
  readonly key: number;
  readonly role: AgentTeamRole;
}

export interface TeamRowFlow {
  readonly from: number;
  readonly to: number;
}

/** A saved team's flows between its rows, given in member order. */
export function teamRowFlows(
  team: Pick<RoutingGroup, "members" | "memberRoles" | "memberFlows">,
  keys: ReadonlyArray<number>,
): ReadonlyArray<TeamRowFlow> {
  return keys.flatMap((from, index) =>
    agentTeamHandsTo(team, index).flatMap((at) => {
      const to = keys[at];
      return to === undefined ? [] : [{ from, to }];
    }),
  );
}

/** The flows to save, by the rows' current names; a removed or unnamed row has none. */
export function namedTeamFlows(
  rows: ReadonlyArray<TeamRow>,
  flows: ReadonlyArray<TeamRowFlow>,
): AgentTeamFlow[] {
  const names = new Map(rows.map((row) => [row.key, row.role.name.trim()]));
  return flows.flatMap((flow) => {
    const from = names.get(flow.from);
    const to = names.get(flow.to);
    return from && to ? [{ from, to }] : [];
  });
}

const DUPLICATE_NAME_PROBLEM = /^Two members are named "(.*)"\.$/;

/** `agentTeamMembersProblem` answers in English; this gives the same text in the UI language. */
export function useTeamMembersProblemText() {
  const gt = useGT();
  return (problem: string | null) => {
    if (problem === null) return null;
    const name = DUPLICATE_NAME_PROBLEM.exec(problem)?.[1];
    if (name !== undefined) return gt('Two members are named "{name}".', { name });
    return problem.startsWith("Two members use the same model.")
      ? gt("Two members use the same model. Name one, so the lead can tell them apart.")
      : problem;
  };
}

/** The teammates a member may hand part of its task to. Flows go by name, so both need one. */
export function AgentTeamHandsTo(props: {
  readonly label: string;
  readonly row: TeamRow;
  readonly rows: ReadonlyArray<TeamRow>;
  readonly flows: ReadonlyArray<TeamRowFlow>;
  readonly onChange: (flows: ReadonlyArray<TeamRowFlow>) => void;
}) {
  const gt = useGT();
  const { row, flows } = props;
  const teammates = props.rows.filter(
    (candidate) => candidate.key !== row.key && candidate.role.name.trim() !== "",
  );
  return (
    <fieldset
      className="grid gap-1"
      aria-label={gt("{label} may hand parts to", { label: props.label })}
    >
      <span className="text-muted-foreground text-xs">{gt("May hand parts of its tasks to")}</span>
      {row.role.name.trim() === "" || teammates.length === 0 ? (
        <span className="text-muted-foreground text-xs">
          {gt("Name this member and another one to choose.")}
        </span>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {teammates.map((teammate) => {
            const checked = flows.some((flow) => flow.from === row.key && flow.to === teammate.key);
            const others = flows.filter(
              (flow) => flow.from !== row.key || flow.to !== teammate.key,
            );
            return (
              <label key={teammate.key} className="flex min-w-0 items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  aria-label={teammate.role.name.trim()}
                  onCheckedChange={(next) =>
                    props.onChange(
                      next === true ? [...others, { from: row.key, to: teammate.key }] : others,
                    )
                  }
                />
                <span className="min-w-0 truncate">{teammate.role.name.trim()}</span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

/** A member's name in place of its "Worker 1" label; left empty, the model's name shows. */
export function AgentTeamRoleName(props: {
  readonly label: string;
  readonly placeholder?: string | undefined;
  readonly role: AgentTeamRole;
  readonly onChange: (role: AgentTeamRole) => void;
}) {
  const gt = useGT();
  return (
    <Input
      size="sm"
      aria-label={gt("{label} name", { label: props.label })}
      placeholder={props.placeholder ?? gt("Name (optional), such as Reviewer")}
      maxLength={AGENT_TEAM_ROLE_NAME_MAX_LENGTH}
      value={props.role.name}
      onChange={(event) => props.onChange({ ...props.role, name: event.target.value })}
    />
  );
}

/** What the lead hands this member, and what the member is told; folded until opened. */
export function AgentTeamRoleDetails(props: {
  readonly label: string;
  readonly role: AgentTeamRole;
  readonly onChange: (role: AgentTeamRole) => void;
  /** Whom it may hand work to, below the instructions. */
  readonly children?: ReactNode;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const { role } = props;
  const summary = role.description.trim() || role.instructions.trim();
  return (
    <div className="grid min-w-0 gap-1.5">
      <Button
        type="button"
        size="xs"
        variant="ghost-muted"
        className="min-w-0 max-w-full justify-self-start"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={gt("{label} role", { label: props.label })}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate">
          {open
            ? gt("Role & instructions")
            : summary
              ? gt("Role: {summary}", { summary })
              : gt("Add role & instructions")}
        </span>
      </Button>
      {open ? (
        <div id={id} className="grid gap-2 ps-2">
          <div className="grid gap-1">
            <label htmlFor={`${id}-for`} className="text-muted-foreground text-xs">
              {gt("Give it tasks about (the lead reads this)")}
            </label>
            <Textarea
              id={`${id}-for`}
              rows={2}
              maxLength={AGENT_TEAM_ROLE_DESCRIPTION_MAX_LENGTH}
              placeholder={gt("Reviews diffs before they merge")}
              value={role.description}
              onChange={(event) => props.onChange({ ...role, description: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${id}-how`} className="text-muted-foreground text-xs">
              {gt("Instructions (sent with each of its tasks)")}
            </label>
            <Textarea
              id={`${id}-how`}
              rows={3}
              maxLength={AGENT_TEAM_INSTRUCTIONS_MAX_LENGTH}
              placeholder={gt("Only report problems you can reproduce.")}
              value={role.instructions}
              onChange={(event) => props.onChange({ ...role, instructions: event.target.value })}
            />
          </div>
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
