import { newRoutingGroupId } from "@t3tools/client-runtime/routing";
import {
  AGENT_TEAM_LEAD_GUIDANCE_MAX_LENGTH,
  MAX_ROUTING_GROUP_MEMBERS,
  type ModelSelection,
  type RoutingGroup,
} from "@t3tools/contracts";
import { InfoIcon, MoreHorizontalIcon, PlusIcon, XIcon } from "lucide-react";
import { memo, useId, useState } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/** The setup kept when no named profile is picked; it is a team like any other. */
const CUSTOM_TEAM_ID = "custom-setup";
const CUSTOM_TEAM_NAME = "Custom setup";

interface Setup {
  readonly architect: ModelSelection | null;
  readonly workers: ReadonlyArray<ModelSelection | null>;
  readonly guidance: string;
  readonly unlimited: boolean;
  readonly parallel: number;
}

const keyOf = (selection: Pick<ModelSelection, "instanceId" | "model">) =>
  `${selection.instanceId}\u0000${selection.model}`;

function setupOf(team: RoutingGroup | undefined, fallbackLead: ModelSelection | null): Setup {
  const [architect, ...workers] = team?.members ?? [];
  return {
    architect: architect ?? fallbackLead,
    workers: team ? workers : [null],
    guidance: team?.leadGuidance ?? "",
    unlimited: (team?.maxParallel ?? 0) === 0,
    parallel: team?.maxParallel || 3,
  };
}

function InfoMark(props: { readonly label: string; readonly text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <InfoIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {props.text}
      </TooltipPopup>
    </Tooltip>
  );
}

