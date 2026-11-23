import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const AcpRegistryAgentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);

const ACP_REGISTRY_CDN_HOSTNAME = "cdn.agentclientprotocol.com";
const ACP_REGISTRY_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function officialAcpRegistryIconUrlForAgentId(
  agentId: string | null | undefined,
): string | null {
  if (agentId === null || agentId === undefined || !ACP_REGISTRY_AGENT_ID_PATTERN.test(agentId)) {
    return null;
  }
  return `https://${ACP_REGISTRY_CDN_HOSTNAME}/registry/v1/latest/${agentId}.svg`;
}

// Local ACP commands have no Registry entry, and some Registry entries carry a generic glyph in
// place of the vendor's mark. Well-known agents ship their own mark here, and snapshots carry a
// short reference so the 2 KiB `iconUrl` wire limit and older clients hold. `fullColor` marks
// render as-is; every other icon is recolored to the surrounding text color.
const BUNDLED_ACP_ICON_SCHEME = "t3-acp-icon:";
const BUNDLED_ACP_AGENT_ICONS = {
  // DeepSeek Harness favicon (deepseek-ai/deepseek-harness, MIT), coordinates rounded to 0.1.
  "deepseek-harness": {
    commands: ["dsh"],
    svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 50 50'><path d='M48.8 10C48.3 9.8 48.1 10.3 47.8 10.5C47.7 10.6 47.6 10.7 47.5 10.8C46.8 11.6 45.9 12.2 44.8 12.1C43.1 12 41.7 12.5 40.4 13.8C40.1 12.2 39.2 11.3 37.9 10.7C37.2 10.3 36.5 10 36 9.3C35.6 8.8 35.5 8.3 35.4 7.7C35.2 7.4 35.1 7.1 34.8 7C34.4 6.9 34.2 7.3 34 7.6C33.4 8.8 33.2 10 33.2 11.4C33.3 14.3 34.5 16.7 36.9 18.3C37.2 18.5 37.2 18.7 37.2 19C37 19.6 36.8 20.1 36.6 20.7C36.5 21.1 36.3 21.2 36 21C34.6 20.4 33.5 19.6 32.5 18.6C30.7 16.9 29.2 15 27.2 13.5C26.8 13.2 26.3 12.9 25.8 12.6C23.9 10.6 26.1 9 26.6 8.8C27.2 8.6 26.8 7.9 25.1 7.9C23.3 7.9 21.7 8.5 19.6 9.3C19.3 9.4 19 9.5 18.7 9.6C16.9 9.2 14.9 9.1 12.9 9.4C9.1 9.8 6.1 11.6 3.8 14.8C1.2 18.5.5 22.8 1.3 27.3C2.1 32 4.5 35.8 8.1 38.9C11.8 42 16.1 43.6 21 43.3C24 43.1 27.4 42.7 31.1 39.5C32 39.9 33 40.1 34.7 40.3C36 40.4 37.2 40.2 38.1 40C39.6 39.7 39.5 38.3 39 38C34.6 36 35.6 36.8 34.7 36.1C36.9 33.5 40.2 30.7 41.5 21.7C41.6 21 41.6 20.6 41.5 20C41.5 19.6 41.6 19.5 42 19.5C43.1 19.3 44.1 19 45.1 18.5C47.9 16.9 49.1 14.3 49.3 11.3C49.4 10.8 49.3 10.3 48.8 10ZM24.3 37.8C20.1 34.5 18.1 33.4 17.2 33.4C16.4 33.4 16.6 34.4 16.8 35C16.9 35.6 17.2 36 17.5 36.5C17.7 36.8 17.9 37.3 17.3 37.7C15.9 38.6 13.6 37.4 13.5 37.4C10.7 35.7 8.4 33.6 6.8 30.6C5.3 27.7 4.3 24.6 4.2 21.4C4.2 20.6 4.4 20.3 5.2 20.2C6.2 20 7.2 19.9 8.2 20.1C12.5 20.7 16.2 22.7 19.3 25.8C21 27.5 22.3 29.7 23.7 31.7C25.1 33.9 26.7 36 28.7 37.7C29.4 38.3 29.9 38.8 30.5 39.1C28.9 39.3 26.2 39.3 24.3 37.8ZM26.3 24.6C26.3 24.2 26.6 24 27 24C27 24 27.1 24 27.2 24C27.3 24 27.3 24.1 27.4 24.2C27.5 24.3 27.6 24.4 27.6 24.6C27.6 25 27.3 25.2 27 25.2C26.6 25.2 26.3 25 26.3 24.6ZM32.6 27.9C32.2 28 31.8 28.2 31.4 28.2C30.8 28.2 30.2 28 29.8 27.7C29.3 27.2 28.9 27 28.7 26.1C28.6 25.8 28.7 25.2 28.7 24.9C28.9 24.2 28.7 23.8 28.2 23.4C27.9 23.1 27.4 23 26.9 23C26.7 23 26.5 22.9 26.4 22.9C26.1 22.7 25.9 22.5 26.1 22.1C26.2 22 26.4 21.7 26.5 21.7C27.2 21.3 28.1 21.4 28.8 21.7C29.5 22 30.1 22.6 30.8 23.3C31.6 24.3 31.8 24.5 32.2 25.2C32.6 25.8 32.9 26.3 33.1 27C33.2 27.4 33.1 27.7 32.6 27.9Z'/></svg>",
  },
  // Kimi app mark (Moonshot AI), traced from the Kimi Code VS Code extension icon.
  "kimi-code": {
    commands: ["kimi"],
    agentIds: ["kimi-code", "kimi"],
    fullColor: true,
    svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><rect width='128' height='128' rx='28'/><path fill='#fff' d='M37 35h10.5v27L75 35h16L64 62l24 16q3 1.5 3 3.5V90q-9 0-17-8L57 70l-9.5 9.5V90H37z'/><circle cx='101.5' cy='29' r='6.8' fill='#1783FF'/></svg>",
  },
  // ZCode app icon (Zhipu AI), traced from the 1024px icon.png in ZCode.app.
  zcode: {
    commands: ["zcode"],
    fullColor: true,
    svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='96 96 832 832'><rect x='96' y='96' width='832' height='832' rx='186'/><path fill='#fff' d='M268.5 294.5h255l-45 64h-210zM563 294.5h203.5l-306 434H257zM545.5 665.5h209v63H501z'/></svg>",
  },
} as const satisfies Record<
  string,
  {
    readonly commands: ReadonlyArray<string>;
    readonly agentIds?: ReadonlyArray<string>;
    readonly fullColor?: boolean;
    readonly svg: string;
  }
