import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const thoughtTranslate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thought-translation:translate",
  tag: WS_METHODS.serverTranslateThought,
});
