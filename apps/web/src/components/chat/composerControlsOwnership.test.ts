import { describe, expect, it } from "vite-plus/test";

import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

const base = {
  collapsed: false,
  measuredHiddenBlockCount: 0,
};

describe("resolveComposerControlsOwnership", () => {
  it("shows a labelled standalone permissions control that owns composer.mode", () => {
    const result = resolveComposerControlsOwnership(base);
    expect(result).toMatchObject({
      accessDisplay: "label",
      showModeBlock: true,
      hiddenBlockIds: [],
      overflowShowsPermissions: false,
      pickerOwnsModeShortcut: false,
    });
  });

  it("gives an overflowed permissions control to the overflow menu", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      measuredHiddenBlockCount: 1,
    });
    expect(result.hiddenBlockIds).toEqual(["mode"]);
    expect(result.overflowShowsPermissions).toBe(true);
    expect(result.pickerOwnsModeShortcut).toBe(false);
  });

  it("shows the permissions control as an icon in the compacted row", () => {
    const result = resolveComposerControlsOwnership({
      ...base,
      collapsed: true,
    });
    expect(result.accessDisplay).toBe("icon");
    expect(result.showModeBlock).toBe(true);
    expect(result.pickerOwnsModeShortcut).toBe(false);
  });
});
