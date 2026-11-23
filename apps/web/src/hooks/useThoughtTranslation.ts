import { useAtomValue } from "@effect/atom-react";
import {
  THOUGHT_TRANSLATION_MAX_TEXT_LENGTH,
  type EnvironmentId,
  type ThoughtTranslationResult,
} from "@t3tools/contracts";
import type { ThoughtTranslationMode } from "@t3tools/contracts/settings";
import { shouldTranslateThought } from "@t3tools/shared/thoughtTranslation";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { useClientSettings } from "./useSettings";
import { serverEnvironment } from "../state/server";
import { thoughtTranslate } from "../state/thoughtTranslation";
import { useAtomCommand } from "../state/use-atom-command";

const MAX_CLIENT_CACHE_ENTRIES = 256;
const STREAMING_DEBOUNCE_MS = 1_200;
const MIN_STREAMING_CHARS = 16;

type CachedEntry =
  | { readonly kind: "translated"; readonly text: string }
  | { readonly kind: "skipped" };

const clientCache = new Map<string, CachedEntry>();
const inFlightRequests = new Map<
  string,
  Promise<
    | { readonly ok: true; readonly result: ThoughtTranslationResult }
    | { readonly ok: false; readonly message: string }
  >
>();

function readClientCache(key: string): CachedEntry | undefined {
  const hit = clientCache.get(key);
  if (hit === undefined) return undefined;
  clientCache.delete(key);
  clientCache.set(key, hit);
  return hit;
}

function writeClientCache(key: string, entry: CachedEntry): void {
  clientCache.delete(key);
  clientCache.set(key, entry);
  while (clientCache.size > MAX_CLIENT_CACHE_ENTRIES) {
    const oldest = clientCache.keys().next().value;
    if (oldest === undefined) break;
    clientCache.delete(oldest);
  }
}

export type ThoughtTranslationStatus = "idle" | "loading" | "ready" | "error";

export interface UseThoughtTranslationResult {
  readonly mode: ThoughtTranslationMode;
  readonly status: ThoughtTranslationStatus;
  readonly translatedText: string | null;
  readonly errorMessage: string | null;
  readonly retry: () => void;
}

interface TranslationOutcome {
  readonly key: string;
  readonly attempt: number;
  readonly scopeKey: string;
  readonly status: "loading" | "ready" | "error";
  readonly translatedText: string | null;
  readonly errorMessage: string | null;
}

export function useThoughtTranslation(input: {
  readonly environmentId: EnvironmentId;
  readonly scopeKey: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly enabled?: boolean;
}): UseThoughtTranslationResult {
  const { environmentId, scopeKey, text, streaming, enabled = true } = input;
  const mode = useClientSettings((settings) => settings.thoughtTranslation);
  const responseLanguage =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.responseLanguage ?? "";
  const canTranslate = useAtomValue(thoughtTranslate.permissionAtom(environmentId));
  const runTranslate = useAtomCommand(thoughtTranslate, {
    label: "thought translation",
    reportFailure: false,
    reportDefect: false,
  });

  const targetLanguage = responseLanguage.trim();
  const trimmedText = text.trim();
  const eligible =
    enabled &&
    mode !== "off" &&
    canTranslate &&
    trimmedText.length <= THOUGHT_TRANSLATION_MAX_TEXT_LENGTH &&
    shouldTranslateThought(trimmedText, targetLanguage);

  const requestKey = eligible ? `${environmentId}\0${targetLanguage}\0${trimmedText}` : null;
  const cached = requestKey ? readClientCache(requestKey) : undefined;

  const [outcome, setOutcome] = useState<TranslationOutcome | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = () => {
    if (requestKey) {
      clientCache.delete(requestKey);
      inFlightRequests.delete(requestKey);
    }
    setAttempt((current) => current + 1);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests thought translation over RPC (debounced while streaming) and stores the settled result
  useEffect(() => {
    if (!requestKey || cached !== undefined) return;
    if (streaming && trimmedText.length < MIN_STREAMING_CHARS) return;

    let cancelled = false;
    const execute = () => {
      if (cancelled) return;
      setOutcome((previous) => ({
        key: requestKey,
        attempt,
        scopeKey,
        status: "loading",
        translatedText:
          streaming && previous?.scopeKey === scopeKey ? previous.translatedText : null,
        errorMessage: null,
      }));

      let pending = inFlightRequests.get(requestKey);
      if (!pending) {
        pending = runTranslate({
          environmentId,
          input: {
            text: trimmedText,
            targetLanguage,
          },
        }).then((result) => {
          inFlightRequests.delete(requestKey);
          if (result._tag === "Success") {
            return { ok: true as const, result: result.value };
          }
          if (isAtomCommandInterrupted(result)) {
            return { ok: false as const, message: "Translation cancelled." };
          }
          const failure = squashAtomCommandFailure(result);
          const message =
            failure instanceof Error && failure.message.trim().length > 0
              ? failure.message
              : "Thought translation failed.";
          return { ok: false as const, message };
        });
        inFlightRequests.set(requestKey, pending);
      }

      void pending.then((settled) => {
        if (settled.ok) {
          if (settled.result.skipped) {
            writeClientCache(requestKey, { kind: "skipped" });
            if (!cancelled) {
              setOutcome((previous) => (previous?.key === requestKey ? null : previous));
            }
            return;
          }
          writeClientCache(requestKey, {
            kind: "translated",
            text: settled.result.translatedText,
          });
          if (!cancelled) {
            setOutcome({
              key: requestKey,
              attempt,
              scopeKey,
              status: "ready",
              translatedText: settled.result.translatedText,
              errorMessage: null,
            });
          }
          return;
        }
        if (!cancelled) {
          setOutcome((previous) => ({
            key: requestKey,
            attempt,
            scopeKey,
            status: "error",
            translatedText:
              streaming && previous?.scopeKey === scopeKey ? previous.translatedText : null,
            errorMessage: settled.message,
          }));
        }
      });
    };

    if (streaming) {
      const timer = window.setTimeout(execute, STREAMING_DEBOUNCE_MS);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    execute();
    return () => {
      cancelled = true;
    };
  }, [
    attempt,
    cached,
    environmentId,
    requestKey,
    runTranslate,
    scopeKey,
    streaming,
    targetLanguage,
    trimmedText,
  ]);

  if (!requestKey) {
    return {
      mode,
      status: "idle",
      translatedText: null,
      errorMessage: null,
      retry,
    };
  }

  if (cached !== undefined) {
    return cached.kind === "skipped"
      ? { mode, status: "idle", translatedText: null, errorMessage: null, retry }
      : { mode, status: "ready", translatedText: cached.text, errorMessage: null, retry };
  }

  if (outcome?.key === requestKey && outcome.attempt === attempt) {
    return {
      mode,
      status: outcome.status,
      translatedText: outcome.translatedText,
      errorMessage: outcome.errorMessage,
      retry,
    };
  }

  const carriedTranslation =
    streaming && outcome?.scopeKey === scopeKey ? outcome.translatedText : null;
  if (streaming && trimmedText.length < MIN_STREAMING_CHARS && carriedTranslation === null) {
    return {
      mode,
      status: "idle",
      translatedText: null,
      errorMessage: null,
      retry,
    };
  }

  return {
    mode,
    status: "loading",
    translatedText: carriedTranslation,
    errorMessage: null,
    retry,
  };
}
