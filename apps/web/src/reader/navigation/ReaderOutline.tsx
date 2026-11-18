import { useLayoutEffect, useRef } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";

import { headingKey, type ReaderHeading } from "./readerHeadings";

const MAX_DEPTH = 5;

function keepVisible(item: HTMLElement) {
  const scroller = item.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  if (rect.top < view.top) scroller.scrollTop -= view.top - rect.top;
  else if (rect.bottom > view.bottom) scroller.scrollTop += rect.bottom - view.bottom;
}

export function ReaderOutline(props: {
  readonly headings: ReadonlyArray<ReaderHeading>;
  readonly current: number;
  readonly mode: "column" | "overlay";
  readonly onPick: (heading: ReaderHeading) => void;
  readonly onDismiss: () => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const topLevel = Math.min(...props.headings.map((heading) => heading.level));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the outline's own list so the section being read stays in view as the document scrolls
  useLayoutEffect(() => {
    const item = listRef.current?.children[props.current]?.firstElementChild;
    if (item instanceof HTMLElement) keepVisible(item);
  }, [props.current]);

  return (
    <nav
      data-reader-outline=""
      data-mode={props.mode}
      aria-label="Outline"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || props.mode !== "overlay") return;
        event.preventDefault();
        event.stopPropagation();
        props.onDismiss();
      }}
    >
      <div data-reader-outline-title="">Outline</div>
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <ol ref={listRef} data-reader-outline-list="">
          {props.headings.map((heading, index) => (
            <li key={headingKey(heading.element)}>
              <button
                type="button"
                data-reader-outline-item=""
                data-depth={Math.min(heading.level - topLevel, MAX_DEPTH)}
                aria-current={index === props.current ? "location" : undefined}
                onClick={() => props.onPick(heading)}
              >
                {heading.text}
              </button>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </nav>
  );
}
