import { readOpticalConfig } from "./config";

const SONAR_ATTR = "data-optical-sonar";
const SONAR_HOLD_MS = 720;
const sonarTimers = new WeakMap<Element, number>();

/** One sonar ping on the turn a jump landed on, so the eye finds it. Skipped with motion off. */
export function pulseTimelineTarget(scope: ParentNode | null | undefined, rowId: string): void {
  if (!scope || readOpticalConfig().motionLevel === "off") return;
  const row = scope.querySelector(`[data-timeline-row-id="${CSS.escape(rowId)}"]`);
  const target = row?.querySelector("[data-user-message-bubble]") ?? row;
  if (!target) return;
  const pending = sonarTimers.get(target);
  if (pending !== undefined) window.clearTimeout(pending);
  // Restarting the attribute restarts the animation when the same turn is picked twice.
  target.removeAttribute(SONAR_ATTR);
  void (target as HTMLElement).offsetWidth;
  target.setAttribute(SONAR_ATTR, "1");
  sonarTimers.set(
    target,
    window.setTimeout(() => {
      sonarTimers.delete(target);
      target.removeAttribute(SONAR_ATTR);
    }, SONAR_HOLD_MS),
  );
}
