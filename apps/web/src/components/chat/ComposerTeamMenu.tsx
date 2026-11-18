import { AUTO_TEAMS, type AutoTeamKind } from "@t3tools/contracts";
import {
  BotIcon,
  CheckIcon,
  CrownIcon,
  ScaleIcon,
  SettingsIcon,
  TagIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useRef, useState, type ComponentProps } from "react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { ComposerTeamSetup } from "./ComposerTeamSetup";
import { useComposerMenuState } from "./useComposerMenuState";

const AUTO_ICONS: Record<AutoTeamKind, LucideIcon> = {
  cheap: TagIcon,
  balanced: ScaleIcon,
  best: CrownIcon,
};

export interface TeamMenuTeam {
  readonly id: string;
  readonly name: string;
  /** Such as "Opus 5.5 leads GPT-6.1, Gemini 4". */
  readonly summary: string;
}

function TeamRow(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly detail: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}) {
  const Icon = props.icon;
  return (
    <MenuItem
      role="menuitemradio"
      aria-checked={props.checked}
      disabled={props.disabled === true}
      onClick={props.onSelect}
    >
      <Icon className="text-primary" />
      <span className="shrink-0 font-medium">{props.label}</span>
      <span className="min-w-0 flex-1 truncate text-end text-muted-foreground text-xs">
        {props.detail}
      </span>
      <CheckIcon className={props.checked ? "ms-1" : "invisible ms-1"} aria-hidden="true" />
    </MenuItem>
  );
}

/**
 * The composer's Team menu: no team, an automatic team whose workers T3 picks per task (the kind
 * is remembered for new threads), or one of the user's saved teams, and the Architect & workers
 * setup.
 */
export const ComposerTeamMenu = memo(function ComposerTeamMenu(
  props: {
    readonly active: { readonly id: string; readonly name: string } | null;
    readonly teamChoices: ReadonlyArray<TeamMenuTeam>;
    readonly size?: "sm" | "xs";
    readonly hidden?: boolean;
    readonly disabledReason?: string | null;
    readonly onSelectAuto: (kind: AutoTeamKind) => void;
    readonly onSelectTeam: (teamId: string) => void;
    readonly onSelectNone: () => void;
  } & Omit<
    ComponentProps<typeof ComposerTeamSetup>,
    "anchor" | "onClose" | "active" | "disabledReason"
  >,
) {
  const size = props.size ?? "sm";
  const floatingProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const [setupOpen, setSetupOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { active } = props;
  const blocked = Boolean(props.disabledReason);
  const label = active ? `Agent team: ${active.name}` : "Agent team: off";
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <ComposerControl
                    ref={triggerRef}
                    size={size}
                    className="ps-1.5"
                    data-composer-agent-team={active ? "on" : "off"}
                    aria-pressed={active !== null}
                    aria-label={label}
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
          <TooltipPopup side="top">
            {props.disabledReason ??
              (active
                ? `${label}. Your model leads and delegates to the team's workers.`
                : `${label}. Pick a team to let your model delegate to workers.`)}
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="start" side="top" className="w-96" {...floatingProps}>
          <div data-composer-team-menu>
            <TeamRow
              icon={BotIcon}
              label="No team"
              detail="A single agent"
              checked={active === null}
              onSelect={pick(props.onSelectNone)}
            />
            <MenuGroup>
              <MenuGroupLabel>Worker models for every team · remembered</MenuGroupLabel>
              {AUTO_TEAMS.map((team) => (
                <TeamRow
                  key={team.id}
                  icon={AUTO_ICONS[team.kind]}
                  label={team.name}
                  detail={team.description}
                  checked={active?.id === team.id}
                  disabled={blocked}
                  onSelect={pick(() => props.onSelectAuto(team.kind))}
                />
              ))}
            </MenuGroup>
            {props.teamChoices.length > 0 ? (
              <MenuGroup>
                <MenuGroupLabel>Your teams</MenuGroupLabel>
                {props.teamChoices.map((team) => (
                  <TeamRow
                    key={team.id}
                    icon={UsersIcon}
                    label={team.name}
                    detail={team.summary}
                    checked={active?.id === team.id}
                    disabled={blocked}
                    onSelect={pick(() => props.onSelectTeam(team.id))}
                  />
                ))}
              </MenuGroup>
            ) : null}
            {blocked ? (
              <div className="px-2 py-1 text-muted-foreground text-xs">{props.disabledReason}</div>
            ) : null}
            <MenuSeparator />
            <MenuItem disabled={blocked} onClick={pick(() => setSetupOpen(true))}>
              <SettingsIcon />
              Architect &amp; workers…
            </MenuItem>
          </div>
        </MenuPopup>
      </Menu>
      {setupOpen ? (
        <ComposerTeamSetup
          {...props}
          active={active}
          anchor={triggerRef}
          disabledReason={props.disabledReason ?? null}
          onClose={() => setSetupOpen(false)}
        />
      ) : null}
    </>
  );
});