>;

const BUNDLED_ACP_ICON_DATA_URLS: ReadonlyMap<string, string> = new Map(
  Object.entries(BUNDLED_ACP_AGENT_ICONS).map(([id, icon]) => [
    `${BUNDLED_ACP_ICON_SCHEME}${id}`,
    `data:image/svg+xml,${encodeURIComponent(icon.svg)}`,
  ]),
);
const BUNDLED_ACP_DATA_URLS: ReadonlySet<string> = new Set(BUNDLED_ACP_ICON_DATA_URLS.values());
const FULL_COLOR_BUNDLED_ACP_DATA_URLS: ReadonlySet<string> = new Set(
  Object.entries(BUNDLED_ACP_AGENT_ICONS).flatMap(([id, icon]) => {
    const dataUrl = BUNDLED_ACP_ICON_DATA_URLS.get(`${BUNDLED_ACP_ICON_SCHEME}${id}`);
    return "fullColor" in icon && icon.fullColor && dataUrl ? [dataUrl] : [];
  }),
);

/** The bundled icon reference that replaces a Registry agent's own icon, if any. */
export function bundledAcpIconUrlForAgentId(agentId: string | null | undefined): string | null {
  const id = agentId?.trim();
  if (!id) return null;
  const match = Object.entries(BUNDLED_ACP_AGENT_ICONS).find(
    ([, icon]) => "agentIds" in icon && (icon.agentIds as ReadonlyArray<string>).includes(id),
  );
  return match ? `${BUNDLED_ACP_ICON_SCHEME}${match[0]}` : null;
}

/** A bundled icon's SVG source, for clients that draw SVG themselves instead of loading a URL. */
export function bundledAcpIconSvg(
  icon: string | null | undefined,
): { readonly svg: string; readonly fullColor: boolean } | null {
  if (!icon) return null;
  const match = Object.entries(BUNDLED_ACP_AGENT_ICONS).find(
    ([id]) =>
      icon === `${BUNDLED_ACP_ICON_SCHEME}${id}` ||
      icon === BUNDLED_ACP_ICON_DATA_URLS.get(`${BUNDLED_ACP_ICON_SCHEME}${id}`),
  );
  if (!match) return null;
  const [, entry] = match;
  return { svg: entry.svg, fullColor: "fullColor" in entry && entry.fullColor === true };
}

