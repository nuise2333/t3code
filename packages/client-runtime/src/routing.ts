import type {
  LaunchRoutingRequest,
  ModelSelection,
  ProviderOptionDescriptor,
  RouteDecision,
  RoutingReason,
} from "@t3tools/contracts";
import { isReasoningSelect } from "@t3tools/shared/model";
import { effortSetOutsidePicker } from "@t3tools/shared/routing";

const REASON_LABELS: Partial<Record<RoutingReason, string>> = {
  plan_mode: "Plan mode",
  many_paths: "Mentions 3+ files",
  hard_keyword: "Large change",
  debug_keyword: "Debugging",
  question: "Question, no edits",
  quick_keyword: "Small edit",
  default_class: "No clear signal",
  model_row: "Tuned for this model",
  nearest_level: "Closest level this model offers",
};

const AUTO_REQUEST: LaunchRoutingRequest = { mode: "auto" };

/** Auto effort needs a server that honors the request and the server's setting turned on. */
export function autoEffortOffered(input: {
  readonly capability: boolean | undefined;
  readonly settingEnabled: boolean | undefined;
}): boolean {
  return input.capability === true && input.settingEnabled === true;
}

const ROUTED_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

/**
 * Whether Auto can set this model's reasoning control. The server leaves any other control, and a
 * level Ultrathink or Ultracode already set, unchanged.
 */
export function autoEffortSupported(input: {
  readonly driver: string | undefined;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly ultrathinkPrompt: boolean;
}): boolean {
  const descriptor = input.descriptors?.find(isReasoningSelect);
  if (input.driver === "acpRegistry" || descriptor === undefined) return false;
  if (effortSetOutsidePicker(input)) return false;
  return descriptor.options.some(
    (option) =>
      ROUTED_LEVELS.has(option.id) && !descriptor.promptInjectedValues?.includes(option.id),
  );
}

/** A draft is Auto until its user picks a level; multi-model sends keep their own selections. */
export function launchRoutingRequest(input: {
  readonly offered: boolean;
  readonly effortManual: boolean;
  readonly multiModel: boolean;
}): LaunchRoutingRequest | undefined {
  return input.offered && !input.effortManual && !input.multiModel ? AUTO_REQUEST : undefined;
}

export function describeRoutingReasons(reasons: ReadonlyArray<RoutingReason>): string {
  return reasons.flatMap((reason) => REASON_LABELS[reason] ?? []).join(", ");
}

export interface RoutedEffortDisplay {
  readonly levelLabel: string;
  readonly reason: string;
  /** One line for a tooltip or a menu footer, such as "Auto picked High: Plan mode". */
  readonly summary: string;
}

/**
 * The routed level while the selection still holds it. Picking another level makes the thread
 * manual, so this turns null without any extra state.
 */
export function routedEffortDisplay(input: {
  readonly routing: RouteDecision | null | undefined;
  readonly selection: ModelSelection | null | undefined;
  readonly descriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined;
}): RoutedEffortDisplay | null {
  const { routing, selection } = input;
  if (!routing?.applied || routing.effort === null || routing.optionId === undefined) return null;
  const current = selection?.options?.find((option) => option.id === routing.optionId)?.value;
  if (current !== routing.effort) return null;
  const descriptor = input.descriptors?.find((candidate) => candidate.id === routing.optionId);
  const levelLabel =
    (descriptor?.type === "select"
      ? descriptor.options.find((option) => option.id === routing.effort)?.label
      : undefined) ?? routing.effort.charAt(0).toUpperCase() + routing.effort.slice(1);
  const reason = describeRoutingReasons(routing.reasons);
  return {
    levelLabel,
    reason,
    summary: reason ? `Auto picked ${levelLabel}: ${reason}` : `Auto picked ${levelLabel}`,
  };
}
