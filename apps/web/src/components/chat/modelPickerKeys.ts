import { AUTO_TEAMS, type AutoTeamKind, type ProviderInstanceId } from "@t3tools/contracts";

const MODEL_KEY_PREFIX = "model:";
const LEGACY_SECTION_KEY_PREFIX = "legacy-models:";

export function modelPickerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${MODEL_KEY_PREFIX}${instanceId.length}:${instanceId}${slug}`;
}

export function parseModelPickerModelKey(
  key: string,
): { instanceId: ProviderInstanceId; slug: string } | null {
  if (!key.startsWith(MODEL_KEY_PREFIX)) {
    return null;
  }
  const encoded = key.slice(MODEL_KEY_PREFIX.length);
  const separatorIndex = encoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const instanceIdLengthText = encoded.slice(0, separatorIndex);
  if (!/^\d+$/.test(instanceIdLengthText)) {
    return null;
  }

  const instanceIdLength = Number(instanceIdLengthText);
  const value = encoded.slice(separatorIndex + 1);
  if (!Number.isSafeInteger(instanceIdLength) || instanceIdLength > value.length) {
    return null;
  }

  return {
    instanceId: value.slice(0, instanceIdLength) as ProviderInstanceId,
    slug: value.slice(instanceIdLength),
  };
}

export function modelPickerLegacySectionKey(instanceId: ProviderInstanceId): string {
  return `${LEGACY_SECTION_KEY_PREFIX}${instanceId}`;
}

export function parseModelPickerLegacySectionKey(key: string): ProviderInstanceId | null {
  return key.startsWith(LEGACY_SECTION_KEY_PREFIX)
    ? (key.slice(LEGACY_SECTION_KEY_PREFIX.length) as ProviderInstanceId)
    : null;
}

const ROUTING_GROUP_KEY_PREFIX = "routing-group:";

export function modelPickerRoutingGroupKey(groupId: string): string {
  return `${ROUTING_GROUP_KEY_PREFIX}${groupId}`;
}

export function parseModelPickerRoutingGroupKey(key: string): string | null {
  return key.startsWith(ROUTING_GROUP_KEY_PREFIX)
    ? key.slice(ROUTING_GROUP_KEY_PREFIX.length)
    : null;
}

const TEAM_KEY_PREFIX = "team:";

/** A row of the Team tab: no team, an automatic team, a saved team, or the setup. */
export type ModelPickerTeamRow =
  | { readonly kind: "none" }
  | { readonly kind: "auto"; readonly auto: AutoTeamKind }
  | { readonly kind: "saved"; readonly id: string }
  | { readonly kind: "setup" };

export function modelPickerTeamKey(row: ModelPickerTeamRow): string {
  switch (row.kind) {
    case "none":
    case "setup":
      return `${TEAM_KEY_PREFIX}${row.kind}`;
    case "auto":
      return `${TEAM_KEY_PREFIX}auto:${row.auto}`;
    case "saved":
      return `${TEAM_KEY_PREFIX}saved:${row.id}`;
  }
}

export function parseModelPickerTeamKey(key: string): ModelPickerTeamRow | null {
  if (!key.startsWith(TEAM_KEY_PREFIX)) return null;
  const rest = key.slice(TEAM_KEY_PREFIX.length);
  if (rest === "none" || rest === "setup") return { kind: rest };
  if (rest.startsWith("saved:")) return { kind: "saved", id: rest.slice("saved:".length) };
  if (rest.startsWith("auto:")) {
    const auto = AUTO_TEAMS.find((team) => team.kind === rest.slice("auto:".length))?.kind;
    return auto ? { kind: "auto", auto } : null;
  }
  return null;
}
