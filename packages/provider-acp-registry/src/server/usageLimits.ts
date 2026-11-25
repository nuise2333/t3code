import type { AcpRegistrySettings } from "../settings.ts";
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
import * as Yaml from "effect/encoding/Yaml";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Visible ASCII only: tokens go into a header, and a fetch error echoes header values.
const HeaderSafe = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/));
const decodeHeaderSafe = Schema.decodeUnknownOption(HeaderSafe);
// Fetch would replay a credential-bearing request to a redirect's target.
const withoutRedirects = Effect.provideService(FetchHttpClient.RequestInit, {
  redirect: "manual",
} satisfies RequestInit);

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
    const spent = token.refresh_token;
    // A refresh spends the old refresh token, so the request and the write-back finish together
    // even when the probe times out; otherwise the CLI would be left holding a dead token.
    const rotated = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const refreshed = yield* http
          .execute(
            HttpClientRequest.post(KIMI_CODE_TOKEN_URL).pipe(
              HttpClientRequest.bodyUrlParams({
                client_id: KIMI_CODE_CLIENT_ID,
                grant_type: "refresh_token",
                refresh_token: spent,
              }),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(KimiCodeRefresh)),
            withoutRedirects,
            Effect.timeout("15 seconds"),
            Effect.option,
          );
        const current = yield* readToken;
        // The CLI's saved token wins whenever it changed meanwhile: a refresh it won, or a new sign-in.
        if (current.refresh_token !== spent) return Option.some(current);
        if (Option.isNone(refreshed)) return Option.none();
        const next = {
          access_token: refreshed.value.access_token,
          refresh_token: refreshed.value.refresh_token ?? spent,
          expires_at: (yield* Clock.currentTimeMillis) / 1000 + refreshed.value.expires_in,
          scope: refreshed.value.scope ?? current.scope,
          token_type: refreshed.value.token_type ?? current.token_type ?? "Bearer",
          expires_in: refreshed.value.expires_in,
        };
        const tempPath = `${tokenPath}.tmp.${process.pid}.${(yield* Random.nextInt).toString(16)}`;
        yield* fs
          .writeFileString(tempPath, yield* encodeKimiCodeToken(next), { mode: 0o600, flag: "wx" })
          .pipe(
            Effect.andThen(fs.rename(tempPath, tokenPath)),
            Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignore)),
          );
        return Option.some(next);
      }),
    );
    if (Option.isNone(rotated)) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        // A timeout or outage looks the same as a rejected token here; never claim the sign-in is gone.
        message:
          "Could not refresh Kimi Code's sign-in. Refresh provider status to retry, or sign in to Kimi Code again.",
      });
    }
    token = rotated.value;
  }
  const response = yield* http
    .execute(
      HttpClientRequest.get(KIMI_CODE_USAGE_URL).pipe(
        HttpClientRequest.bearerToken(token.access_token),
      ),
    )
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(KimiCodeUsages)), withoutRedirects);
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
  // A custom endpoint's key belongs to that endpoint; never send it to Zhipu's public hosts.
  if (environment.ZCODE_ACP_BASE_URL?.trim()) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
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
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ZhipuQuotaResponse)), withoutRedirects);
  if (response.code !== 200 && response.code !== 0) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "The Coding Plan quota service rejected the ZCode API key.",
    });
  }
  return makeUsageLimits({ checkedAt, windows: zhipuQuotaToWindows(response.data?.limits ?? []) });
});

const TokenPlanUsage = Schema.Record(Schema.String, Schema.Unknown);
const QwenSettings = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  providerMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeQwenSettings = Schema.decodeEffect(Schema.fromJsonString(QwenSettings));
const BL_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;
const decodeTokenPlanUsage = Schema.decodeEffect(Schema.fromJsonString(TokenPlanUsage));
const TOKEN_PLAN_WINDOW = /^per(\d+)(Hour|Day|Week|Month)Percentage$/;
const TOKEN_PLAN_UNIT_MINUTES = { Hour: 60, Day: 24 * 60, Week: 7 * 24 * 60 } as const;

/** Windows from `bl usage token-plan --output json`: `per<n><Unit>Percentage` is a used fraction. */
export function tokenPlanUsageToWindows(usage: Readonly<Record<string, unknown>>) {
  return Object.entries(usage).flatMap(([key, value]): ServerProviderUsageWindow[] => {
    const match = TOKEN_PLAN_WINDOW.exec(key);
    // A used fraction outside 0..1 means bl changed its format; show nothing rather than a guess.
    if (!match || typeof value !== "number" || !(value >= 0 && value <= 1)) return [];
    const count = Number(match[1]);
    const unit = match[2] as "Hour" | "Day" | "Week" | "Month";
    const reset = usage[`per${count}${unit}ResetTime`];
    const label =
      count === 1 && unit === "Month"
        ? "Monthly"
        : count === 1 && unit === "Week"
          ? "Weekly"
          : `${count}-${unit.toLowerCase()}`;
    return [
      usageWindow(
        `per${count}${unit}`,
        label,
        unit === "Month"
          ? "monthly"
          : unit === "Week"
            ? "weekly"
            : unit === "Hour"
              ? "session"
              : "other",
        value * 100,
        typeof reset === "number" && Number.isFinite(reset)
          ? DateTime.formatIso(DateTime.makeUnsafe(reset))
          : undefined,
        unit === "Month" ? undefined : TOKEN_PLAN_UNIT_MINUTES[unit] * count,
      ),
    ];
  });
}