/** Whether a resolved icon URL is a multi-color mark that must not be recolored. */
export function isFullColorAcpIconUrl(iconUrl: string | null | undefined): boolean {
  return iconUrl !== null && iconUrl !== undefined && FULL_COLOR_BUNDLED_ACP_DATA_URLS.has(iconUrl);
}

/** The bundled icon reference for a local ACP command's executable, matched by file name. */
export function bundledAcpIconUrlForCommand(commandPath: string | null | undefined): string | null {
  const executable = commandPath
    ?.trim()
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|cmd)$/i, "")
    .toLowerCase();
  if (!executable) return null;
  const match = Object.entries(BUNDLED_ACP_AGENT_ICONS).find(([, icon]) =>
    (icon.commands as ReadonlyArray<string>).includes(executable),
  );
  return match ? `${BUNDLED_ACP_ICON_SCHEME}${match[0]}` : null;
}

/** A loadable icon URL: an official Registry CDN URL, or a bundled icon's data URL. */
export function resolveOfficialAcpRegistryIconUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  if (icon.startsWith(BUNDLED_ACP_ICON_SCHEME)) return BUNDLED_ACP_ICON_DATA_URLS.get(icon) ?? null;
  if (BUNDLED_ACP_DATA_URLS.has(icon)) return icon;
  try {
    const url = new URL(icon);
    if (
      url.protocol !== "https:" ||
      url.hostname !== ACP_REGISTRY_CDN_HOSTNAME ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export const AcpRegistryDistribution = Schema.Literals(["binary", "npx", "uvx"]);
export type AcpRegistryDistribution = typeof AcpRegistryDistribution.Type;

export const AcpRegistryIntegrity = Schema.Literals(["sha256", "registry"]);
export type AcpRegistryIntegrity = typeof AcpRegistryIntegrity.Type;

export const ACP_REGISTRY_MAX_AGENTS = 512;
export const ACP_REGISTRY_SEARCH_QUERY_MAX_LENGTH = 120;

export const AcpRegistrySearchInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMaxLength(ACP_REGISTRY_SEARCH_QUERY_MAX_LENGTH)),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: ACP_REGISTRY_MAX_AGENTS })),
  ),
});
export type AcpRegistrySearchInput = typeof AcpRegistrySearchInput.Type;

const AcpRegistryUrl = Schema.String.check(Schema.isMaxLength(2_048));

export const AcpRegistrySearchAgent = Schema.Struct({
  id: AcpRegistryAgentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  description: Schema.String.check(Schema.isMaxLength(1_024)),
  authors: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(16)),
  license: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  website: Schema.NullOr(AcpRegistryUrl),
  repository: Schema.NullOr(AcpRegistryUrl),
  icon: Schema.NullOr(AcpRegistryUrl),
  distribution: AcpRegistryDistribution,
  integrity: AcpRegistryIntegrity,
});
export type AcpRegistrySearchAgent = typeof AcpRegistrySearchAgent.Type;

export const AcpRegistrySearchResult = Schema.Struct({
  agents: Schema.Array(AcpRegistrySearchAgent).check(Schema.isMaxLength(ACP_REGISTRY_MAX_AGENTS)),
});
export type AcpRegistrySearchResult = typeof AcpRegistrySearchResult.Type;

export const AcpRegistryPrepareInput = Schema.Struct({
  agentId: AcpRegistryAgentId,
});
export type AcpRegistryPrepareInput = typeof AcpRegistryPrepareInput.Type;

export const AcpRegistryPrepareResult = Schema.Struct({
  agentId: AcpRegistryAgentId,
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  distribution: AcpRegistryDistribution,
  prepared: Schema.Literal(true),
});
export type AcpRegistryPrepareResult = typeof AcpRegistryPrepareResult.Type;

export const AcpRegistryManagedBinaryUninstallInput = Schema.Struct({
  agentId: AcpRegistryAgentId,
});
export type AcpRegistryManagedBinaryUninstallInput =
  typeof AcpRegistryManagedBinaryUninstallInput.Type;

export const AcpRegistryManagedBinaryUninstallResult = Schema.Struct({
  agentId: AcpRegistryAgentId,
  removed: Schema.Boolean,
});
export type AcpRegistryManagedBinaryUninstallResult =
  typeof AcpRegistryManagedBinaryUninstallResult.Type;

const AcpRegistryProbeText = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const AcpRegistryProbeDescription = Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024)));

