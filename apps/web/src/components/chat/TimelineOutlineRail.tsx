import { ChevronsDownUpIcon, MenuIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveTimelineMinimapPreview, type TimelineMinimapItem } from "./timelineMinimapItems";

const HOVER_CLOSE_DELAY_MS = 160;
const COLLAPSED_FEEDBACK_MS = 1200;

export function TimelineOutlineRail({
  items,
  currentIndex,
  hasExpandedSteps = false,
  onCollapseAllSteps,
  onSelect,
  onOpenChange,
}: {
  readonly items: ReadonlyArray<TimelineMinimapItem>;
  readonly currentIndex: number | null;
  readonly hasExpandedSteps?: boolean | undefined;
  readonly onCollapseAllSteps?: (() => void) | undefined;
  readonly onSelect: (item: TimelineMinimapItem) => void;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [justCollapsed, setJustCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const setOpenState = (nextOpen: boolean, nextPinned = nextOpen ? pinned : false) => {
    clearCloseTimer();
    setOpen(nextOpen);
    setPinned(nextPinned);
    onOpenChange?.(nextOpen);
    if (!nextOpen) {
      setFilterQuery("");
    }
  };

  const scheduleHoverClose = () => {
    clearCloseTimer();
    if (pinned) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (rootRef.current?.contains(document.activeElement)) return;
      setOpen(false);
      setFilterQuery("");
      onOpenChange?.(false);
    }, HOVER_CLOSE_DELAY_MS);
  };

  const dismissOutline = useEffectEvent(() => setOpenState(false, false));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismisses the floating outline popover on outside pointer clicks and Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      dismissOutline();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      dismissOutline();
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears pending hover-close and feedback timers on unmount
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (feedbackTimerRef.current !== null) {
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    },
    [],
  );

  if (items.length === 0) return null;

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const indexedEntries = items.map((item, index) => {
    const preview = resolveTimelineMinimapPreview(item);
    return {
      item,
      index,
      turnNumber: index + 1,
      label: preview?.userText ?? "User message",
    };
  });
  const filteredEntries =
    normalizedQuery.length === 0
      ? indexedEntries
      : indexedEntries.filter(
          (entry) =>
            entry.label.toLowerCase().includes(normalizedQuery) ||
            `#${entry.turnNumber}`.includes(normalizedQuery),
        );

  const handleSelectEntry = (item: TimelineMinimapItem) => {
    onSelect(item);
    setOpenState(false, false);
  };

  const handleCollapseAll = () => {
    if (!onCollapseAllSteps) return;
    onCollapseAllSteps();
    setJustCollapsed(true);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setJustCollapsed(false);
    }, COLLAPSED_FEEDBACK_MS);
  };

  const focusListItem = (index: number) => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-outline-item-id]");
    if (!buttons || buttons.length === 0) return;
    const bounded = Math.max(0, Math.min(buttons.length - 1, index));
    buttons[bounded]?.focus();
  };

  const handlePointerEnter = () => {
    clearCloseTimer();
    if (!open) {
      setOpen(true);
      onOpenChange?.(true);
    }
  };

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-50"
      data-testid="timeline-outline-rail"
    >
      <div
        className="pointer-events-auto absolute top-2.5 left-2.5"
        onPointerEnter={handlePointerEnter}
        onPointerLeave={scheduleHoverClose}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={triggerRef}
                type="button"
                size="icon-xs"
                variant={open ? "secondary" : "ghost-muted"}
                aria-label="Conversation outline"
                aria-expanded={open}
                aria-haspopup="true"
                onClick={() => {
                  if (open && pinned) {
                    setOpenState(false, false);
                  } else {
                    setOpenState(true, true);
                    window.requestAnimationFrame(() => searchInputRef.current?.focus());
                  }
                }}
              />
            }
          >
            <MenuIcon aria-hidden="true" className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">Conversation outline</TooltipPopup>
        </Tooltip>
      </div>

      {open ? (
        <div
          role="region"
          aria-label="Conversation outline"
          data-testid="timeline-outline-popover"
          onPointerEnter={handlePointerEnter}
          onPointerLeave={scheduleHoverClose}
          className="dropdown-glass pointer-events-auto absolute top-2.5 left-9 flex flex-col gap-1.5 rounded-xl border border-border/80 p-2 text-popover-foreground shadow-xl before:absolute before:inset-y-0 before:-left-3 before:w-3 before:content-['']"
          style={{ width: 268, maxHeight: "min(368px, calc(100% - 28px))" }}
        >
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="truncate text-xs font-semibold text-foreground tabular-nums">
              Outline &middot; {items.length}
            </span>
            {onCollapseAllSteps ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                disabled={!hasExpandedSteps && !justCollapsed}
                onClick={handleCollapseAll}
              >
                <ChevronsDownUpIcon aria-hidden="true" className="size-3" />
                {justCollapsed ? "Collapsed" : "Collapse all steps"}
              </Button>
            ) : null}
          </div>

          <input
            ref={searchInputRef}
            type="search"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder="Filter questions..."
            aria-label="Filter questions"
            className="h-7 w-full rounded-md border border-border/80 bg-background/70 px-2 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const first = filteredEntries[0];
                if (first) {
                  event.preventDefault();
                  handleSelectEntry(first.item);
                }
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                focusListItem(0);
              }
            }}
          />

          <div
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden"
            style={{ maxHeight: 272 }}
          >
            {filteredEntries.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">
                No matching questions
              </p>
            ) : (
              filteredEntries.map((entry, listIndex) => {
                const isCurrent = currentIndex === entry.index;
                return (
                  <button
                    key={entry.item.id}
                    type="button"
                    data-outline-item-id={entry.item.id}
                    data-active={isCurrent ? "true" : undefined}
                    aria-current={isCurrent ? "location" : undefined}
                    onClick={() => handleSelectEntry(entry.item)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        focusListItem(listIndex + 1);
                      } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        if (listIndex === 0) {
                          searchInputRef.current?.focus();
                        } else {
                          focusListItem(listIndex - 1);
                        }
                      }
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs leading-4 transition-colors hover:bg-accent/70 hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                      isCurrent
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-foreground/85",
                    )}
                  >
                    <span
                      className={cn(
                        "shrink-0 font-mono text-2xs tabular-nums",
                        isCurrent ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      #{entry.turnNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
