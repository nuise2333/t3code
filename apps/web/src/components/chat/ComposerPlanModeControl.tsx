import { useGT } from "gt-react";
import { ListChecksIcon } from "lucide-react";
import { memo } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

/** Switches the thread between plan mode, where the agent proposes a plan first, and building. */
export const ComposerPlanModeControl = memo(function ComposerPlanModeControl(props: {
  readonly on: boolean;
  readonly size?: "sm" | "xs";
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const size = props.size ?? "sm";
  const label = props.on
    ? gt(
        "Plan mode: on. The agent proposes a plan and waits for your approval. Shift+Tab switches it.",
      )
    : gt(
        "Plan mode: off. Turn it on to have the agent propose a plan before it changes anything. Shift+Tab switches it.",
      );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            className="ps-1.5"
            data-composer-plan-mode={props.on ? "on" : "off"}
            aria-pressed={props.on}
            aria-label={label}
            onClick={props.onToggle}
          />
        }
      >
        <ComposerControlIcon
          icon={ListChecksIcon}
          size={size}
          {...(props.on ? { className: "text-foreground" } : {})}
        />
        {props.on ? <span data-composer-control-label>{gt("Plan")}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
});
