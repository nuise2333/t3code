import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { observeResize } from "~/lib/observeResize";
import { isMacPlatform } from "~/lib/utils";

import { ReaderOutline } from "./ReaderOutline";
import { observeCurrentHeading, observeHeadings, type ReaderHeading } from "./readerHeadings";
import {
  updateReaderOutlineSurface,
  useReaderOutlineOpenPreference,
  useReaderOutlineSurface,
} from "./readerOutlineStore";
import { attachReaderScroll, scrollReaderTo } from "./readerScroll";
import "./readerNavigation.css";

/** Below this width the outline floats over the page instead of taking a column. */
const OUTLINE_COLUMN_MIN_WIDTH = 760;

function isSelectAll(event: ReactKeyboardEvent) {
  const mac = isMacPlatform(navigator.platform);
  return (
    event.key.toLowerCase() === "a" &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}

function viewportOf(element: Element | null) {
  return element?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

/**
 * The scrolled reading view around a rendered document: paging keys, the reading position kept
 * per document, and the outline beside it. `surfaceKey` names it for its toolbar and for the
 * remembered position; without one it remembers nothing.
 */
export function ReaderSurface(props: {
  readonly surfaceKey?: string | undefined;
  readonly children: ReactNode;
}) {
  const fallbackKey = useId();
  const key = props.surfaceKey ?? `reader:${fallbackKey}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<ReadonlyArray<ReaderHeading>>([]);
  const [current, setCurrent] = useState(-1);
  const surface = useReaderOutlineSurface(key);
  const [preferOpen] = useReaderOutlineOpenPreference();
  const mode = surface?.isNarrow ? "overlay" : "column";
  const showsOutline =
    headings.length > 0 && (mode === "overlay" ? surface?.isOverlayOpen === true : preferOpen);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paging keys and the reading position read and set the laid-out scroll viewport, restored before the first paint
  useLayoutEffect(() => {
    const content = contentRef.current;
    const viewport = viewportOf(content);
    if (!content || !viewport) return;
    return attachReaderScroll({ viewport, content, positionKey: props.surfaceKey });
  }, [props.surfaceKey]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this reader for its toolbar and follows the rendered headings and the reader's width, which only the DOM knows
  useLayoutEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    const stopHeadings = observeHeadings(content, (next) => {
      setHeadings(next);
      updateReaderOutlineSurface(key, { hasHeadings: next.length > 0 });
    });
    const followWidth = () => {
      const isNarrow = root.clientWidth < OUTLINE_COLUMN_MIN_WIDTH;
      updateReaderOutlineSurface(key, isNarrow ? { isNarrow } : { isNarrow, isOverlayOpen: false });
    };
    followWidth();
    const stopResize = observeResize(root, followWidth);
    return () => {
      stopHeadings();
      stopResize();
      updateReaderOutlineSurface(key, null);
    };
  }, [key]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows which section is being read while the document scrolls, through one intersection observer
  useLayoutEffect(() => {
    const viewport = viewportOf(contentRef.current);
    if (!viewport || !showsOutline) return;
    return observeCurrentHeading(viewport, headings, setCurrent);
  }, [headings, showsOutline]);

  const closeOverlay = () => updateReaderOutlineSurface(key, { isOverlayOpen: false });

  const pick = (heading: ReaderHeading) => {
    const viewport = viewportOf(contentRef.current);
    if (!viewport) return;
    scrollReaderTo(viewport, heading.element);
    const editor = heading.element.closest<HTMLElement>('[contenteditable="true"]');
    if (editor) {
      // In the editor the caret goes to the heading, where typing continues.
      editor.focus({ preventScroll: true });
      window.getSelection()?.collapse(heading.element, 0);
    } else {
      viewport.focus({ preventScroll: true });
    }
    if (mode === "overlay") closeOverlay();
  };

  return (
    <div ref={rootRef} data-reader-surface={key}>
      <ScrollArea
        className="min-w-0 flex-1"
        viewportTabIndex={0}
        aria-keyshortcuts="Space Shift+Space PageDown PageUp"
        onPointerDown={mode === "overlay" && showsOutline ? closeOverlay : undefined}
        onKeyDown={(event) => {
          const content = contentRef.current;
          if (!content || !isSelectAll(event)) return;
          // React bubbles keys from portaled children (the image dialog) through this surface.
          if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) {
            return;
          }
          // The editor selects within itself.
          if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
          event.preventDefault();
          event.stopPropagation();
          window.getSelection()?.selectAllChildren(content);
        }}
      >
        <div ref={contentRef} data-reader-surface-content="">
          {props.children}
        </div>
      </ScrollArea>
      {showsOutline ? (
        <ReaderOutline
          headings={headings}
          current={current}
          mode={mode}
          onPick={pick}
          onDismiss={() => {
            closeOverlay();
            viewportOf(contentRef.current)?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}
