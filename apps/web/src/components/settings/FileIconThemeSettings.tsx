import { FolderTreeIcon, PackagePlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  fileIconThemeCollectionId,
  importOpenVsxIconThemeExtension,
} from "../../fileIconThemeImport";
import {
  getInstalledFileIconThemes,
  removeFileIconThemeCollection,
  replaceFileIconThemeCollection,
  type FileIconThemeSummary,
  setActiveFileIconTheme,
  useActiveFileIconThemeId,
  useInstalledFileIconThemes,
} from "../../fileIconThemes";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ThemeSearchSection, type ThemeSearchKind } from "./ThemeSearchSection";

const BUILT_IN_VALUE = "built-in";

const ICON_THEME_SEARCH: ThemeSearchKind<FileIconThemeSummary, boolean> = {
  contribution: "iconThemes",
  noun: "icon theme",
  heading: "Search file icon themes",
  placeholder: "Search icon themes...",
  suggestions: ["Material Icon Theme", "vscode-icons", "Catppuccin Icons", "Symbols"],
  fallbackDescription: "A community file icon theme for your editor.",
  updateDescription: "This replaces its installed variants with the latest version.",
  icon: FolderTreeIcon,
  isInstalled: (extension) =>
    getInstalledFileIconThemes().some(
      (theme) => theme.collectionId === fileIconThemeCollectionId(extension.id),
    ),
  readInstalled: (extension) => ICON_THEME_SEARCH.isInstalled(extension),
  hasInstalled: (installed) => installed,
  install: async (extension, signal) => {
    const themes = await importOpenVsxIconThemeExtension(extension, signal);
    signal.throwIfAborted();
    return replaceFileIconThemeCollection(fileIconThemeCollectionId(extension.id), themes);
  },
};

export function FileIconThemeRow() {
  const installed = useInstalledFileIconThemes();
  const activeId = useActiveFileIconThemeId();
  const active = installed.find((theme) => theme.id === activeId) ?? null;
  const [dialog, setDialog] = useState<AbortController | null>(null);

  const closeDialog = () => {
    dialog?.abort();
    setDialog(null);
  };

  const removeActive = async () => {
    if (!active) return;
    try {
      await removeFileIconThemeCollection(active.collectionId);
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Icon theme could not be removed",
          description: cause instanceof Error ? cause.message : undefined,
        }),
      );
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("file-icon-theme")}
      devicePreference
      description="Choose the icons shown for files and folders. Add VS Code icon themes from Open VSX."
      resetAction={
        active ? (
          <SettingResetButton label="file icons" onClick={() => setActiveFileIconTheme(null)} />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-48 sm:flex-none">
            <Select
              value={active?.id ?? BUILT_IN_VALUE}
              onValueChange={(value) =>
                setActiveFileIconTheme(value === BUILT_IN_VALUE || value === null ? null : value)
              }
            >
              <SelectTrigger size="sm" className="w-full min-w-0" aria-label="File icons">
                <SelectValue>{active?.label ?? "T3 Code (default)"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={BUILT_IN_VALUE}>T3 Code (default)</SelectItem>
                {installed.map((theme) => (
                  <SelectItem key={theme.id} value={theme.id}>
                    {theme.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          {active ? (
            <Button
              aria-label={`Remove ${active.label}`}
              size="icon-sm"
              variant="ghost-muted"
              onClick={() => void removeActive()}
            >
              <Trash2Icon />
            </Button>
          ) : null}
          <Button
            aria-label="Add icon theme"
            size="icon-sm"
            variant="outline"
            onClick={() => setDialog(new AbortController())}
          >
            <PackagePlusIcon />
          </Button>
          <Dialog
            open={dialog !== null}
            onOpenChange={(open) => {
              if (!open) closeDialog();
            }}
          >
            <DialogPopup className="max-w-3xl overflow-hidden">
              <DialogHeader>
                <DialogTitle>Add an icon theme</DialogTitle>
              </DialogHeader>
              {dialog ? (
                <DialogPanel>
                  <ThemeSearchSection
                    kind={ICON_THEME_SEARCH}
                    signal={dialog.signal}
                    onInstalled={(themes, { updated }) => {
                      const selected = themes.find((theme) => theme.id === activeId) ?? themes[0];
                      if (selected) setActiveFileIconTheme(selected.id);
                      toastManager.add(
                        stackedThreadToast({
                          type: "success",
                          title: `${selected?.label ?? "Icon theme"} ${updated ? "updated" : "added"}`,
                          description:
                            themes.length > 1
                              ? themes.map((theme) => theme.label).join(", ")
                              : undefined,
                        }),
                      );
                      closeDialog();
                    }}
                  />
                </DialogPanel>
              ) : null}
            </DialogPopup>
          </Dialog>
        </div>
      }
    />
  );
}
