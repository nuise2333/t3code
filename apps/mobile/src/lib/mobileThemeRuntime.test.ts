import { describe, expect, it } from "vite-plus/test";

import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  themeAppearance: "light",
  themeMode: "system",
};

describe("mobileThemeRuntime", () => {
  it("lets system appearance changes flow through the root ScopedTheme only", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
    });

    expect(operations).toEqual([]);
  });

  it("maps single-appearance themes only for their supported appearance", () => {
    expect(getMobileUniwindThemeName("obsidian-dark", "dark")).toBe("obsidian-dark-dark");
    expect(getMobileUniwindThemeName("obsidian-dark", "light")).toBe("light");
    expect(getMobileUniwindThemeName("daylight-crystal", "light")).toBe("daylight-crystal-light");
    expect(getMobileUniwindThemeName("daylight-crystal", "dark")).toBe("dark");
  });
});
