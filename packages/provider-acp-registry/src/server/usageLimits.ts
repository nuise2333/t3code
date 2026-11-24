import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

// Visible ASCII only: tokens go into a header, and a fetch error echoes header values.
const HeaderSafe = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/));
const decodeHeaderSafe = Schema.decodeUnknownOption(HeaderSafe);

const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_CODE_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CODE_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KimiCodeToken = Schema.Struct({
  access_token: HeaderSafe,
  refresh_token: Schema.String,
  expires_at: Schema.Number,
  scope: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});
const decodeKimiCodeToken = Schema.decodeEffect(Schema.fromJsonString(KimiCodeToken));
const encodeKimiCodeToken = Schema.encodeEffect(Schema.fromJsonString(KimiCodeToken));
const KimiCodeRefresh = Schema.Struct({
  access_token: HeaderSafe,
  refresh_token: Schema.optional(Schema.NonEmptyString),
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
  scope: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
});
const KimiCodeWindow = Schema.Struct({
  used_ratio: Schema.Number,
  reset_time: Schema.optional(Schema.String),
});
const KimiCodeUsages = Schema.Struct({
  usages: Schema.Struct({
    limit_5h: Schema.optional(KimiCodeWindow),
    limit_7d: Schema.optional(KimiCodeWindow),
  }),
});

function iso(value: string | undefined) {
  const parsed = value ? DateTime.make(value) : Option.none();
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

function usageWindow(
  id: string,
  label: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
  resetsAt: string | undefined,
  windowDurationMins: number | undefined,
): ServerProviderUsageWindow {
  return {
    id,
    label,
    kind,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

export function kimiCodeUsageToWindows(response: typeof KimiCodeUsages.Type) {
  const { limit_5h: fiveHour, limit_7d: weekly } = response.usages;
  return [
    ...(fiveHour
      ? [
          usageWindow(
            "five-hour",
            "5-hour",
            "session",
            fiveHour.used_ratio * 100,
            iso(fiveHour.reset_time),
            300,
          ),
        ]
      : []),
    ...(weekly
      ? [
          usageWindow(
            "weekly",
            "Weekly",
            "weekly",
            weekly.used_ratio * 100,
            iso(weekly.reset_time),
            7 * 24 * 60,
          ),
        ]
      : []),
  ];
}

/**
 * Kimi Code's managed plan limits. Its CLI keeps a 15-minute token whose refresh rotates the
 * refresh token, so a refresh here is written back the way the CLI writes it (temp file, rename).
 */
export const readKimiCodeUsageLimits = Effect.fn("readKimiCodeUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  // Custom hosts belong to other deployments; their tokens must not reach Kimi's public API.
  if (environment.KIMI_CODE_BASE_URL?.trim() || environment.KIMI_CODE_OAUTH_HOST?.trim()) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const home =
    environment.KIMI_CODE_HOME?.trim() ||
    path.join(environment.HOME || (yield* HostProcess.HomeDirectory), ".kimi-code");
  const tokenPath = path.join(home, "credentials", "kimi-code.json");
  const readToken = fs.readFileString(tokenPath).pipe(Effect.flatMap(decodeKimiCodeToken));
  if (!(yield* fs.exists(tokenPath))) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Sign in to Kimi Code to see its limits.",
    });
  }
  let token = yield* readToken;
  if (token.expires_at * 1000 <= (yield* Clock.currentTimeMillis) + 60_000) {
    const refreshed = yield* http
      .execute(
        HttpClientRequest.post(KIMI_CODE_TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: KIMI_CODE_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: token.refresh_token,
          }),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(KimiCodeRefresh)), Effect.option);
    if (Option.isNone(refreshed)) {
      // The CLI may have refreshed first and rotated the refresh token; its saved token wins.
      const current = yield* readToken;
      if (current.refresh_token === token.refresh_token) {
        return makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "Kimi Code's sign-in has expired. Sign in to Kimi Code again.",
        });
      }
      token = current;
    } else {
      const next = {
        access_token: refreshed.value.access_token,
        refresh_token: refreshed.value.refresh_token ?? token.refresh_token,
        expires_at: (yield* Clock.currentTimeMillis) / 1000 + refreshed.value.expires_in,
        scope: refreshed.value.scope ?? token.scope,
        token_type: refreshed.value.token_type ?? token.token_type ?? "Bearer",
        expires_in: refreshed.value.expires_in,
      };
      const tempPath = `${tokenPath}.tmp.${process.pid}.${(yield* Random.nextInt).toString(16)}`;
      yield* fs.writeFileString(tempPath, yield* encodeKimiCodeToken(next), { mode: 0o600 });
      yield* fs.rename(tempPath, tokenPath);
      token = next;
    }
  }
  const response = yield* http
    .execute(
      HttpClientRequest.get(KIMI_CODE_USAGE_URL).pipe(
        HttpClientRequest.bearerToken(token.access_token),
      ),
    )
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(KimiCodeUsages)));
  return makeUsageLimits({ checkedAt, windows: kimiCodeUsageToWindows(response) });
});