/** Qwen Code's Bailian Token Plan limits, read through the signed-in Bailian CLI (`bl`). */
export const readQwenTokenPlanUsageLimits = Effect.fn("readQwenTokenPlanUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const signIn = makeUnavailableUsageLimits({
    checkedAt,
    reason: "unsupported",
    message: "Run `bl auth login --console` to see Token Plan limits.",
  });
  // bl answers for the account it is signed in to, so only a Qwen set up for Token Plan reads it.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || (yield* HostProcess.HomeDirectory);
  const qwenSettings = yield* fs
    .readFileString(path.join(home, ".qwen", "settings.json"))
    .pipe(Effect.flatMap(decodeQwenSettings), Effect.option);
  const usesTokenPlan =
    Boolean(environment.BAILIAN_TOKEN_PLAN_API_KEY?.trim()) ||
    (Option.isSome(qwenSettings) &&
      (qwenSettings.value.env?.BAILIAN_TOKEN_PLAN_API_KEY !== undefined ||
        qwenSettings.value.providerMetadata?.["token-plan"] !== undefined));
  if (!usesTokenPlan) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  // bl gets only what it needs to run; the instance's own secrets never reach it.
  const blEnvironment = Object.fromEntries(
    BL_ENVIRONMENT.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const output = yield* (yield* ChildProcessSpawner.ChildProcessSpawner)
    .string(
      ChildProcess.make("bl", ["usage", "token-plan", "--output", "json"], {
        env: blEnvironment,
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    )
    .pipe(Effect.timeout("30 seconds"), Effect.option);
  if (Option.isNone(output)) return signIn;
  const usage = yield* decodeTokenPlanUsage(output.value.trim()).pipe(Effect.option);
  if (Option.isNone(usage) || "error" in usage.value) return signIn;
  const windows = tokenPlanUsageToWindows(usage.value).map((window) => ({
    ...window,
    label: `${window.label} · bl account`,
  }));
  return makeUsageLimits({ checkedAt, windows });
});

const DeepSeekBalance = Schema.Struct({
  balance_infos: Schema.Array(
    Schema.Struct({
      currency: Schema.NonEmptyString,
      total_balance: Schema.NumberFromString,
      granted_balance: Schema.optional(Schema.NumberFromString),
    }),
  ),
});

/** The API key dsh keeps under `refs:` in ~/.dsh/.credentials.yaml. */
export function dshApiKeyRef(credentials: string): string | undefined {
  let document: unknown;
  try {
    document = Yaml.parse(credentials);
  } catch {
    return undefined;
  }
  // Only the root mapping's `refs.DEEPSEEK_API_KEY`; text that merely looks like it never counts.
  const refs = Predicate.isObject(document) ? (document as { refs?: unknown }).refs : undefined;
  const value = Predicate.isObject(refs)
    ? (refs as { DEEPSEEK_API_KEY?: unknown }).DEEPSEEK_API_KEY
    : undefined;
  return Predicate.isString(value) && Option.isSome(decodeHeaderSafe(value)) ? value : undefined;
}

/** DeepSeek bills a prepaid wallet, so its "limits" are the balance, not a percentage window. */
export const readDeepSeekBalance = Effect.fn("readDeepSeekBalance")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || (yield* HostProcess.HomeDirectory);
  const fromEnvironment = decodeHeaderSafe(environment.DEEPSEEK_API_KEY?.trim());
  const apiKey = Option.isSome(fromEnvironment)
    ? fromEnvironment.value
    : yield* fs.readFileString(path.join(home, ".dsh", ".credentials.yaml")).pipe(
        Effect.map(dshApiKeyRef),
        Effect.orElseSucceed(() => undefined),
      );
  if (!apiKey) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "Add a DeepSeek API key to dsh to see the account balance.",
    });
  }
  const response = yield* (yield* HttpClient.HttpClient)
    .pipe(HttpClient.filterStatusOk)
    .execute(
      HttpClientRequest.get("https://api.deepseek.com/user/balance").pipe(
        HttpClientRequest.bearerToken(apiKey),
      ),
    )
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(DeepSeekBalance)), withoutRedirects);
  return {
    ...makeUsageLimits({ checkedAt, windows: [] }),
    balances: response.balance_infos.map((info) => ({
      currency: info.currency,
      total: info.total_balance,
      ...(info.granted_balance === undefined ? {} : { granted: info.granted_balance }),
    })),
  };
});

