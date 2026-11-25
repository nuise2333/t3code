import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { AcpRegistrySettings } from "../settings.ts";

/** scripts/bin/qoder, the proxy in front of the Qoder app's own runtime. */
export function isQoderAcp(settings: Pick<AcpRegistrySettings, "source" | "commandPath">): boolean {
  return (
    settings.source === "local" &&
    /^qoder(\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? "")
  );
}

// Qoder's plan mode and three access modes, in its own words.
export const QODER_PRESENTATION: Required<
  Pick<ServerProvider, "showInteractionModeToggle" | "supportedRuntimeModes" | "runtimeModeLabels">
> = {
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["auto-accept-edits", "auto", "full-access"],
  runtimeModeLabels: [
    {
      mode: "auto-accept-edits",
      label: "Ask every time",
      description: "Always ask before commands, external edits, and internet use.",
    },
    {
      mode: "auto",
      label: "Auto approve",
      description: "Only asks when a potential risk is detected.",
    },
    {
      mode: "full-access",
      label: "Full access",
      description: "Never ask, with full access to your files, terminal, and internet.",
    },
  ],
};

const QODER_PERMISSION_MODES: Record<RuntimeMode, string> = {
  "approval-required": "default",
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "yolo",
};

export function qoderSessionConfigForPolicy(
  policy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "runtimeMode">,
) {
  return [{ id: "permission_mode", value: QODER_PERMISSION_MODES[policy.runtimeMode] }];
}

/** Qoder asks only what its own access mode leaves to the user, so only Full access answers. */
export function qoderPermissionDisposition(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  const disposition = acpPermissionDisposition(policy, request);
  if (disposition !== "allow") return disposition;
  if (policy.runtimeMode !== "full-access") return "ask";
  const qoder = request.toolCall._meta?.qoder;
  if (typeof qoder !== "object" || qoder === null) return disposition;
  const planning = "planning" in qoder && qoder.planning === true;
  const planExit = "toolName" in qoder && qoder.toolName === "ExitPlanMode";
  return planning || planExit ? "ask" : disposition;
}
