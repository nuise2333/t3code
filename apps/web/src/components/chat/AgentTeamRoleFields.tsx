import {
  AGENT_TEAM_INSTRUCTIONS_MAX_LENGTH,
  AGENT_TEAM_ROLE_DESCRIPTION_MAX_LENGTH,
  AGENT_TEAM_ROLE_NAME_MAX_LENGTH,
  type AgentTeamRole,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export const EMPTY_TEAM_ROLE: AgentTeamRole = { name: "", description: "", instructions: "" };

/** A member's name in place of its "Worker 1" label; left empty, the model's name shows. */
export function AgentTeamRoleName(props: {
  readonly label: string;
  readonly placeholder?: string | undefined;
  readonly role: AgentTeamRole;
  readonly onChange: (role: AgentTeamRole) => void;
}) {
  return (
    <Input
      size="sm"
      aria-label={`${props.label} name`}
      placeholder={props.placeholder ?? "Name (optional), such as Reviewer"}
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
}) {
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
        aria-label={`${props.label} role`}
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
          {open ? "Role & instructions" : summary ? `Role: ${summary}` : "Add role & instructions"}
        </span>
      </Button>
      {open ? (
        <div id={id} className="grid gap-2 ps-2">
          <div className="grid gap-1">
            <label htmlFor={`${id}-for`} className="text-muted-foreground text-xs">
              Give it tasks about (the lead reads this)
            </label>
            <Textarea
              id={`${id}-for`}
              rows={2}
              maxLength={AGENT_TEAM_ROLE_DESCRIPTION_MAX_LENGTH}
              placeholder="Reviews diffs before they merge"
              value={role.description}
              onChange={(event) => props.onChange({ ...role, description: event.target.value })}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${id}-how`} className="text-muted-foreground text-xs">
              Instructions (sent with each of its tasks)
            </label>
            <Textarea
              id={`${id}-how`}
              rows={3}
              maxLength={AGENT_TEAM_INSTRUCTIONS_MAX_LENGTH}
              placeholder="Only report problems you can reproduce."
              value={role.instructions}
              onChange={(event) => props.onChange({ ...role, instructions: event.target.value })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
