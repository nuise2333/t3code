import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  bundledAcpIconSvg,
  bundledAcpIconUrlForAgentId,
  bundledAcpIconUrlForCommand,
  isFullColorAcpIconUrl,
  officialAcpRegistryIconUrlForAgentId,
  resolveOfficialAcpRegistryIconUrl,
} from "./acpRegistry.ts";

const decodeUninstallInput = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallInput);
const decodeUninstallResult = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallResult);

describe("ACP Registry contracts", () => {
  it("accepts only official Registry icon URLs and safe agent IDs", () => {
    expect(officialAcpRegistryIconUrlForAgentId("antigravity-acp")).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg",
    );
    expect(officialAcpRegistryIconUrlForAgentId("../antigravity-acp")).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
      ),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg");
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://cdn.agentclientprotocol.com.evil/registry/v1/latest/pi-acp.svg",
      ),
    ).toBeNull();
    expect(
      resolveOfficialAcpRegistryIconUrl(
        "https://user@cdn.agentclientprotocol.com/registry/v1/latest/pi-acp.svg",
      ),
    ).toBeNull();
  });

  it("resolves bundled icons for well-known local ACP commands only", () => {
    expect(bundledAcpIconUrlForCommand("dsh")).toBe("t3-acp-icon:deepseek-harness");
    expect(bundledAcpIconUrlForCommand(" /opt/homebrew/bin/dsh ")).toBe(
      "t3-acp-icon:deepseek-harness",
    );
    expect(bundledAcpIconUrlForCommand("C:\\Tools\\DSH.cmd")).toBe("t3-acp-icon:deepseek-harness");
    expect(bundledAcpIconUrlForCommand("dshell")).toBeNull();
    expect(bundledAcpIconUrlForCommand("")).toBeNull();

    const dataUrl = resolveOfficialAcpRegistryIconUrl("t3-acp-icon:deepseek-harness");
    expect(dataUrl).toMatch(/^data:image\/svg\+xml,%3Csvg/);
    expect(resolveOfficialAcpRegistryIconUrl(dataUrl)).toBe(dataUrl);
    expect(resolveOfficialAcpRegistryIconUrl("t3-acp-icon:unknown")).toBeNull();
    expect(resolveOfficialAcpRegistryIconUrl("data:image/svg+xml,%3Csvg%2F%3E")).toBeNull();
  });

  it("replaces generic Registry glyphs with bundled full-color vendor marks", () => {
    expect(bundledAcpIconUrlForAgentId("kimi-code")).toBe("t3-acp-icon:kimi-code");
    expect(bundledAcpIconUrlForAgentId(" kimi ")).toBe("t3-acp-icon:kimi-code");
    expect(bundledAcpIconUrlForAgentId("github-copilot-cli")).toBeNull();
    expect(bundledAcpIconUrlForAgentId(null)).toBeNull();
    expect(bundledAcpIconUrlForCommand("/Users/me/.kimi-code/bin/kimi")).toBe(
      "t3-acp-icon:kimi-code",
    );

    const kimiDataUrl = resolveOfficialAcpRegistryIconUrl("t3-acp-icon:kimi-code");
    expect(kimiDataUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(isFullColorAcpIconUrl(kimiDataUrl)).toBe(true);
    expect(
      isFullColorAcpIconUrl(resolveOfficialAcpRegistryIconUrl("t3-acp-icon:deepseek-harness")),
    ).toBe(false);
    expect(
      isFullColorAcpIconUrl("https://cdn.agentclientprotocol.com/registry/v1/latest/kimi-code.svg"),
    ).toBe(false);
    expect(isFullColorAcpIconUrl(null)).toBe(false);

    expect(bundledAcpIconSvg("t3-acp-icon:kimi-code")?.fullColor).toBe(true);
    expect(bundledAcpIconSvg(kimiDataUrl)?.svg).toMatch(/^<svg /);
    expect(bundledAcpIconSvg("t3-acp-icon:deepseek-harness")?.fullColor).toBe(false);
    expect(
      bundledAcpIconSvg("https://cdn.agentclientprotocol.com/registry/v1/latest/kimi-code.svg"),
    ).toBeNull();
  });

  it("decodes managed binary uninstall payloads and rejects unsafe agent IDs", () => {
    expect(decodeUninstallInput({ agentId: "  example-agent  " })).toEqual({
      agentId: "example-agent",
    });
    expect(decodeUninstallResult({ agentId: "example-agent", removed: false })).toEqual({
      agentId: "example-agent",
      removed: false,
    });
    expect(() => decodeUninstallInput({ agentId: "../example-agent" })).toThrow();
  });
});
