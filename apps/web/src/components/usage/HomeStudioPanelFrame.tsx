import "./homeStudioPanel.css";

import type { ReactNode } from "react";

import { Skeleton } from "../ui/skeleton";

// Shared by the loaded Overview tab and its skeleton so swapping them never moves the headline.
export const HOME_STUDIO_OVERVIEW_CLASS =
  "flex flex-col gap-2 @sm/home-studio:flex-row @sm/home-studio:items-center @sm/home-studio:gap-3";
// Whole-pixel cells: 27 columns of 8px (10px in the full-width panel) with 2px gaps.
export const HOME_STUDIO_HEAT_SIZE_CLASS =
  "w-full @sm/home-studio:w-67 @sm/home-studio:flex-none @[30rem]/home-studio:w-80.5";
export const HOME_STUDIO_STAT_LIST_CLASS =
  "grid min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-1 @sm/home-studio:grid-cols-1 @sm/home-studio:gap-y-0";
export const HOME_STUDIO_FOOTNOTE_CLASS = "h-4 [@media(height<50rem)]:hidden";

/**
 * The draft hero stacks above a centred composer, so the panel is sized to the space between the
 * top bar and the composer instead of pushing the headline off screen. homeStudioPanel.css holds
 * the height cap and the room left for the mascots; short windows drop the panel.
 */
export function HomeStudioPanelFrame({
  entrance = false,
  children,
}: {
  readonly entrance?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-home-studio="lane"
      className="@container/home-studio-lane pointer-events-none flex w-full justify-center [@media(height<48rem)]:hidden"
    >
      <section
        aria-label="Usage overview"
        data-home-studio="panel"
        data-home-studio-motion={entrance ? "rise" : undefined}
        className="@container/home-studio pointer-events-auto mt-3 flex w-[520px] max-w-full flex-col gap-2 overflow-x-hidden overflow-y-auto rounded-xl border bg-card/80 p-3 text-left shadow-xs/5 select-none"
      >
        {children}
      </section>
    </div>
  );
}

export function HomeStudioStatsSkeleton() {
  return (
    <>
      <div className={HOME_STUDIO_OVERVIEW_CLASS}>
        <Skeleton shape="card" className={`aspect-[27/7] ${HOME_STUDIO_HEAT_SIZE_CLASS}`} />
        <div className={HOME_STUDIO_STAT_LIST_CLASS}>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex h-3.5 items-center justify-between gap-2">
              <Skeleton className="h-2 w-14" />
              <Skeleton className="h-2 w-8" />
            </div>
          ))}
        </div>
      </div>
      <div className={`flex items-center ${HOME_STUDIO_FOOTNOTE_CLASS}`}>
        <Skeleton className="h-2 w-44" />
      </div>
    </>
  );
}

/** Suspense fallback while the panel module loads; matches the loaded panel's first rows. */
export function HomeStudioPanelSkeleton() {
  return (
    <HomeStudioPanelFrame>
      <div className="flex items-center justify-between gap-3">
        <Skeleton shape="card" className="h-7 w-52" />
        <Skeleton shape="card" className="h-7 w-28" />
      </div>
      <HomeStudioStatsSkeleton />
    </HomeStudioPanelFrame>
  );
}