function ModelField(props: {
  readonly label: string;
  readonly value: ModelSelection | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const options = props.entries.filter((entry) => entry.enabled && entry.models.length > 0);
  const value = props.value;
  const entry = value
    ? options.find((candidate) => candidate.instanceId === value.instanceId)
    : null;
  const modelName = value
    ? (entry?.models.find((model) => model.slug === value.model)?.name ?? value.model)
    : null;
  return (
    <Select
      value={value ? keyOf(value) : ""}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === "") return;
        const [instanceId, model] = next.split("\u0000");
        const picked = options.find((candidate) => candidate.instanceId === instanceId);
        if (!picked || !model) return;
        // Re-picking the current model keeps its saved options, such as effort.
        if (value && keyOf(value) === next) return;
        props.onChange({ instanceId: picked.instanceId, model });
      }}
    >
      <SelectTrigger aria-label={props.label} className="w-full">
        <SelectValue>
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              {entry ? (
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  acpRegistryAgentId={entry.acpRegistryAgentId}
                  acpRegistryIconUrl={entry.acpRegistryIconUrl}
                  size="compact"
                />
              ) : null}
              <span className="truncate">{modelName}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Choose a model</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup className="max-h-80">
        {options.map((option) => (
          <SelectGroup key={option.instanceId}>
            <SelectGroupLabel>{option.displayName}</SelectGroupLabel>
            {option.models.map((model) => (
              <SelectItem
                key={model.slug}
                value={keyOf({ instanceId: option.instanceId, model: model.slug })}
              >
                {model.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Architect & workers, beside the model picker's Agent team tab: the architect leads this thread
 * and delegates to the workers; Save setup keeps it as a team and turns it on here. Keyed by the
 * team in use, so it starts from that team each time.
 */
export const ComposerTeamSetup = memo(function ComposerTeamSetup(props: {
  readonly teams: ReadonlyArray<RoutingGroup>;
  /** The team this thread leads or the draft picked; its name stays even if it was deleted. */
  readonly active: { readonly id: string; readonly name: string } | null;
  readonly newThread: boolean;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  /** The thread's model, which a new setup starts from as its architect. */
  readonly currentSelection: ModelSelection;
  readonly sharedGuidance: string;
  /** After Apply or Use a single agent, such as closing the picker. */
  readonly onDone: () => void;
  readonly disabledReason?: string | null;
  readonly onSaveTeams: (teams: ReadonlyArray<RoutingGroup>) => void;
  readonly onApply: (team: RoutingGroup) => void;
  readonly onDisable: () => void;
}) {
  const active = props.active;
  const initialProfile =
    active && props.teams.some((team) => team.id === active.id) ? active.id : CUSTOM_TEAM_ID;
  const [profileId, setProfileId] = useState<string>(initialProfile);
  const [setup, setSetup] = useState<Setup>(() =>
    setupOf(
      props.teams.find((team) => team.id === initialProfile),
      props.currentSelection,
    ),
  );
  const [naming, setNaming] = useState<string | null>(null);
  const guidanceId = useId();
  const parallelId = useId();
  const profile = props.teams.find((team) => team.id === profileId);
  const named = props.teams.filter((team) => team.id !== CUSTOM_TEAM_ID);

  const load = (id: string) => {
    const team = props.teams.find((candidate) => candidate.id === id);
    setProfileId(id);
    setSetup(setupOf(team, props.currentSelection));
  };

  const workers = setup.workers.filter((worker): worker is ModelSelection => worker !== null);
  const members = (() => {
    const seen = new Set<string>();
    return [setup.architect, ...workers].filter((member): member is ModelSelection => {
      if (member === null || seen.has(keyOf(member))) return false;
      seen.add(keyOf(member));
      return true;
    });
  })();
  // Saved options (such as effort) stay with a member the setup keeps.
  const withSavedOptions = (member: ModelSelection) =>
    member.options !== undefined
      ? member
      : (props.teams
          .flatMap((team) => team.members)
          .find((saved) => keyOf(saved) === keyOf(member) && saved.options !== undefined) ??
        member);
  const teamFrom = (id: string, name: string): RoutingGroup => ({
    id,
    name,
    strategy: "order",
    team: true,
    members: members.map(withSavedOptions),
    maxParallel: setup.unlimited ? 0 : Math.max(1, Math.min(32, Math.round(setup.parallel))),
    leadGuidance: setup.guidance.trim(),
  });
  const problem =
    setup.architect === null
      ? "Choose an architect."
      : workers.length === 0
        ? "Add a worker."
        : members.length > MAX_ROUTING_GROUP_MEMBERS
          ? `A team takes at most ${MAX_ROUTING_GROUP_MEMBERS} models.`
          : null;

  const upsert = (team: RoutingGroup) => [
    ...props.teams.filter((existing) => existing.id !== team.id),
    team,
  ];
  const save = () => {
    if (problem !== null) return;
    const team = teamFrom(profile?.id ?? CUSTOM_TEAM_ID, profile?.name ?? CUSTOM_TEAM_NAME);
    props.onSaveTeams(upsert(team));
    props.onApply(team);
    props.onDone();
  };
  const saveAs = () => {
    const name = naming?.trim();
    if (!name || problem !== null) return;
    const team = teamFrom(
      newRoutingGroupId(
        name,
        props.teams.map((existing) => existing.id),
      ),
      name,
    );
    props.onSaveTeams(upsert(team));
    setProfileId(team.id);
    setNaming(null);
  };
  const remove = () => {
    if (!profile || profile.id === CUSTOM_TEAM_ID) return;
    props.onSaveTeams(props.teams.filter((team) => team.id !== profile.id));
    load(CUSTOM_TEAM_ID);
  };

  return (
    <>
      {/* Matches the effort column's header, so one rule runs across the top of the popup. */}
      <div className="shrink-0 px-3 pt-2.5">
        <div className="flex h-8.25 -translate-y-px items-center gap-2 border-b border-border/70 pb-1.5 text-sm">
          <h2 className="text-muted-foreground">Architect &amp; workers</h2>
          <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">
            {active?.name ?? "No team"}
          </span>
        </div>
      </div>
      <form
        data-composer-team-setup
        aria-label="Architect & workers"
        className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain px-3 pt-2.5 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <section className="grid gap-1.5">
          <span className="text-muted-foreground text-xs">Team profile</span>
          <div className="flex items-center gap-1.5">
            <Select
              value={profileId}
              onValueChange={(next) => {
                if (typeof next === "string") load(next);
              }}
            >
              <SelectTrigger aria-label="Team profile" className="min-w-0 flex-1">
                <SelectValue>{profile?.name ?? CUSTOM_TEAM_NAME}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={CUSTOM_TEAM_ID}>{CUSTOM_TEAM_NAME}</SelectItem>
                {named.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    type="button"
                    aria-label="Manage team profile"
                    disabled={!profile || profile.id === CUSTOM_TEAM_ID}
                  />
                }
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem variant="destructive" onClick={remove}>
                  Delete profile
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
          {naming === null ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="justify-self-start"
              onClick={() => setNaming("")}
            >
              <PlusIcon />
              Save as…
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                aria-label="Profile name"
                placeholder="Profile name"
                maxLength={64}
                value={naming}
                onChange={(event) => setNaming(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    saveAs();
                  }
                }}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!naming.trim() || problem !== null}
                onClick={saveAs}
              >
                Save profile
              </Button>
            </div>
          )}
        </section>

        <section className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-sm">Architect</span>
            <span className="text-muted-foreground text-xs">Plans &amp; reviews</span>
          </div>
          <ModelField
            label="Architect model"
            value={setup.architect}
            entries={props.entries}
            onChange={(architect) => setSetup((current) => ({ ...current, architect }))}
          />
          <div className="flex items-center gap-1.5">
            <label htmlFor={guidanceId} className="text-muted-foreground text-xs">
              Lead guidance
            </label>
            <InfoMark
              label="About lead guidance"
              text="Extra instructions for the architect, sent with the built-in team rules. Leave it empty to use the guidance from Settings → Providers → Agent teams."
            />
          </div>
          <Textarea
            id={guidanceId}
            rows={3}
            maxLength={AGENT_TEAM_LEAD_GUIDANCE_MAX_LENGTH}
            placeholder={
              props.sharedGuidance.trim() ||
              "Extra instructions for the lead, on top of the built-in team rules."
            }
            value={setup.guidance}
            onChange={(event) =>
              setSetup((current) => ({ ...current, guidance: event.target.value }))
            }
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={setup.guidance === ""}
            onClick={() => setSetup((current) => ({ ...current, guidance: "" }))}
          >
            Reset to default
          </Button>
        </section>

        <section className="grid gap-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Workers</span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-label="Add worker"
              disabled={setup.workers.length + 1 >= MAX_ROUTING_GROUP_MEMBERS}
              onClick={() =>
                setSetup((current) => ({ ...current, workers: [...current.workers, null] }))
              }
            >
              <PlusIcon />
              Add
            </Button>
          </div>
          {setup.workers.map((worker, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- workers have no identity until saved; the index is their slot
            <div key={index} className="grid gap-1">
              <div className="flex items-center justify-between text-sm">
                <span>
                  <span className="me-2 text-muted-foreground tabular-nums">{index + 1}</span>
                  Worker {index + 1}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove worker ${index + 1}`}
                  onClick={() =>
                    setSetup((current) => ({
                      ...current,
                      workers: current.workers.filter((_, at) => at !== index),
                    }))
                  }
                >
                  <XIcon />
                </Button>
              </div>
              <ModelField
                label={`Worker ${index + 1} model`}
                value={worker}
                entries={props.entries}
                onChange={(selection) =>
                  setSetup((current) => ({
                    ...current,
                    workers: current.workers.map((existing, at) =>
                      at === index ? selection : existing,
                    ),
                  }))
                }
              />
            </div>
          ))}
        </section>

        <section className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <label htmlFor={parallelId} className="text-sm">
              At once
            </label>
            <InfoMark
              label="How parallel workers run"
              text="Most tasks the architect keeps out at once. Independent work runs in parallel; a task over the limit waits for a result."
            />
          </div>
          <div className="flex items-center gap-2">
            {setup.unlimited ? null : (
              <Input
                id={parallelId}
                type="number"
                min={1}
                max={32}
                className="w-16"
                aria-label="Workers at once"
                value={String(setup.parallel)}
                onChange={(event) =>
                  setSetup((current) => ({
                    ...current,
                    parallel: Number(event.target.value) || 1,
                  }))
                }
              />
            )}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={setup.unlimited}
                aria-label="Unlimited workers"
                onCheckedChange={(checked) =>
                  setSetup((current) => ({ ...current, unlimited: checked === true }))
                }
              />
              Unlimited
            </label>
          </div>
        </section>

        <p className="grid gap-1 text-muted-foreground text-xs">
          <span>Workers run as delegated tasks in this thread&apos;s checkout.</span>
          <span>
            They keep this thread&apos;s permissions; their results come back to the architect.
          </span>
        </p>

        {problem !== null || props.disabledReason ? (
          <p role="alert" className="text-destructive-foreground text-xs">
            {props.disabledReason ?? problem}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          {active ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                props.onDisable();
                props.onDone();
              }}
            >
              Use a single agent
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">
              {props.newThread ? "Starts this thread as a team" : "Applies from your next message"}
            </span>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={problem !== null || Boolean(props.disabledReason)}
          >
            {active ? "Apply setup" : "Save setup"}
          </Button>
        </div>
      </form>
    </>
  );
});
