import { BotIcon, ChevronDownIcon, MessagesSquareIcon } from "lucide-react";

import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { useSidebarMode } from "./sidebarMode";

const MODES = [
  { value: "threads", label: "Threads", Icon: MessagesSquareIcon },
  { value: "bots", label: "Bots", Icon: BotIcon },
] as const;

export function SidebarModeSwitcher() {
  const [mode, setMode] = useSidebarMode();
  const current = MODES.find((entry) => entry.value === mode) ?? MODES[0];
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarMenuButton variant="outline" aria-label={`Sidebar shows ${current.label}`} />
        }
      >
        <current.Icon />
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="w-(--anchor-width)">
        <MenuRadioGroup
          value={mode}
          onValueChange={(next) => {
            if (next === "threads" || next === "bots") setMode(next);
          }}
        >
          {MODES.map(({ value, label, Icon }) => (
            <MenuRadioItem key={value} value={value} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <Icon />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