export const AcpRegistryProbeAuthMethod = Schema.Struct({
  id: AcpRegistryProbeText,
  name: AcpRegistryProbeText,
  description: AcpRegistryProbeDescription,
  type: Schema.Literals(["agent", "env_var", "terminal"]),
  command: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
  envVarNames: Schema.optionalKey(Schema.Array(AcpRegistryProbeText).check(Schema.isMaxLength(16))),
  link: Schema.optionalKey(AcpRegistryUrl),
});
export type AcpRegistryProbeAuthMethod = typeof AcpRegistryProbeAuthMethod.Type;

export const AcpRegistryUrlAuthAction = Schema.Struct({
  elicitationId: AcpRegistryProbeText,
  url: AcpRegistryUrl,
  message: Schema.String.check(Schema.isMaxLength(1_024)),
  createdAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  expiresAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
export type AcpRegistryUrlAuthAction = typeof AcpRegistryUrlAuthAction.Type;

export const AcpRegistryAcceptUrlAuthInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  elicitationId: AcpRegistryProbeText,
});
export type AcpRegistryAcceptUrlAuthInput = typeof AcpRegistryAcceptUrlAuthInput.Type;

export const AcpRegistryAcceptUrlAuthResult = Schema.Struct({
  accepted: Schema.Boolean,
});
export type AcpRegistryAcceptUrlAuthResult = typeof AcpRegistryAcceptUrlAuthResult.Type;

const AcpRegistrySessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));
const AcpRegistrySessionPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));

export const AcpRegistrySession = Schema.Struct({
  sessionId: AcpRegistrySessionId,
  cwd: AcpRegistrySessionPath,
  additionalDirectories: Schema.Array(AcpRegistrySessionPath).check(Schema.isMaxLength(32)),
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  updatedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  importedThreadId: Schema.NullOr(ThreadId),
  /** The imported thread still lacks the session's history, so importing again copies it. */
  nativeHistoryPending: Schema.optionalKey(Schema.Boolean),
});
export type AcpRegistrySession = typeof AcpRegistrySession.Type;

export const AcpRegistryListSessionsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type AcpRegistryListSessionsInput = typeof AcpRegistryListSessionsInput.Type;

export const AcpRegistryListSessionsResult = Schema.Struct({
  sessions: Schema.Array(AcpRegistrySession).check(Schema.isMaxLength(256)),
  nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  canLoad: Schema.Boolean,
  canResume: Schema.Boolean,
  canDelete: Schema.Boolean,
});
export type AcpRegistryListSessionsResult = typeof AcpRegistryListSessionsResult.Type;

export const AcpRegistryImportSessionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  sessionId: AcpRegistrySessionId,
  title: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)))),
  updatedAt: Schema.optionalKey(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  ),
});
export type AcpRegistryImportSessionInput = typeof AcpRegistryImportSessionInput.Type;

export const AcpRegistryImportSessionResult = Schema.Struct({
  threadId: ThreadId,
  imported: Schema.Boolean,
});
export type AcpRegistryImportSessionResult = typeof AcpRegistryImportSessionResult.Type;

export const AcpRegistryDeleteSessionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  sessionId: AcpRegistrySessionId,
});
export type AcpRegistryDeleteSessionInput = typeof AcpRegistryDeleteSessionInput.Type;

export const AcpRegistryDeleteSessionResult = Schema.Struct({ deleted: Schema.Literal(true) });
export type AcpRegistryDeleteSessionResult = typeof AcpRegistryDeleteSessionResult.Type;

const AcpRegistryProviderId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const AcpRegistryProviderProtocol = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const AcpRegistryConfigurableProvider = Schema.Struct({
  providerId: AcpRegistryProviderId,
  supported: Schema.Array(AcpRegistryProviderProtocol).check(Schema.isMaxLength(16)),
  required: Schema.Boolean,
  current: Schema.NullOr(
    Schema.Struct({
      apiType: AcpRegistryProviderProtocol,
      baseUrl: AcpRegistryUrl,
    }),
  ),
});
export type AcpRegistryConfigurableProvider = typeof AcpRegistryConfigurableProvider.Type;

export const AcpRegistryListProvidersInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
});
export type AcpRegistryListProvidersInput = typeof AcpRegistryListProvidersInput.Type;

export const AcpRegistryListProvidersResult = Schema.Struct({
  providers: Schema.Array(AcpRegistryConfigurableProvider).check(Schema.isMaxLength(64)),
});
export type AcpRegistryListProvidersResult = typeof AcpRegistryListProvidersResult.Type;

export const AcpRegistrySetProviderInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  providerId: AcpRegistryProviderId,
  apiType: AcpRegistryProviderProtocol,
  baseUrl: AcpRegistryUrl,
  // Write-only secrets. Provider list responses intentionally cannot carry headers.
  headers: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      Schema.String.check(Schema.isMaxLength(8_192)),
    ),
  ),
});
export type AcpRegistrySetProviderInput = typeof AcpRegistrySetProviderInput.Type;

export const AcpRegistrySetProviderResult = Schema.Struct({ configured: Schema.Literal(true) });
export type AcpRegistrySetProviderResult = typeof AcpRegistrySetProviderResult.Type;

export const AcpRegistryDisableProviderInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  providerId: AcpRegistryProviderId,
});
export type AcpRegistryDisableProviderInput = typeof AcpRegistryDisableProviderInput.Type;

export const AcpRegistryDisableProviderResult = Schema.Struct({ disabled: Schema.Literal(true) });
export type AcpRegistryDisableProviderResult = typeof AcpRegistryDisableProviderResult.Type;

export const AcpRegistryLogoutInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type AcpRegistryLogoutInput = typeof AcpRegistryLogoutInput.Type;

export const AcpRegistryLogoutResult = Schema.Struct({
  loggedOut: Schema.Literal(true),
});
export type AcpRegistryLogoutResult = typeof AcpRegistryLogoutResult.Type;

export const AcpRegistryProbeModel = Schema.Struct({
  id: AcpRegistryProbeText,
  name: AcpRegistryProbeText,
  description: AcpRegistryProbeDescription,
  // The reasoning control the agent advertises for this model; null when it has none.
  reasoningEffort: Schema.optionalKey(Schema.NullOr(ProviderOptionDescriptor)),
});
export type AcpRegistryProbeModel = typeof AcpRegistryProbeModel.Type;

export const AcpRegistryProbeResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  // `ready` requires a disposable ACP session/new probe, not passive auth detection.
  ready: Schema.Literal(true),
  icon: Schema.NullOr(AcpRegistryUrl),
  authMethods: Schema.Array(AcpRegistryProbeAuthMethod).check(Schema.isMaxLength(32)),
  models: Schema.Array(AcpRegistryProbeModel).check(Schema.isMaxLength(256)),
  currentModelId: Schema.NullOr(AcpRegistryProbeText),
  configOptions: Schema.Array(ProviderOptionDescriptor).check(Schema.isMaxLength(16)),
  // configOptions ids that describe only the current model (ACP thought_level / model_config).
  modelOptionIds: Schema.optionalKey(
    Schema.Array(AcpRegistryProbeText).check(Schema.isMaxLength(16)),
  ),
  sessionManagement: Schema.Struct({
    canList: Schema.Boolean,
    canLoad: Schema.Boolean,
    canResume: Schema.Boolean,
    canLogout: Schema.Boolean,
    canDelete: Schema.Boolean,
    canConfigureProviders: Schema.Boolean,
  }).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        canList: false,
        canLoad: false,
        canResume: false,
        canLogout: false,
        canDelete: false,
        canConfigureProviders: false,
      }),
    ),
  ),
});
export type AcpRegistryProbeResult = typeof AcpRegistryProbeResult.Type;

export const AcpRegistryOperationErrorReason = Schema.Literals([
  "agent_not_configured",
  "agent_not_found",
  "archive_invalid",
  "authentication_failed",
  "checksum_mismatch",
  "download_failed",
  "install_failed",
  "instance_not_found",
  "logout_unsupported",
  "logout_failed",
  "probe_failed",
  "project_not_found",
  "registry_unavailable",
  "runner_unavailable",
  "session_import_failed",
  "session_delete_unsupported",
  "session_delete_failed",
  "session_list_unsupported",
  "session_resume_unsupported",
  "providers_unsupported",
  "providers_list_failed",
  "provider_configuration_failed",
  "unsupported_distribution",
  "unsupported_platform",
]);
export type AcpRegistryOperationErrorReason = typeof AcpRegistryOperationErrorReason.Type;

export class AcpRegistryOperationError extends Schema.TaggedError<AcpRegistryOperationError>()(
  "AcpRegistryOperationError",
  {
    reason: AcpRegistryOperationErrorReason,
    message: Schema.String,
    authMethods: Schema.optionalKey(
      Schema.Array(AcpRegistryProbeAuthMethod).check(Schema.isMaxLength(32)),
    ),
    authAction: Schema.optionalKey(AcpRegistryUrlAuthAction),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
