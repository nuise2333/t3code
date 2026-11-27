import { describe, expect, it } from "@effect/vitest";
import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

import { qoderPermissionDisposition, qoderSessionConfigForPolicy } from "./qoderAcp.ts";

describe("Qoder access modes", () => {
  it.each<[RuntimeMode, string, string, "allow" | "ask" | "deny", ProviderInteractionMode?]>([
    ["auto-accept-edits", "Bash", "acceptEdits", "ask"],
    // Qoder asks only about what it flagged itself, so T3 must not answer for the user.
    ["auto-accept-edits", "Edit", "acceptEdits", "ask"],
    ["auto", "Bash", "auto", "ask"],
    ["full-access", "Bash", "yolo", "allow"],
    ["full-access", "ExitPlanMode", "yolo", "ask"],
    ["full-access", "ExitPlanMode", "yolo", "deny", "plan"],
  ])(
    "%s runs %s as %s and answers %s",
    (runtimeMode, toolName, mode, disposition, interactionMode = "default") => {
      const policy = { runtimeMode, interactionMode, cwd: "/tmp" };
      expect(qoderSessionConfigForPolicy(policy)).toEqual([{ id: "permission_mode", value: mode }]);
      expect(
        qoderPermissionDisposition(policy, {
          sessionId: "session",
          options: [],
          toolCall: {
            toolCallId: "call",
            kind: toolName === "Bash" ? "execute" : toolName === "Edit" ? "edit" : "other",
            _meta: { qoder: { toolName } },
          },
        }),
      ).toBe(disposition);
    },
  );
});
