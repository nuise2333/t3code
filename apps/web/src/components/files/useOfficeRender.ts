import {
  type OfficeRenderSource,
  type OfficeRenderState,
  prepareOfficeRender,
} from "@t3tools/client-runtime/office-render";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { useAssetUrlRefresh } from "~/assets/assetUrls";

type Settled = Exclude<OfficeRenderState, { _tag: "loading" }>;

/** LibreOffice's PDF of a file on the host. `enabled` is false while another view is chosen. */
export function useOfficeRender(input: {
  readonly environmentId: EnvironmentId | null;
  readonly source: OfficeRenderSource | null;
  readonly enabled: boolean;
  readonly revision: number;
}): OfficeRenderState {
  const { source } = input;
  const mint = useAssetUrlRefresh(
    input.environmentId,
    source ? { _tag: "office-render", source } : null,
  );
  const key = JSON.stringify([input.environmentId, source, input.revision]);
  const [settled, setSettled] = useState<{ key: string; state: Settled } | null>(null);
  const prepare = useEffectEvent((signal: AbortSignal) =>
    prepareOfficeRender({ mint, fetch: (url, init) => fetch(url, init), signal }),
  );
  const pending = input.enabled && source !== null && settled?.key !== key;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the host to convert the file and aborts the request on cleanup
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    void prepare(controller.signal).then((state) => {
      if (!controller.signal.aborted) setSettled({ key, state });
    });
    return () => controller.abort();
  }, [pending, key]);
  if (source === null) return { _tag: "fallback", reason: "unsupported" };
  return settled?.key === key ? settled.state : { _tag: "loading" };
}