const ZhipuQuotaLimit = Schema.Struct({
  type: Schema.String,
  unit: Schema.optional(Schema.Number),
  number: Schema.optional(Schema.Number),
  percentage: Schema.optional(Schema.Number),
  nextResetTime: Schema.optional(Schema.Number),
});
const ZhipuQuotaResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.optional(Schema.Struct({ limits: Schema.Array(ZhipuQuotaLimit) })),
});
// Zhipu's quota units, as ZCode reads them: 3 hours, 4 days, 5 months, 6 weeks.
const ZHIPU_UNIT_MINUTES = new Map([
  [3, 60],
  [4, 24 * 60],
  [6, 7 * 24 * 60],
]);

export function zhipuQuotaToWindows(limits: ReadonlyArray<typeof ZhipuQuotaLimit.Type>) {
  return limits.flatMap((limit): ServerProviderUsageWindow[] => {
    if (limit.percentage === undefined || !Number.isFinite(limit.percentage)) return [];
    const unitMinutes = limit.unit === undefined ? undefined : ZHIPU_UNIT_MINUTES.get(limit.unit);
    const duration = unitMinutes === undefined ? undefined : unitMinutes * (limit.number ?? 1);
    const monthly = limit.unit === 5;
    const span =
      duration === 300
        ? "5-hour"
        : duration === 7 * 24 * 60
          ? "Weekly"
          : monthly
            ? "Monthly"
            : duration === undefined
              ? undefined
              : `${Math.round(duration / 60)}-hour`;
    const tools = limit.type === "TIME_LIMIT";
    const label = [tools ? "Tool calls" : undefined, span].filter(Boolean).join(" · ") || "Quota";
    const resetsAt =
      limit.nextResetTime === undefined
        ? undefined
        : DateTime.formatIso(DateTime.makeUnsafe(limit.nextResetTime));
    return [
      usageWindow(
        `${limit.type}:${limit.unit ?? ""}:${limit.number ?? ""}`,
        label,
        monthly ? "monthly" : duration === 7 * 24 * 60 ? "weekly" : duration ? "session" : "other",
        limit.percentage,
        resetsAt,
        duration,
      ),
    ];
  });
}

/** ZCode's GLM Coding Plan limits, read with the API key set on the ZCode provider. */
export const readZCodeUsageLimits = Effect.fn("readZCodeUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const apiKey = decodeHeaderSafe(environment.ZCODE_ACP_API_KEY?.trim());
  if (Option.isNone(apiKey)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Set ZCODE_ACP_API_KEY on the ZCode provider to see Coding Plan limits.",
    });
  }
  const template = environment.ZCODE_ACP_TEMPLATE?.trim() || "bigmodel-api";
  const host = template.startsWith("zai") ? "https://api.z.ai" : "https://open.bigmodel.cn";
  const response = yield* (yield* HttpClient.HttpClient)
    .pipe(HttpClient.filterStatusOk)
    .execute(
      HttpClientRequest.get(`${host}/api/monitor/usage/quota/limit`).pipe(
        HttpClientRequest.setHeaders({ Authorization: apiKey.value }),
      ),
    )
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ZhipuQuotaResponse)));
  if (response.code !== 200 && response.code !== 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "The Coding Plan quota service rejected the ZCode API key.",
    });
  }
  return makeUsageLimits({ checkedAt, windows: zhipuQuotaToWindows(response.data?.limits ?? []) });
});

/** The limits reader for an ACP Registry agent that reports them, if any. */
export function acpRegistryUsageReader(
  agentId: string | undefined,
): ((environment: NodeJS.ProcessEnv) => ReturnType<typeof readKimiCodeUsageLimits>) | undefined {
  if (agentId === "kimi-code") return readKimiCodeUsageLimits;
  if (agentId === "zcode-acp.mjs") return readZCodeUsageLimits;
  return undefined;
}
