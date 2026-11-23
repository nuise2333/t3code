import type { OrchestrationV2Run } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isOpticalReducedMotion, useOpticalConfig } from "./config";
import { mountMascotStage, type MascotStage, type MascotStageState } from "./mascotRig";

const HIGH_EFFORTS = new Set(["high", "xhigh", "max"]);
const COMPOSER_FORM_SELECTOR = '[data-chat-composer-form="true"]';

function latestOrdinal(runs: ReadonlyArray<OrchestrationV2Run>): number {
  let max = 0;
  for (const run of runs) if (run.ordinal > max) max = run.ordinal;
  return max;
}

/** The newest run that has left the queue ended in failure. */
function lastRunFailed(runs: ReadonlyArray<OrchestrationV2Run>): boolean {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" || run.status === "preparing") continue;
    if (!latest || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.status === "failed";
}

export interface OpticalMascotProps {
  /** Resets the event baselines so switching threads never reads as a send or a model change. */
  readonly threadKey: string;
  readonly running: boolean;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly provider: string;
  readonly modelKey: string;
  readonly effort: string | null;
  /** A composer menu, the model picker, or a pending approval or question is open. */
  readonly yieldToUi: boolean;
}

/** Crab and cat (plus mini crabs) standing on the composer's top edge. */
export function OpticalMascot(props: OpticalMascotProps) {
  const cfg = useOpticalConfig();
  if (cfg.mascot === "off") return null;
  return (
    <MascotStageHost
      {...props}
      miniPileEnabled={cfg.mascot === "minis"}
      reducedMotion={isOpticalReducedMotion(cfg)}
    />
  );
}

function MascotStageHost({
  threadKey,
  running,
  runs,
  provider,
  modelKey,
  effort,
  yieldToUi,
  miniPileEnabled,
  reducedMotion,
}: OpticalMascotProps & { readonly miniPileEnabled: boolean; readonly reducedMotion: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const rigRef = useRef<MascotStage | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const hasError = lastRunFailed(runs);
  const queued = runs.some((run) => run.status === "queued");
  const ordinal = latestOrdinal(runs);
  const camp = provider === "claudeAgent" ? "claude" : "gemini";
  const streamTier = effort !== null && HIGH_EFFORTS.has(effort) ? 3 : 2;
  const yieldMode = yieldToUi || queued || popoverOpen ? "peek" : "none";
  const buildState = (): MascotStageState => ({
    camp,
    streaming: running,
    streamTier,
    hasError,
    yieldMode,
    leapOffsetY: 0,
    popoverRightWidth: 0,
    miniPileEnabled,
    orchestrator: false,
    reducedMotion,
  });
  const readState = useEffectEvent(buildState);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the canvas rig, its timers and listeners for the stage's lifetime
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const rig = mountMascotStage(stage, readState());
    rigRef.current = rig;
    return () => {
      rigRef.current = null;
      rig.dispose();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- popovers opened from composer controls report only through their triggers' aria-expanded
  useEffect(() => {
    const form = stageRef.current?.closest(COMPOSER_FORM_SELECTOR);
    if (!form) return;
    const sync = () => setPopoverOpen(form.querySelector('[aria-expanded="true"]') !== null);
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(form, { subtree: true, attributes: true, attributeFilter: ["aria-expanded"] });
    return () => observer.disconnect();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes thread state into the imperative canvas rig; nothing here renders
  useEffect(() => {
    rigRef.current?.setState({
      camp,
      streaming: running,
      streamTier,
      hasError,
      yieldMode,
      miniPileEnabled,
      reducedMotion,
    });
  }, [camp, running, streamTier, hasError, yieldMode, miniPileEnabled, reducedMotion]);

  const baseline = useRef<{
    threadKey: string;
    running: boolean;
    ordinal: number;
    modelKey: string;
    effort: string | null;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- turns run, model and effort transitions into one-shot rig reactions
  useEffect(() => {
    const prev = baseline.current;
    baseline.current = { threadKey, running, ordinal, modelKey, effort };
    const rig = rigRef.current;
    if (!rig || !prev || prev.threadKey !== threadKey) return;
    if (ordinal > prev.ordinal) rig.notify("send");
    if (prev.running && !running) rig.notify("streamDone", { error: hasError });
    if (modelKey !== prev.modelKey) rig.notify("model-shift");
    if (effort !== prev.effort && effort !== null && HIGH_EFFORTS.has(effort)) {
      // The rig celebrates high and xhigh; max is the same gesture.
      rig.notify("effort-tier", { tier: effort === "max" ? "xhigh" : effort });
    }
  }, [threadKey, running, ordinal, modelKey, effort, hasError]);

  return <div ref={stageRef} className="optical-mascot" aria-hidden="true" />;
}
