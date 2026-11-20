import type { EnvironmentId } from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect } from "react";

import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { useDefaultBotsEnvironmentId } from "../bots/botShared";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { requestBotsSearchFocus, useSidebarMode } from "./sidebarMode";
import { useSidebarBotsModel } from "./useSidebarBotsModel";

/** The bar at the bottom of the sidebar that switches it between threads and bots. */
export function SidebarBotsBar() {
  const environmentId = useDefaultBotsEnvironmentId();
  if (environmentId === null) return <BotsBarButton count={0} unread={0} />;
  return <SidebarBotsBarEnvironment key={environmentId} environmentId={environmentId} />;
}

function SidebarBotsBarEnvironment({ environmentId }: { environmentId: EnvironmentId }) {
  const model = useSidebarBotsModel(environmentId, useThreadRouteRef());
  const { pendingSeen, storeSeen } = model;
  // The bar is always mounted, so it alone records first sightings and the open chat as read.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read marks live in localStorage, outside React
  useEffect(() => {
    if (pendingSeen !== null) storeSeen(pendingSeen);
  }, [pendingSeen, storeSeen]);
  return <BotsBarButton count={model.bots.length} unread={model.unreadCount} />;
}

function BotsBarButton({ count, unread }: { count: number; unread: number }) {
  const [mode, setMode] = useSidebarMode();
  const open = mode === "bots";
  const Chevron = open ? ChevronDownIcon : ChevronUpIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            variant="outline"
            isActive={open}
            aria-pressed={open}
            aria-label={unread > 0 ? `Bots, ${unread} unread` : "Bots"}
            onClick={() => {
              if (!open) requestBotsSearchFocus();
              setMode(open ? "threads" : "bots");
            }}
          >
            <BotIcon />
            <span>Bots</span>
            {unread > 0 ? (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
            ) : null}
            <span className="ms-auto text-xs text-sidebar-muted-foreground tabular-nums">
              {count > 0 ? count : ""}
            </span>
            <Chevron />
          </SidebarMenuButton>
        }
      />
      <TooltipPopup side="top">{open ? "Back to threads" : "Show bots"}</TooltipPopup>
    </Tooltip>
  );
}
