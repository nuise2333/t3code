import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { I18nProvider, useGT } from "../../i18n/I18nProvider";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";

interface ComposerPlanModeControlProps {
  readonly threadKey: string;
  readonly on: boolean;
  readonly size: "regular" | "large";
  readonly disabled: boolean;
}

/** Switches the thread between plan mode, where the agent proposes a plan first, and building. */
export function ComposerPlanModeControl(props: ComposerPlanModeControlProps) {
  return (
    <I18nProvider fallback={null}>
      <PlanModeControl {...props} />
    </I18nProvider>
  );
}

function PlanModeControl(props: ComposerPlanModeControlProps) {
  const gt = useGT();
  return (
    <ComposerInlineControl
      size={props.size}
      icon="list.number"
      label={gt("Plan")}
      iconOnly={!props.on}
      selected={props.on}
      showChevron={false}
      disabled={props.disabled}
      accessibilityLabel={
        props.on
          ? gt("Plan mode: on. The agent proposes a plan and waits for your approval.")
          : gt(
              "Plan mode: off. Turn it on to have the agent propose a plan before it changes anything.",
            )
      }
      // The next send applies the draft's mode to the thread before it starts the turn.
      onPress={() =>
        updateComposerDraftSettings(props.threadKey, {
          interactionMode: props.on ? "default" : "plan",
        })
      }
    />
  );
}
