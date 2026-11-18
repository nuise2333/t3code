import { describe, expect, it } from "vite-plus/test";

import { ariaShortcutsClaimKey } from "./composerFocusRedirect";

describe("ariaShortcutsClaimKey", () => {
  it.each([
    { shortcuts: "J K", key: "j", shiftKey: false, claimed: true },
    { shortcuts: "J K", key: "J", shiftKey: true, claimed: false },
    { shortcuts: "J K", key: "x", shiftKey: false, claimed: false },
    { shortcuts: "Space Shift+Space PageDown", key: " ", shiftKey: false, claimed: true },
    { shortcuts: "Space Shift+Space PageDown", key: " ", shiftKey: true, claimed: true },
    { shortcuts: "Space", key: " ", shiftKey: true, claimed: false },
    { shortcuts: "J K", key: " ", shiftKey: false, claimed: false },
  ])("$shortcuts claims $key (shift $shiftKey): $claimed", ({ shortcuts, claimed, ...event }) => {
    expect(ariaShortcutsClaimKey(shortcuts, event)).toBe(claimed);
  });
});
