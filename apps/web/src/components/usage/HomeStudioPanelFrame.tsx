import "./homeStudioPanel.css";

import type { ReactNode } from "react";

import { Skeleton } from "../ui/skeleton";

/**
 * Left-aligned home studio panel under the draft hero headline. Sizing and compact fallbacks live
 * in homeStudioPanel.css so the skeleton and loaded views share identical geometry without inner
 * scrollbars.
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
      className="@container/home-studio-lane pointer-events-none flex w-full justify-start"
    >
      <section
        aria-label="Usage overview"
        data-home-studio="panel"
        data-home-studio-motion={entrance ? "rise" : undefined}
        className="@container/home-studio pointer-events-auto mt-3 flex max-w-full flex-col rounded-2xl border border-border/60 bg-card/85 text-left shadow-xs/5 backdrop-blur-md select-none sm:mt-4"
      >
        {children}
      </section>
    </div>
  );
}

export function HomeStudioStatsSkeleton() {
  return (
    <>
      <div data-home-studio="overview">
        <div data-home-studio="stats">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} data-home-studio="stat-card">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-12" />
            </div>
          ))}
        </div>
        <Skeleton shape="card" data-home-studio="heatmap-skeleton" />
      </div>
      <div data-home-studio="footnote" className="flex items-center">
        <Skeleton className="h-3 w-56" />
      </div>
    </>
  );
}

/** Suspense fallback while the panel module loads; matches the loaded panel's structure. */
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
