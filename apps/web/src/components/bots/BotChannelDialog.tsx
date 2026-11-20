import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  BOT_CHANNEL_NAME_MAX_CHARS,
  type Bot,
  type BotChannel,
  type BotId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { BotAvatar } from "./BotAvatar";
import { reportBotFailure } from "./botShared";

/** Creates a channel, or edits one's name, members and lead. */
export function BotChannelDialog({
  environmentId,
  bots,
  channel,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<Bot>;
  readonly channel: BotChannel | null;
  readonly onClose: () => void;
  readonly onCreated?: (channel: BotChannel) => void;
}) {
  const canOperate = useAtomValue(serverEnvironment.createBotChannel.permissionAtom(environmentId));
  const createChannel = useAtomCommand(serverEnvironment.createBotChannel, {
    label: "bot channel create",
  });
  const updateChannel = useAtomCommand(serverEnvironment.updateBotChannel, {
    label: "bot channel update",
  });
  const [name, setName] = useState(channel?.name ?? "");
  const [memberIds, setMemberIds] = useState<ReadonlyArray<BotId>>(channel?.memberIds ?? []);
  const [leadBotId, setLeadBotId] = useState<BotId | null>(channel?.leadBotId ?? null);
  const [saving, setSaving] = useState(false);
  const members = memberIds.flatMap((id) => bots.filter((bot) => bot.id === id));
  const lead = members.find((bot) => bot.id === leadBotId) ?? members[0] ?? null;
  const trimmed = name.trim().replace(/^#+/, "").trim();

  const toggle = (id: BotId, checked: boolean) =>
    setMemberIds((current) =>
      checked
        ? [...current.filter((member) => member !== id), id]
        : current.filter((m) => m !== id),
    );

  const submit = async () => {
    if (saving || trimmed === "") return;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setSaving(true);
    const result =
      channel === null
        ? await createChannel({ environmentId, input: { name: trimmed, memberIds } })
        : await updateChannel({
            environmentId,
            input: { id: channel.id, name: trimmed, memberIds, leadBotId: lead?.id ?? null },
          });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportBotFailure(
          channel === null ? "Could not create the channel" : "Could not save the channel",
          squashAtomCommandFailure(result),
        );
      }
      return;
    }
    onClose();
    if (channel === null) onCreated?.(result.value.channel);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{channel === null ? "New channel" : "Channel settings"}</DialogTitle>
          <DialogDescription>
            {channel === null
              ? "A shared conversation for a small group of bots."
              : "Posts with no @mention go to the lead."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="min-w-0 space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset disabled={saving} className="min-w-0 space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="bot-channel-name">
                  {channel === null ? "Channel name" : "Name"}
                </Label>
                <Input
                  id="bot-channel-name"
                  autoComplete="off"
                  maxLength={BOT_CHANNEL_NAME_MAX_CHARS + 1}
                  placeholder="e.g. launch"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium text-foreground">
                  {channel === null ? "Bots" : "Members"}
                </legend>
                {bots.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No bots are available.</p>
                ) : (
                  <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                    {bots.map((bot) => (
                      <li key={bot.id}>
                        <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-accent">
                          <Checkbox
                            checked={memberIds.includes(bot.id)}
                            onCheckedChange={(checked) => toggle(bot.id, checked)}
                          />
                          <BotAvatar bot={bot} />
                          <span className="min-w-0 truncate">{bot.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>
              {channel !== null && members.length > 0 ? (
                <div className="space-y-1.5">
                  <Label htmlFor="bot-channel-lead">Lead</Label>
                  <Select
                    value={lead?.id ?? null}
                    onValueChange={(id: BotId | null) => {
                      if (id) setLeadBotId(id);
                    }}
                  >
                    <SelectTrigger size="sm" id="bot-channel-lead">
                      <SelectValue>{lead?.name ?? ""}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {members.map((bot) => (
                        <SelectItem key={bot.id} value={bot.id} label={bot.name}>
                          {bot.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
            </fieldset>
            <button type="submit" hidden />
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!canOperate || saving || trimmed === ""}
            onClick={() => void submit()}
          >
            {channel === null ? "Create channel" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
