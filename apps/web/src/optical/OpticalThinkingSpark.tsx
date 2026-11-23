import { BrainIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useOpticalConfig } from "./config";

/**
 * The reasoning glyph: a four-point spark that orbits while its row is live (see
 * `[data-optical-live]` in optical.css). With optical motion off it stays the plain brain icon.
 */
export function ReasoningGlyph({ className }: { className: string }) {
  const { motionLevel } = useOpticalConfig();
  if (motionLevel === "off") return <BrainIcon className={className} aria-hidden />;
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn(className, "optical-thinking-spark")}
      fill="currentColor"
      stroke="none"
      aria-hidden
    >
      <path d="M8 1.2c.42 3.36 2.44 5.38 5.8 5.8-3.36.42-5.38 2.44-5.8 5.8-.42-3.36-2.44-5.38-5.8-5.8 3.36-.42 5.38-2.44 5.8-5.8Z" />
    </svg>
  );
}
