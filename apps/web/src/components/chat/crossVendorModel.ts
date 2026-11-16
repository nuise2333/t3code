import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  CrossVendorModelResult,
  EnvironmentId,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

type CrossVendorKey = readonly [
  environmentId: EnvironmentId,
  instanceId: ModelSelection["instanceId"],
  model: string,
  projectId: ProjectId | null,
];

const crossVendorModelAtom = Atom.family((key: string) => {
  const [environmentId, instanceId, model, projectId] = JSON.parse(key) as CrossVendorKey;
  return Atom.make((get) =>
    Effect.promise(() =>
      runAtomCommand(
        get.registry,
        serverEnvironment.crossVendorModel,
        { environmentId, input: { failing: { instanceId, model }, projectId } },
        { reportFailure: false },
      ),
    ).pipe(Effect.map((result) => (result._tag === "Success" ? result.value : null))),
  ).pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`cross-vendor-model:${key}`));
});

const NO_CROSS_VENDOR_MODEL = Atom.make(AsyncResult.success<CrossVendorModelResult>(null));

/** The server's pick of another vendor's model for a failure; null while asking or when none fits. */
export function useCrossVendorModel(
  request: {
    readonly environmentId: EnvironmentId;
    readonly failing: Pick<ModelSelection, "instanceId" | "model">;
    readonly projectId: ProjectId | null;
  } | null,
): CrossVendorModelResult {
  const result = useAtomValue(
    request === null
      ? NO_CROSS_VENDOR_MODEL
      : crossVendorModelAtom(
          JSON.stringify([
            request.environmentId,
            request.failing.instanceId,
            request.failing.model,
            request.projectId,
          ] satisfies CrossVendorKey),
        ),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}
