import { RotateCcwIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Offered after the same command failed in the last two turns; Auto never retries by itself. */
export function effortRetryBannerItem(input: {
  readonly retry: { readonly levelLabel: string; readonly onRetry: () => void } | null;
  /** Opens a new thread draft on another vendor's model; the user sends it. */
  readonly rootCause: { readonly modelName: string; readonly onOpen: () => void } | null;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  const { retry, rootCause } = input;
  return {
    id: "effort-retry",
    variant: "info",
    icon: <RotateCcwIcon />,
    title: "The same command failed in the last two turns",
    actions: (
      <>
        {retry ? (
          <Button size="xs" variant="ghost" onClick={retry.onRetry}>
            Retry with {retry.levelLabel}
          </Button>
        ) : null}
        {rootCause ? (
          <Button size="xs" variant="ghost" onClick={rootCause.onOpen}>
            Find the cause on {rootCause.modelName}
          </Button>
        ) : null}
      </>
    ),
    dismissLabel: "Dismiss retry suggestion",
    onDismiss: input.onDismiss,
  };
}
