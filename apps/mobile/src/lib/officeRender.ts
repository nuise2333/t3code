import { useAtomValue } from "@effect/atom-react";
import {
  type OfficeRenderSource,
  type OfficeRenderState,
  prepareOfficeRender,
} from "@t3tools/client-runtime/office-render";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { fetch } from "expo/fetch";

import { refreshAssetUrl } from "../state/assets";
import { usePreparedConnection } from "../state/session";

interface OfficeRenderKey {
  readonly environmentId: EnvironmentId;
  readonly source: OfficeRenderSource;
  /** A reconnect changes the base URL, and any URL minted against the old one is unusable. */
  readonly httpBaseUrl: string;
  readonly revision: number;
}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`).
const officeRenderAtom = Atom.family((key: OfficeRenderKey) =>
  Atom.make(
    Effect.promise((signal) =>
      prepareOfficeRender({
        mint: () =>
          refreshAssetUrl(key.environmentId, { _tag: "office-render", source: key.source }, signal),
        fetch: (url, init) => fetch(url, init),
        signal,
      }),
    ),
  ).pipe(Atom.withLabel("office-render")),
);

const noOfficeRender = Atom.make(
  AsyncResult.initial<Exclude<OfficeRenderState, { _tag: "loading" }>>(),
).pipe(Atom.withLabel("office-render:none"));

/** LibreOffice's PDF of an Office file on the host, or null for a file that is not one. */
export function useOfficeRender(
  environmentId: EnvironmentId | null,
  source: OfficeRenderSource | null,
  revision: number,
): OfficeRenderState | null {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const result = useAtomValue(
    environmentId === null || source === null || httpBaseUrl === null
      ? noOfficeRender
      : officeRenderAtom({ environmentId, source, httpBaseUrl, revision }),
  );
  if (environmentId === null || source === null) return null;
  return AsyncResult.isSuccess(result) && !result.waiting ? result.value : { _tag: "loading" };
}
