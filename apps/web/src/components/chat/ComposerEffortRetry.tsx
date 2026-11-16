import { RotateCcwIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Offered after the same command failed in the last two turns; Auto never retries by itself. */
export function effortRetryBannerItem(input: {
  readonly levelLabel: string;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  return {
    id: "effort-retry",
    variant: "info",
    icon: <RotateCcwIcon />,
    title: "The same command failed in the last two turns",
    actions: (
      <Button size="xs" variant="ghost" onClick={input.onRetry}>
        Retry with {input.levelLabel}
      </Button>
    ),
    dismissLabel: "Dismiss retry suggestion",
    onDismiss: input.onDismiss,
  };
}
