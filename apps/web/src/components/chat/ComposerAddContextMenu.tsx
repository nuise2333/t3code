import {
  AtSignIcon,
  ChromeIcon,
  FolderIcon,
  PaperclipIcon,
  PlusIcon,
  SquareSlashIcon,
} from "lucide-react";
import { useRef } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps, isInsideComposerFloatingLayer } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export interface ComposerAddContextMenuProps {
  readonly canAttachFiles: boolean;
  readonly addComposerAttachments: (files: File[]) => Promise<boolean>;
  readonly onPickFolder?: (() => void) | undefined;
  readonly onOpenMention?: (() => void) | undefined;
  readonly onOpenActions?: (() => void) | undefined;
  readonly onOpenBrowser?: (() => void) | undefined;
  readonly focusComposer: () => void;
  readonly disabled?: boolean | undefined;
}

export function ComposerAddContextMenu({
  canAttachFiles,
  addComposerAttachments,
  onPickFolder,
  onOpenMention,
  onOpenActions,
  onOpenBrowser,
  focusComposer,
  disabled = false,
}: ComposerAddContextMenuProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const skipCloseFocusReturnRef = useRef(false);
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const [open, setOpen] = useComposerMenuState(disabled);

  const hasAnyItem =
    canAttachFiles ||
    onPickFolder !== undefined ||
    onOpenMention !== undefined ||
    onOpenActions !== undefined ||
    onOpenBrowser !== undefined;

  if (!hasAnyItem) return null;

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      skipCloseFocusReturnRef.current = false;
    }
    setOpen(nextOpen);
  };

  const runAction = (action: () => void) => {
    skipCloseFocusReturnRef.current = true;
    action();
  };

  const finalFocus = !isCoarsePointer
    ? () => {
        if (skipCloseFocusReturnRef.current) {
          skipCloseFocusReturnRef.current = false;
          return false;
        }
        const activeElement = document.activeElement;
        if (
          activeElement !== document.body &&
          activeElement !== triggerRef.current &&
          !isInsideComposerFloatingLayer(activeElement)
        ) {
          return false;
        }
        focusComposer();
        return false;
      }
    : undefined;

  return (
    <>
      {canAttachFiles ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            // Inserting a chip refocuses the editor after the draft renders;
            // focusing synchronously here would report the editor's stale text
            // over the prompt that was just written.
            void addComposerAttachments(files).then((inserted) => {
              if (!inserted) focusComposer();
            });
          }}
        />
      ) : null}
      <Menu open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    ref={triggerRef}
                    type="button"
                    variant="outline"
                    size="icon-sm-pill"
                    disabled={disabled}
                    aria-label="Add to context"
                  />
                }
              />
            }
          >
            <PlusIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>Add to context</TooltipPopup>
        </Tooltip>
        <MenuPopup
          side="top"
          align="start"
          sideOffset={8}
          className="w-56"
          {...composerFloatingLayerProps}
          finalFocus={finalFocus}
        >
          <MenuGroup>
            <MenuGroupLabel>Add to context</MenuGroupLabel>
            {canAttachFiles ? (
              <MenuItem
                density="touch"
                onClick={() => runAction(() => fileInputRef.current?.click())}
              >
                <PaperclipIcon aria-hidden="true" />
                <MenuItemLabel>Files</MenuItemLabel>
              </MenuItem>
            ) : null}
            {onPickFolder ? (
              <MenuItem density="touch" onClick={() => runAction(onPickFolder)}>
                <FolderIcon aria-hidden="true" />
                <MenuItemLabel>Folder</MenuItemLabel>
              </MenuItem>
            ) : null}
            {onOpenMention ? (
              <MenuItem density="touch" onClick={() => runAction(onOpenMention)}>
                <AtSignIcon aria-hidden="true" />
                <MenuItemLabel>Mention</MenuItemLabel>
              </MenuItem>
            ) : null}
            {onOpenActions ? (
              <MenuItem density="touch" onClick={() => runAction(onOpenActions)}>
                <SquareSlashIcon aria-hidden="true" />
                <MenuItemLabel>Actions</MenuItemLabel>
              </MenuItem>
            ) : null}
            {onOpenBrowser ? (
              <MenuItem density="touch" onClick={() => runAction(onOpenBrowser)}>
                <ChromeIcon aria-hidden="true" />
                <MenuItemLabel>Browser</MenuItemLabel>
              </MenuItem>
            ) : null}
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </>
  );
}
