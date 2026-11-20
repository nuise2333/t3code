import { isBotThread } from "@t3tools/client-runtime/state/threads";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { useBotHomeThreadKeys, useQuietThreadShell } from "../../state/entities";

const SidebarMode = Schema.Literals(["threads", "bots"]);
export type SidebarMode = typeof SidebarMode.Type;

const SIDEBAR_MODE_KEY = "t3code:sidebar:mode";

function useSidebarMode() {
  return useLocalStorage<SidebarMode, SidebarMode>(SIDEBAR_MODE_KEY, "threads", SidebarMode);
}

/**
 * Whether the sidebar shows bots: chosen, or because a bot's chat or task is open, since the
 * thread list leaves those out. Going back to threads from one leaves it for a new thread.
 */
export function useSidebarBotsOpen() {
  const [mode, setMode] = useSidebarMode();
  const routeRef = useThreadRouteRef();
  const routeShell = useQuietThreadShell(routeRef);
  const botHomes = useBotHomeThreadKeys();
  const navigate = useNavigate();
  const onBotThread =
    routeRef !== null && isBotThread(routeRef, routeShell?.lineage ?? null, botHomes);
  const setOpen = (open: boolean) => {
    setMode(open ? "bots" : "threads");
    if (!open && onBotThread) void navigate({ to: "/" });
  };
  return [mode === "bots" || onBotThread, setOpen] as const;
}

export function setSidebarMode(mode: SidebarMode) {
  writeLocalStorageValue(SIDEBAR_MODE_KEY, mode, "threads", SidebarMode);
}

let focusBotsSearchOnMount = false;

/** Switching to bots from the bar puts the cursor in the bots search; a reload does not. */
export function requestBotsSearchFocus() {
  focusBotsSearchOnMount = true;
}

export function takeBotsSearchFocusRequest(): boolean {
  const requested = focusBotsSearchOnMount;
  focusBotsSearchOnMount = false;
  return requested;
}