/** How the instance starts its agent; arguments can select the account. */
type UsageLaunch = Pick<AcpRegistrySettings, "commandPath" | "commandArgs">;

const QoderQuota = Schema.Struct({ total: Schema.Number, used: Schema.Number });
const QoderUsage = Schema.Struct({
  // Epoch milliseconds; 0 when the plan has no renewal date.
  expiresAt: Schema.optional(Schema.Number),
  userQuota: Schema.optional(QoderQuota),
  addOnQuota: Schema.optional(QoderQuota),
  orgResourcePackage: Schema.optional(
    Schema.Struct({
      used: Schema.optional(Schema.Number),
      cap: Schema.optional(Schema.Number),
      available: Schema.optional(Schema.Boolean),
    }),
  ),
  dedicatedResourcePackages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...QoderQuota.fields,
        id: Schema.String,
        name: Schema.optional(Schema.String),
        available: Schema.optional(Schema.Boolean),
        expiresAt: Schema.optional(Schema.Number),
        displayLabels: Schema.optional(
          Schema.Array(
            Schema.Struct({
              dimension: Schema.String,
              valueI18n: Schema.optional(Schema.Record(Schema.String, Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
});
const decodeQoderUsage = Schema.decodeEffect(Schema.fromJsonString(QoderUsage));

/** The credit pools the Qoder app lists, under its own English names. */
export function qoderUsageToWindows(usage: typeof QoderUsage.Type) {
  const pool = (
    id: string,
    label: string,
    quota: { readonly total?: number | undefined; readonly used?: number | undefined } | undefined,
    expiresAt?: number,
  ): ServerProviderUsageWindow[] => {
    // A negative or zero total is an unlimited or empty pool, which has no percentage.
    if (quota?.total === undefined || quota.used === undefined || !(quota.total > 0)) return [];
    const resets =
      expiresAt !== undefined && expiresAt > 0 ? DateTime.make(expiresAt) : Option.none();
    return [
      usageWindow(
        id,
        label,
        id === "plan" ? "monthly" : "other",
        (quota.used / quota.total) * 100,
        Option.isSome(resets) ? DateTime.formatIso(resets.value) : undefined,
        undefined,
      ),
    ];
  };
  const org = usage.orgResourcePackage;
  return [
    ...pool("plan", "Plan credits", usage.userQuota, usage.expiresAt),
    ...pool("add-on", "Resource package", usage.addOnQuota),
    ...(usage.dedicatedResourcePackages ?? []).flatMap((item) =>
      item.available === false
        ? []
        : pool(
            item.id,
            item.displayLabels?.find((label) => label.dimension === "title")?.valueI18n?.[
              "en-US"
            ] ??
              item.name ??
              "Dedicated package",
            item,
            item.expiresAt,
          ),
    ),
    ...(org?.available
      ? pool("organization", "Organization package", { total: org.cap, used: org.used })
      : []),
  ];
}

/** Qoder credits, read through the launcher with the account the Qoder runtime is signed in to. */
export const readQoderUsageLimits = Effect.fn("readQoderUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
  launch: UsageLaunch,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const output = yield* (yield* ChildProcessSpawner.ChildProcessSpawner)
    .string(
      ChildProcess.make(launch.commandPath, [...launch.commandArgs, "usage"], {
        env: environment,
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    )
    .pipe(Effect.timeout("30 seconds"), Effect.option);
  const usage = yield* Effect.fromOption(output).pipe(
    Effect.flatMap((text) => decodeQoderUsage(text.trim())),
    Effect.option,
  );
  if (Option.isNone(usage)) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Sign in to Qoder to see its credits.",
    });
  }
  return makeUsageLimits({ checkedAt, windows: qoderUsageToWindows(usage.value) });
});

type UsageRead = ReturnType<
  | typeof readKimiCodeUsageLimits
  | typeof readZCodeUsageLimits
  | typeof readQwenTokenPlanUsageLimits
  | typeof readDeepSeekBalance
  | typeof readQoderUsageLimits
>;

/** The limits reader for an ACP Registry agent that reports them, if any. */
export function acpRegistryUsageReader(
  agentId: string | undefined,
):
  | ((
      environment: NodeJS.ProcessEnv,
      launch: UsageLaunch,
    ) => Effect.Effect<
      Effect.Success<UsageRead>,
      Effect.Error<UsageRead>,
      Effect.Services<UsageRead>
    >)
  | undefined {
  if (agentId === "kimi-code") return readKimiCodeUsageLimits;
  if (agentId === "zcode-acp.mjs") return readZCodeUsageLimits;
  if (agentId === "qwen-code") return readQwenTokenPlanUsageLimits;
  if (agentId === "dsh-acp.mjs") return readDeepSeekBalance;
  if (agentId === "qoder-acp.mjs") return readQoderUsageLimits;
  return undefined;
}
