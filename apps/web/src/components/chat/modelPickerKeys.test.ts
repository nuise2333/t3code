import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
  modelPickerTeamKey,
  parseModelPickerTeamKey,
  type ModelPickerTeamRow,
} from "./modelPickerKeys";

describe("model picker item keys", () => {
  it("keeps model and legacy section keys distinct for colliding instance names", () => {
    const modelKey = modelPickerModelKey(ProviderInstanceId.make("legacy-models"), "codex");
    const sectionKey = modelPickerLegacySectionKey(ProviderInstanceId.make("codex"));

    expect(modelKey).not.toBe(sectionKey);
    expect(parseModelPickerLegacySectionKey(modelKey)).toBeNull();
    expect(parseModelPickerModelKey(modelKey)).toEqual({
      instanceId: "legacy-models",
      slug: "codex",
    });
  });

  it("round-trips arbitrary strings without throwing", () => {
    const instanceId = ProviderInstanceId.make("custom");
    const slug = "model:\udfff";

    const key = modelPickerModelKey(instanceId, slug);

    expect(parseModelPickerModelKey(key)).toEqual({ instanceId, slug });
  });

  it("round-trips Team tab rows and keeps them apart from models", () => {
    const rows: ReadonlyArray<ModelPickerTeamRow> = [
      { kind: "none" },
      { kind: "auto", auto: "balanced" },
      { kind: "saved", id: "auto:not-an-auto" },
    ];
    for (const row of rows) {
      const key = modelPickerTeamKey(row);
      expect(parseModelPickerTeamKey(key)).toEqual(row);
      expect(parseModelPickerModelKey(key)).toBeNull();
    }
    expect(parseModelPickerTeamKey("team:auto:pricey")).toBeNull();
    expect(
      parseModelPickerTeamKey(modelPickerModelKey(ProviderInstanceId.make("team"), "none")),
    ).toBeNull();
  });
});
