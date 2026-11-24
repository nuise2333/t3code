/**
 * Where the standalone permissions trigger shows, whether it overflows into the compact menu,
 * and which control answers the composer.mode shortcut. Permissions live on the footer rather
 * than inside the model picker, so either the trigger or the overflow menu owns composer.mode.
 */
export function resolveComposerControlsOwnership(input: {
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  // Like Antigravity, permissions show only their mode icon; the tooltip names the mode.
  const accessDisplay = "icon" as const;
  const showModeBlock = true;
  const modeHidden = input.measuredHiddenBlockCount > 0;
  const hiddenBlockIds = modeHidden ? (["mode"] as const) : ([] as const);
  const overflowShowsPermissions = modeHidden;
  return {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: hiddenBlockIds.length,
    hiddenBlockIds,
    overflowShowsPermissions,
    pickerOwnsModeShortcut: false,
  };
}
