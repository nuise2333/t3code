import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  readKimiCodeUsageLimits,
  readZCodeUsageLimits,
  tokenPlanUsageToWindows,
  zhipuQuotaToWindows,
} from "./usageLimits.ts";

const usages = {
  usages: {
    limit_5h: { used_ratio: 0.25, reset_time: "2099-01-01T05:00:00Z" },
    limit_7d: { used_ratio: 0.003, reset_time: "2099-01-07T00:00:00Z" },
  },
};

const kimiFixture = Effect.fn(function* (options: {
  expiresAt: number;
  refreshStatus?: number;
  rotatedByCli?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(home, "credentials"));
  const tokenPath = path.join(home, "credentials", "kimi-code.json");
  yield* fs.writeFileString(
    tokenPath,
    JSON.stringify({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: options.expiresAt,
    }),
  );
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const http = HttpClient.make((request, _url, _signal, fiber) =>
    Effect.gen(function* () {
      expect(Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect).toBe(
        "manual",
      );
      requests.push({ url: request.url, authorization: request.headers.authorization });
      if (request.url.endsWith("/api/oauth/token")) {
        if (options.rotatedByCli) {
          // The CLI refreshed first: it already saved a new token and our refresh token is spent.
          yield* fs.writeFileString(
            tokenPath,
            JSON.stringify({
              access_token: "cli-access",
              refresh_token: "cli-refresh",
              expires_at: 4e9,
            }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { access_token: "new-access", refresh_token: "new-refresh", expires_in: 900 },
            { status: options.refreshStatus ?? 200 },
          ),
        );
      }
      return HttpClientResponse.fromWeb(request, Response.json(usages));
    }).pipe(Effect.orDie),
  );
  const limits = yield* readKimiCodeUsageLimits({ KIMI_CODE_HOME: home }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const saved = JSON.parse(yield* fs.readFileString(tokenPath));
  return { limits, requests, saved };
});

describe("ACP Registry agent limits", () => {
  it.effect("refreshes an expired Kimi Code token and writes it back for the CLI", () =>
    Effect.gen(function* () {
      const { limits, requests, saved } = yield* kimiFixture({ expiresAt: 0 });
      expect(saved).toMatchObject({ access_token: "new-access", refresh_token: "new-refresh" });
      expect(requests.at(-1)?.authorization).toBe("Bearer new-access");
      expect(limits.windows.map((window) => [window.label, window.usedPercent])).toEqual([
        ["5-hour", 25],
        ["Weekly", 0.3],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("adopts the token the Kimi CLI saved when its refresh won the race", () =>
    Effect.gen(function* () {
      const { limits, requests, saved } = yield* kimiFixture({
        expiresAt: 0,
        refreshStatus: 400,
        rotatedByCli: true,
      });
      expect(saved.refresh_token).toBe("cli-refresh");
      expect(requests.at(-1)?.authorization).toBe("Bearer cli-access");
      expect(limits.unavailable).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never overwrites a sign-in the Kimi CLI saved while our refresh was in flight", () =>
    Effect.gen(function* () {
      const { requests, saved } = yield* kimiFixture({ expiresAt: 0, rotatedByCli: true });
      expect(saved.refresh_token).toBe("cli-refresh");
      expect(requests.at(-1)?.authorization).toBe("Bearer cli-access");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a fresh Kimi Code token without refreshing it", () =>
    Effect.gen(function* () {
      const { requests, saved } = yield* kimiFixture({ expiresAt: 4e9 });
      expect(requests.map((request) => request.url)).toEqual([
        "https://api.kimi.com/coding/v1/usages",
      ]);
      expect(saved.refresh_token).toBe("old-refresh");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sends a ZCode key only to Zhipu's own hosts, and only when one is set", () =>
    Effect.gen(function* () {
      for (const environment of [
        {},
        { ZCODE_ACP_API_KEY: "key", ZCODE_ACP_BASE_URL: "https://x" },
      ]) {
        const limits = yield* readZCodeUsageLimits(environment).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("no request expected")),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it("reads Zhipu Coding Plan windows", () => {
    expect(
      zhipuQuotaToWindows([
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12, nextResetTime: 4102444800000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 40 },
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 3 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5 },
      ]).map((window) => [
        window.label,
        window.kind,
        window.usedPercent,
        window.windowDurationMins,
      ]),
    ).toEqual([
      ["5-hour", "session", 12, 300],
      ["Weekly", "weekly", 40, 10080],
      ["Tool calls · Monthly", "monthly", 3, undefined],
    ]);
  });
  it("reads Bailian Token Plan windows from the bl CLI's used fractions", () => {
    expect(
      tokenPlanUsageToWindows({
        per1MonthPercentage: 0.0375,
        per1MonthResetTime: 1797436800000,
        per5HourPercentage: 0.5,
        hasQuotaData: true,
      }).map((window) => [
        window.label,
        window.kind,
        window.usedPercent,
        window.windowDurationMins,
      ]),
    ).toEqual([
      ["Monthly", "monthly", 3.75, undefined],
      ["5-hour", "session", 50, 300],
    ]);
  });
});
