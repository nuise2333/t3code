import { getMotionTier, springLinear } from "./motionEngine";

const ROW_SELECTOR = '[data-testid="sidebar-row-card"]';
const FADE_MS = 250;

/**
 * When the current sidebar thread changes, a pill slides from the old row to the new one and
 * fades as it lands, so the eye follows the switch. Watches only `aria-current` on sidebar rows
 * and paints nothing between switches.
 */
export function bindSidebarGlide(): () => void {
  let current: Element | null = document.querySelector(`${ROW_SELECTOR}[aria-current="page"]`);
  let pill: HTMLElement | null = null;

  const glide = (from: DOMRect, to: Element, fromRunning: boolean) => {
    const target = to.getBoundingClientRect();
    if (target.width === 0 || from.width === 0) return;
    const dx = from.left - target.left;
    const dy = from.top - target.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    pill?.remove();
    const element = document.createElement("div");
    element.className = "optical-sidebar-glide";
    if (fromRunning) element.dataset.fromRunning = "1";
    element.setAttribute("aria-hidden", "true");
    Object.assign(element.style, {
      left: `${target.left}px`,
      top: `${target.top}px`,
      width: `${target.width}px`,
      height: `${target.height}px`,
    });
    document.body.append(element);
    pill = element;
    const spring = springLinear("indicator");
    const sx = from.width / target.width;
    const sy = from.height / target.height;
    element.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})` },
        { transform: "none" },
      ],
      { duration: spring.durationMs, easing: spring.easing, fill: "both" },
    );
    element
      .animate([{ opacity: 0.96 }, { opacity: 0.92, offset: 0.72 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      })
      .finished.then(
        () => {
          element.remove();
          if (pill === element) pill = null;
        },
        () => element.remove(),
      );
  };

  const observer = new MutationObserver((records) => {
    if (!records.some((record) => (record.target as Element).matches?.(ROW_SELECTOR))) return;
    // A brand-new row mounts already current, so only the old row's change is observed; ask the
    // document which row is current now instead of reading it off the records.
    const next = document.querySelector(`${ROW_SELECTOR}[aria-current="page"]`);
    if (!next || next === current) return;
    const previous = current;
    current = next;
    const tier = getMotionTier();
    if (tier !== "standard" && tier !== "ultra") return;
    if (!previous?.isConnected || document.hidden) return;
    glide(
      previous.getBoundingClientRect(),
      next,
      previous.getAttribute("data-optical-row-running") === "1",
    );
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-current"],
  });

  return () => {
    observer.disconnect();
    pill?.remove();
    pill = null;
  };
}
