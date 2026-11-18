import type { TeamChoice } from "@t3tools/client-runtime/routing";
import { SettingsIcon, UsersIcon } from "lucide-react";
import { memo } from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const NO_TEAM = "";

/**
 * Turns an agent team on or off for the thread. On a new thread the team's first available member
 * leads; on a running one the thread's own model leads from the next message.
 */
export const ComposerAgentTeamControl = memo(function ComposerAgentTeamControl(props: {
  readonly teams: ReadonlyArray<TeamChoice>;
  /** The team this thread leads, or the draft picked; its name stays even if it was deleted. */
  readonly active: { readonly id: string; readonly name: string } | null;
  readonly newThread: boolean;
  readonly size?: "sm" | "xs";
  readonly hidden?: boolean;
  /** Set when a team cannot be turned on right now, such as with several models picked. */
  readonly disabledReason?: string | null;
  readonly onSelect: (teamId: string | null) => void;
  readonly onManage: () => void;
}) {
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const active = props.active;
  const tooltip = active
    ? `Agent team: ${active.name}. ${
        props.newThread
          ? "Its lead plans the work and delegates tasks to the team."
          : "This thread's model leads and delegates tasks to the team."
      }`
    : props.disabledReason || "Agent team: off. Turn one on to let a lead delegate to its models.";
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={size}
                  className="ps-1.5"
                  data-composer-agent-team={active ? "on" : "off"}
                  aria-pressed={active !== null}
                  aria-label={active ? `Agent team: ${active.name}` : "Agent team: off"}
                />
              }
            />
          }
        >
          <ComposerControlIcon icon={UsersIcon} size={size} />
          {active ? (
            <span data-composer-control-label className="max-w-32 truncate">
              {active.name}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" className="w-72" {...composerFloatingLayerProps}>
        <MenuGroup>
          <MenuGroupLabel>Agent team</MenuGroupLabel>
          <MenuRadioGroup
            value={active?.id ?? NO_TEAM}
            onValueChange={(value: string) => {
              const next = value === NO_TEAM ? null : value;
              if (next !== (active?.id ?? null)) props.onSelect(next);
            }}
          >
            <MenuRadioItem value={NO_TEAM}>
              <span className="grid min-w-0 gap-0.5">
                <span>No team</span>
                <span className="text-muted-foreground text-xs">The model answers on its own.</span>
              </span>
            </MenuRadioItem>
            {props.teams.map((team) => (
              <MenuRadioItem
                key={team.id}
                value={team.id}
                disabled={Boolean(props.disabledReason) && active?.id !== team.id}
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate">{team.name}</span>
                  <span className="truncate text-muted-foreground text-xs">{team.summary}</span>
                </span>
              </MenuRadioItem>
            ))}
            {active && !props.teams.some((team) => team.id === active.id) ? (
              <MenuRadioItem value={active.id} disabled>
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate">{active.name}</span>
                  <span className="text-muted-foreground text-xs">This team was deleted.</span>
                </span>
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
          {props.disabledReason ? (
            <div className="px-2 py-1 text-muted-foreground text-xs">{props.disabledReason}</div>
          ) : props.teams.length === 0 ? (
            <div className="px-2 py-1 text-muted-foreground text-xs">
              No agent teams yet. Create one in settings.
            </div>
          ) : null}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={props.onManage}>
          <SettingsIcon />
          Manage teams…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
