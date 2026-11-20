import * as Schema from "effect/Schema";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";

const SidebarMode = Schema.Literals(["threads", "bots"]);
export type SidebarMode = typeof SidebarMode.Type;

const SIDEBAR_MODE_KEY = "t3code:sidebar:mode";

export function useSidebarMode() {
  return useLocalStorage<SidebarMode, SidebarMode>(SIDEBAR_MODE_KEY, "threads", SidebarMode);
}

export function setSidebarMode(mode: SidebarMode) {
  writeLocalStorageValue(SIDEBAR_MODE_KEY, mode, "threads", SidebarMode);
}
