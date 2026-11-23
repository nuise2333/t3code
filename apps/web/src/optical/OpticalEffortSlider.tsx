import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import {
  ambientLayerOpacity,
  isDarkTheme,
  isOpticalReducedMotion,
  readOpticalConfig,
  useOpticalConfig,
} from "./config";
import { mountCrystalPrismBar } from "./crystalPrismCore";
import {
  EFFORT_STARS,
  clamp01,
  detentTargetIndex,
  effortEnergyStart,
  effortMotionParams,
  type EffortMotionState,
  energyForPct,
  fillBackgroundFor,
  indexFromPct,
  motionSettled,
  motionStep,
  pctFromIndex,
  releaseIndexFor,
  starLayerOpacity,
  starTiming,
  valueColorFor,
  visibleStarCount,
} from "./effortSlider";

export interface OpticalEffortLevel {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean | undefined;
}

interface PointerSample {
  pct: number;
  at: number;
  speed: number;
}

/**
 * The reasoning-effort track: a spring-driven knob over a blue-to-violet fill that fills with
 * drifting stars as effort rises. Auto turns the track into a liquid crystal bar.
 */
export function OpticalEffortSlider(props: {
  title: string;
  /** Shows `title` on the left of the slider header, opposite the current level. */
  showTitle?: boolean;
  levels: ReadonlyArray<OpticalEffortLevel>;
  /** The picked level, or null when Auto holds it or the level is not one of `levels`. */
  value: string | null;
  auto: { readonly active: boolean; readonly onPick: () => void } | null;
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const { levels, onPick } = props;
  const config = useOpticalConfig();
  const count = levels.length;
  const autoActive = props.auto?.active === true;
  const valueIndex = levels.findIndex((level) => level.id === props.value);
  const settledIndex = valueIndex >= 0 ? valueIndex : 0;
  // The level under the knob while dragging; the picked level otherwise.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const shownIndex = dragIndex ?? settledIndex;
  const levelIds = levels.map((level) => level.id);
  const energyStart = effortEnergyStart(levelIds);
  const hasOffFirst = energyStart > 0;
  const tone = config.spectrum;
  const motionOff = isOpticalReducedMotion(config);
  const shownPct = pctFromIndex(shownIndex, count);
  const shownEnergy = motionOff || autoActive ? 0 : energyForPct(shownPct, energyStart);
  const starCount = visibleStarCount(shownEnergy);
  const isTop = count > 1 && shownIndex === count - 1;

  const trackRef = useRef<HTMLDivElement>(null);
  const crystalHostRef = useRef<HTMLSpanElement>(null);
  const motion = useRef<EffortMotionState>({ x: shownPct, v: 0, target: shownPct });
  const frame = useRef<number | null>(null);
  const lastFrameAt = useRef(0);
  const drag = useRef<{ index: number; sample: PointerSample } | null>(null);

  const paintParams = useRef({ energyStart, tone, motionOff });

  const paint = (pct: number) => {
    const track = trackRef.current;
    if (!track) return;
    const { energyStart: start, tone: fillTone, motionOff: still } = paintParams.current;
    track.style.setProperty("--effort-p", pct.toFixed(4));
    track.style.setProperty("--effort-fill-bg", fillBackgroundFor(pct, start, fillTone));
    const energy = still ? 0 : energyForPct(pct, start);
    track.style.setProperty("--effort-energy", energy.toFixed(3));
  };

  const tick = (now: number) => {
    frame.current = null;
    const params = effortMotionParams(readOpticalConfig().motionLevel);
    const dt = lastFrameAt.current > 0 ? (now - lastFrameAt.current) / 1000 : 1 / 60;
    lastFrameAt.current = now;
    motionStep(motion.current, dt, params);
    paint(motion.current.x);
    if (!motionSettled(motion.current, params)) {
      frame.current = requestAnimationFrame(tick);
    } else {
      motion.current.x = motion.current.target;
      motion.current.v = 0;
      lastFrameAt.current = 0;
      paint(motion.current.x);
    }
  };

  const glideTo = (pct: number) => {
    motion.current.target = clamp01(pct);
    if (frame.current === null) {
      lastFrameAt.current = 0;
      frame.current = requestAnimationFrame(tick);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the imperative knob spring when the picked level or its colors change; the spring helpers read refs
  useEffect(() => {
    paintParams.current = { energyStart, tone, motionOff };
    paint(motion.current.x);
    if (drag.current) return;
    glideTo(pctFromIndex(settledIndex, count));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the spring helpers read refs; these values are what retarget it
  }, [settledIndex, count, tone, energyStart, motionOff]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the spring's pending frame on unmount
  useEffect(
    () => () => {
      // Clearing the handle lets a remount (StrictMode replays effects) schedule frames again.
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the frame ref is read at unmount on purpose
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the crystal bar's GL context and frame loop while Auto holds the track; it reads live config itself
  useEffect(() => {
    const host = crystalHostRef.current;
    if (!autoActive || !host) return;
    // A fresh canvas per mount: disposing the bar loses its GL context, and a canvas hands back
    // that same lost context forever.
    const canvas = document.createElement("canvas");
    canvas.className = "optical-effort__crystal";
    canvas.setAttribute("aria-hidden", "true");
    host.append(canvas);
    const readState = () => {
      const cfg = readOpticalConfig();
      const dark = isDarkTheme();
      return {
        isDark: dark,
        prismStrength: 1,
        ambientIntensity: ambientLayerOpacity(cfg.ambientIntensity),
        accentTone: cfg.spectrum === "follow" ? "default" : cfg.spectrum,
        reduceMotion: isOpticalReducedMotion(cfg),
        hideLock: false,
        fillRatio: -1,
      };
    };
    const bar = mountCrystalPrismBar(canvas, {
      reduceMotion: readState().reduceMotion,
      getState: readState,
    });
    if (!bar) {
      canvas.remove();
      return;
    }
    let raf: number | null = null;
    let last = 0;
    const loop = (now: number) => {
      raf = null;
      bar.step(last > 0 ? Math.min(0.05, (now - last) / 1000) : 1 / 60);
      last = now;
      if (!bar.isIdle() && !document.hidden) raf = requestAnimationFrame(loop);
      else last = 0;
    };
    const wakeLoop = () => {
      if (raf === null) raf = requestAnimationFrame(loop);
    };
    const onMove = (event: globalThis.PointerEvent) => {
      bar.setPointerClient(event.clientX, event.clientY);
      wakeLoop();
    };
    const onLeave = () => {
      bar.setPointerClient(-9999, -9999);
      wakeLoop();
    };
    bar.wake();
    wakeLoop();
    // The near-field glow follows the pointer from outside the bar too.
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      if (raf !== null) cancelAnimationFrame(raf);
      bar.dispose();
      canvas.remove();
    };
  }, [autoActive]);

  const pctAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const radius = rect.height / 2;
    return clamp01((clientX - rect.left - radius) / Math.max(1, rect.width - radius * 2));
  };

  const pick = (index: number) => {
    const level = levels[index];
    if (!level) return;
    glideTo(pctFromIndex(index, count));
    if (autoActive || level.id !== props.value) onPick(level.id);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (props.disabled || count <= 1 || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const pct = pctAt(event.clientX);
    const index = autoActive ? indexFromPct(pct, count) : detentTargetIndex(shownIndex, pct, count);
    drag.current = { index, sample: { pct, at: event.timeStamp, speed: 0 } };
    setDragIndex(index);
    glideTo(pct);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const pct = pctAt(event.clientX);
    const dt = (event.timeStamp - state.sample.at) / 1000;
    if (dt > 0) {
      const raw = (pct - state.sample.pct) / dt;
      state.sample = { pct, at: event.timeStamp, speed: state.sample.speed * 0.55 + raw * 0.45 };
    }
    const index = detentTargetIndex(state.index, pct, count);
    if (index !== state.index) {
      state.index = index;
      setDragIndex(index);
    }
    glideTo(pct);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    setDragIndex(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!commit) {
      glideTo(pctFromIndex(settledIndex, count));
      return;
    }
    const idle = (event.timeStamp - state.sample.at) / 1000;
    pick(releaseIndexFor(state.sample.pct, state.sample.speed, idle, count));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled || count <= 1 || event.altKey || event.ctrlKey || event.metaKey) return;
    const defaultIndex = Math.max(
      0,
      levels.findIndex((level) => level.isDefault),
    );
    const next =
      event.key === "ArrowRight"
        ? autoActive
          ? defaultIndex
          : Math.min(count - 1, shownIndex + 1)
        : event.key === "ArrowLeft"
          ? // At the bottom, Left leaves the column for the model list.
            autoActive || shownIndex === 0
            ? null
            : shownIndex - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    pick(next);
  };

  const shownLevel = levels[shownIndex];
  const valueColor = autoActive
    ? null
    : valueColorFor(shownIndex, count, hasOffFirst && shownIndex === 0, hasOffFirst, tone);

  return (
    <div
      className="optical-effort"
      data-auto={autoActive ? "1" : undefined}
      data-energy={shownEnergy > 0 ? "1" : "0"}
    >
      <div className="optical-effort__head">
        {props.showTitle ? <span className="optical-effort__title">{props.title}</span> : null}
        <span className={props.showTitle ? "optical-effort__right" : "contents"}>
          {props.auto && !autoActive ? (
            <button
              type="button"
              className="optical-effort__auto"
              disabled={props.disabled}
              onClick={props.auto.onPick}
            >
              Auto
            </button>
          ) : null}
          <span
            // Remounts per level so the rise plays once on each change.
            key={autoActive ? "auto" : shownIndex}
            className={cn(
              "optical-effort__value",
              autoActive && "is-auto",
              isTop && !motionOff && "is-glowing",
            )}
            style={
              valueColor
                ? ({ color: valueColor, "--effort-glow": valueColor } as CSSProperties)
                : undefined
            }
            aria-hidden="true"
          >
            {autoActive ? "Auto" : (shownLevel?.label ?? "")}
          </span>
        </span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        aria-label={props.title}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={shownIndex}
        aria-valuetext={autoActive ? "Auto" : shownLevel?.label}
        aria-disabled={props.disabled ? true : undefined}
        tabIndex={0}
        // Focus lands here after a model pick; Up and Down move to the next row.
        data-effort-level
        data-effort-row
        className={cn("optical-effort__track", props.disabled && "is-locked")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onKeyDown={onKeyDown}
      >
        {autoActive ? (
          <span ref={crystalHostRef} className="optical-effort__crystal-host" aria-hidden="true" />
        ) : (
          <>
            <div className="optical-effort__fill" />
            <div className="optical-effort__energy">
              <div className="optical-effort__sweep" />
            </div>
            <div
              className="optical-effort__stars"
              style={{ opacity: starLayerOpacity(shownEnergy) }}
            >
              {EFFORT_STARS.slice(0, starCount).map((star) => {
                const timing = starTiming(star.id, shownEnergy);
                return (
                  <span
                    key={star.id}
                    className="optical-effort__star"
                    style={
                      {
                        top: `${star.y}%`,
                        animationDuration: `${timing.duration.toFixed(3)}s`,
                        animationDelay: `${timing.delay.toFixed(3)}s`,
                        "--effort-star-b": star.brightness,
                      } as CSSProperties
                    }
                  />
                );
              })}
            </div>
            <div className="optical-effort__ticks" aria-hidden="true">
              {levels.map((level, index) => (
                <span
                  key={level.id}
                  className={cn("optical-effort__tick", index < shownIndex && "is-on")}
                  style={{ "--effort-tick": pctFromIndex(index, count) } as CSSProperties}
                />
              ))}
            </div>
            <div className="optical-effort__knob" />
          </>
        )}
      </div>
    </div>
  );
}
