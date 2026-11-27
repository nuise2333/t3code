import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import { pdfDestinationPage } from "./pdfDocument";

const THUMBNAIL_WIDTH = 112;

export type PdfSidebarTab = "pages" | "bookmarks";

type OutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

function PdfThumbnail(props: {
  pdf: PDFDocumentProxy;
  index: number;
  ratio: number;
  rotation: number;
  active: boolean;
  root: HTMLElement | null;
  onPage: (index: number) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  const { pdf, index, rotation, root } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Paint a thumbnail only once it scrolls near the sidebar viewport.
  useEffect(() => {
    const node = button.current;
    if (!node || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { root, rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [root, seen]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Render the pdf.js page into the thumbnail canvas and release it on cleanup.
  useEffect(() => {
    if (!seen) return;
    let cancelled = false;
    let paint: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let loaded: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | undefined;
    void (async () => {
      const page = await pdf.getPage(index + 1);
      loaded = page;
      const target = canvas.current;
      if (cancelled || !target) return;
      const turn = (page.rotate + rotation) % 360;
      const natural = page.getViewport({ scale: 1, rotation: turn });
      const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / natural.width, rotation: turn });
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      target.width = Math.ceil(viewport.width * ratio);
      target.height = Math.ceil(viewport.height * ratio);
      paint = page.render({
        canvas: target,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
        background: "white",
      });
      await paint.promise;
    })().catch(() => {
      // A thumbnail that fails stays blank; the page itself reports the error.
    });
    return () => {
      cancelled = true;
      paint?.cancel();
      void Promise.allSettled([paint?.promise]).then(() => loaded?.cleanup());
    };
  }, [pdf, index, rotation, seen]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the current page's thumbnail scrolled into the sidebar as the reader moves.
  useEffect(() => {
    if (props.active) button.current?.scrollIntoView({ block: "nearest" });
  }, [props.active]);
  return (
    <button
      ref={button}
      type="button"
      aria-label={`Page ${index + 1}`}
      aria-current={props.active ? "page" : undefined}
      className="flex w-full flex-col items-center gap-1 rounded-md p-1.5 text-muted-foreground text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
      onClick={() => props.onPage(index)}
    >
      <canvas
        ref={canvas}
        className={cn(
          "block bg-white shadow-sm ring-1 ring-border",
          props.active && "ring-2 ring-primary",
        )}
        style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_WIDTH * props.ratio }}
      />
      <span className="tabular-nums">{index + 1}</span>
    </button>
  );
}

function OutlineList(props: {
  pdf: PDFDocumentProxy;
  items: readonly OutlineItem[];
  onPage: (index: number) => void;
}) {
  return (
    <ul className="flex flex-col">
      {props.items.map((item, position) => (
        // oxlint-disable-next-line react/no-array-index-key -- Bookmarks keep their order in the file and can share titles.
        <li key={position}>
          <button
            type="button"
            className="w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            onClick={() => {
              void pdfDestinationPage(props.pdf, item.dest).then((index) => {
                if (index !== null) props.onPage(index);
              });
            }}
          >
            {item.title || "Untitled"}
          </button>
          {item.items.length ? (
            <div className="pl-3">
              <OutlineList pdf={props.pdf} items={item.items} onPage={props.onPage} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function PdfSidebar(props: {
  pdf: PDFDocumentProxy;
  ratios: readonly number[];
  rotation: number;
  current: number;
  tab: PdfSidebarTab;
  onTab: (tab: PdfSidebarTab) => void;
  onPage: (index: number) => void;
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [outline, setOutline] = useState<readonly OutlineItem[] | null>(null);
  const { pdf } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load the document's bookmarks from pdf.js, which answers asynchronously.
  useEffect(() => {
    let cancelled = false;
    void pdf
      .getOutline()
      .then((items) => {
        if (!cancelled) setOutline(items ?? []);
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pdf]);
  return (
    <div className="flex w-36 shrink-0 flex-col border-r border-border/60 bg-background">
      <div className="flex shrink-0 justify-center border-b border-border/60 p-1">
        <ToggleGroup
          value={[props.tab]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "pages" || next === "bookmarks") props.onTab(next);
          }}
        >
          <Toggle value="pages">Pages</Toggle>
          <Toggle value="bookmarks">Bookmarks</Toggle>
        </ToggleGroup>
      </div>
      <div ref={setRoot} className="min-h-0 flex-1 overflow-y-auto p-1">
        {props.tab === "pages" ? (
          props.ratios.map((ratio, index) => (
            <PdfThumbnail
              // oxlint-disable-next-line react/no-array-index-key -- A page is its position in the document.
              key={index}
              pdf={pdf}
              index={index}
              ratio={ratio}
              rotation={props.rotation}
              active={index === props.current}
              root={root}
              onPage={props.onPage}
            />
          ))
        ) : outline === null ? null : outline.length ? (
          <OutlineList pdf={pdf} items={outline} onPage={props.onPage} />
        ) : (
          <p className="px-2 py-3 text-muted-foreground text-xs">This PDF has no bookmarks.</p>
        )}
      </div>
    </div>
  );
}
