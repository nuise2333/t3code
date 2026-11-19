import { describe, expect, it } from "vite-plus/test";

import {
  TOKEN_SAVER_REMIND_EVERY,
  tokenSaverDue,
  tokenSaverEstimate,
  tokenSaverGuidance,
} from "./tokenSaver.ts";

describe("token saver", () => {
  it("writes guidance for the packs that can run, and a plain switch-off", () => {
    const guidance = tokenSaverGuidance(
      { packs: ["caveman", "rtk", "quiet-tools"], level: "lite" },
      { rtk: false },
    );
    expect(guidance).toContain("Answer first.");
    expect(guidance).toContain("Keep tool output small.");
    expect(guidance).not.toContain("rtk is installed");
    // Caveman keeps full sentences where terseness would hurt.
    expect(guidance).toContain("security warnings");
    expect(tokenSaverGuidance({ packs: ["economizer"], level: "full" }, { rtk: false })).toContain(
      "t3-token-economizer.md",
    );
    expect(tokenSaverGuidance({ packs: [], level: "full" }, { rtk: true })).toContain(
      "Token saver is off",
    );
    expect(tokenSaverGuidance({ packs: ["rtk"], level: "full" }, { rtk: false })).toContain(
      "Token saver is off",
    );
  });

  it("goes out after a change and as a reminder, never for an off saver twice", () => {
    expect(tokenSaverDue({ turnsSinceChange: 0, anyActive: false })).toBe(true);
    expect(tokenSaverDue({ turnsSinceChange: 1, anyActive: true })).toBe(false);
    expect(tokenSaverDue({ turnsSinceChange: TOKEN_SAVER_REMIND_EVERY, anyActive: true })).toBe(
      true,
    );
    expect(tokenSaverDue({ turnsSinceChange: TOKEN_SAVER_REMIND_EVERY, anyActive: false })).toBe(
      false,
    );
  });

  it("compounds savings rather than adding them", () => {
    expect(tokenSaverEstimate({ packs: [], level: "full" }, { rtk: true })).toBe(0);
    expect(tokenSaverEstimate({ packs: ["caveman"], level: "full" }, { rtk: true })).toBe(25);
    expect(
      tokenSaverEstimate({ packs: ["caveman", "lean-code"], level: "full" }, { rtk: true }),
    ).toBe(34);
  });
});
