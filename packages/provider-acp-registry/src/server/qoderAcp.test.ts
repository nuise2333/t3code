import { describe, expect, it } from "@effect/vitest";
import type { RuntimeMode } from "@t3tools/contracts";

import { qoderPermissionDisposition, qoderSessionConfigForPolicy } from "./qoderAcp.ts";

describe("Qoder access modes", () => {
  it.each<[RuntimeMode, string, string, "allow" | "ask"]>([
    ["auto-accept-edits", "Bash", "acceptEdits", "ask"],
    // Auto asks only about what Qoder itself flagged, so T3 must not answer for the user.
    ["auto", "Bash", "auto", "ask"],
    ["full-access", "Bash", "yolo", "allow"],
    ["full-access", "ExitPlanMode", "yolo", "ask"],
  ])("%s runs %s as %s and answers %s", (runtimeMode, toolName, mode, disposition) => {
    const policy = { runtimeMode, interactionMode: "default" as const, cwd: "/tmp" };
    expect(qoderSessionConfigForPolicy(policy)).toEqual([{ id: "permission_mode", value: mode }]);
    expect(
      qoderPermissionDisposition(policy, {
        sessionId: "session",
        options: [],
        toolCall: {
          toolCallId: "call",
          kind: toolName === "Bash" ? "execute" : "other",
          _meta: { qoder: { toolName } },
        },
      }),
    ).toBe(disposition);
  });
});
