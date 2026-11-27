import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { PasswordResponses, TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Maximize2Icon,
  MinusIcon,
  PanelLeftIcon,
  PlusIcon,
  RotateCwIcon,
  ScanIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { observeResize } from "~/lib/observeResize";
import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { readBoundedDocument } from "./readBoundedDocument";
import { openPdf } from "./pdfDocument";
import {
  currentPdfPage,
  pdfFindIncludes,
  pdfFindMatchRuns,
  pdfLayout,
  pdfPageScrollTop,
  pdfSpreadColumns,
  pdfPageText,
  pdfPageWidth,
  pdfRestoredScrollTop,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  rotatedPdfRatios,
  stepPdfZoom,
  visiblePdfPages,
  type PdfSpread,
  type PdfZoom,
} from "./pdfLayout";
import PdfSidebar, { type PdfSidebarTab } from "./PdfSidebar";
import "./pdfViewer.css";

const MAX_PAGES = 2000;
const MAX_FIND_TEXT = 4 * 1024 * 1024;

const SPREADS: readonly { value: PdfSpread; label: string }[] = [
  { value: "none", label: "Single pages" },
  { value: "odd", label: "Two pages" },
  { value: "even", label: "Book" },
];

const MAX_POSITIONS = 50;
type PdfPosition = PdfViewState & { width: number; ratios: readonly number[] };
// Thread switches unmount the preview; retain only the most recent documents.
const positions = new Map<string, PdfPosition>();

export type PdfViewState = {
  page: number;
  offset: number;
  zoom: PdfZoom;
  left: number;
};

function PdfPage(props: {
  document: PDFDocumentProxy;
  index: number;
  width: number;
  rotation: number;
  query: string;
  onSize: (index: number, ratio: number) => void;
  onError: (error: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const { document: pdf, index, width, rotation, onSize, onError } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Render the PDF page canvas and text layer, cancelling tasks and releasing pdf.js page resources on cleanup.
  useEffect(() => {
    let cancelled = false;
    let paint: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let layer: TextLayer | undefined;
    let loadedPage: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | undefined;
    void (async () => {
      const page = await pdf.getPage(index + 1);
      loadedPage = page;
      if (cancelled || !canvas.current || !text.current) {
        page.cleanup();
        return;
      }
      const natural = page.getViewport({ scale: 1 });
      onSize(index, natural.height / natural.width);
      const turn = (page.rotate + rotation) % 360;
      const turned = page.getViewport({ scale: 1, rotation: turn });
      const viewport = page.getViewport({ scale: width / turned.width, rotation: turn });
      const ratio = Math.min(
        2,
        window.devicePixelRatio || 1,
        Math.sqrt((8 * 1024 * 1024) / (viewport.width * viewport.height)),
      );
      canvas.current.width = Math.ceil(viewport.width * ratio);
      canvas.current.height = Math.ceil(viewport.height * ratio);
      paint = page.render({
        canvas: canvas.current,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
        background: "white",
      });
      text.current.replaceChildren();
      text.current.style.setProperty("--total-scale-factor", String(viewport.scale));
      layer = new TextLayer({
        container: text.current,
        viewport,
        textContentSource: page.streamTextContent(),
      });
      await Promise.all([paint.promise, layer.render()]);
    })().catch((cause: unknown) => {
      if (!cancelled)
        onError(cause instanceof Error ? cause.message : "This PDF page could not render.");
    });
    return () => {
      cancelled = true;
      paint?.cancel();
      layer?.cancel();
      // Release operator lists when virtual pages leave the viewport.
      void Promise.allSettled([paint?.promise]).then(() => loadedPage?.cleanup());
    };
  }, [pdf, index, width, rotation, onSize, onError]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Highlight pdf.js-owned text nodes and observe asynchronous text layer mutations for the current search query.
  useEffect(() => {
    const node = text.current;
    if (!node) return;
    const mark = () => {
      const elements = Array.from(node.querySelectorAll('span[role="presentation"], br'));
      const hits = pdfFindMatchRuns(
        elements.map((element) => (element.tagName === "BR" ? "\n" : (element.textContent ?? ""))),
        props.query,
      );
      elements.forEach((element, index) => element.classList.toggle("pdf-find-match", hits[index]));
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [props.query]);
  return (
    <>
      <canvas ref={canvas} aria-label={`Page ${index + 1}`} className="block h-full w-full" />
      <div ref={text} data-pdf-text-layer />
    </>
  );
}

export default function PdfViewer(props: {
  src: string;
  title: string;
  positionKey?: string;
  initialView?: PdfViewState;
  onViewChange?: (view: PdfViewState) => void;
}) {
  const [savedPosition] = useState(() =>
    props.positionKey === undefined ? undefined : positions.get(props.positionKey),
  );
  const [initialView] = useState<PdfViewState>(
    () => savedPosition ?? props.initialView ?? { page: 0, offset: 0, zoom: null, left: 0 },
  );
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [ratios, setRatios] = useState<readonly number[]>([]);
  const [zoom, setZoom] = useState(initialView.zoom);
  const [firstPage, setFirstPage] = useState({ width: 612, height: 792 });
  const [rotation, setRotation] = useState(0);
  const [spread, setSpread] = useState<PdfSpread>("none");
  const [sidebar, setSidebar] = useState<PdfSidebarTab | null>(null);
  const [lastSidebar, setLastSidebar] = useState<PdfSidebarTab>("pages");
  const [password, setPassword] = useState<{
    update: (password: string) => void;
    wrong: boolean;
    checking: boolean;
  } | null>(null);
  const [passwordText, setPasswordText] = useState("");
  const [viewport, setViewport] = useState({ width: 600, height: 800 });
  const [scrollTop, setScrollTop] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[]>([]);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [match, setMatch] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const zoomAnchor = useRef<{ page: number; offset: number; width: number } | null>(null);
  const initialPage = initialView.page;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the PDF fetch, load timeout, and pdf.js document task across source changes, retries, and unmounts.
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let task: ReturnType<typeof openPdf> | undefined;
    const timeout = setTimeout(() => {
      setError("This PDF took too long to load. Try again.");
      controller.abort();
      void task?.destroy();
    }, 30_000);
    void readBoundedDocument(
      props.src,
      controller.signal,
      50 * 1024 * 1024,
      revision > 0 ? "reload" : "default",
    )
      .then(async (bytes) => {
        controller.signal.throwIfAborted();
        task = openPdf(bytes);
        task.onPassword = (update: (password: string) => void, reason: number) => {
          clearTimeout(timeout);
          setPassword({
            update,
            wrong: reason === PasswordResponses.INCORRECT_PASSWORD,
            checking: false,
          });
        };
        const document = await task.promise;
        if (document.numPages > MAX_PAGES)
          throw new Error("Preview limited to 2,000 pages. Save this PDF to read it in full.");
        const first = (await document.getPage(1)).getViewport({ scale: 1 });
        const sizes = await Promise.all(
          Array.from({ length: Math.min(initialPage + 1, document.numPages) }, async (_, index) => {
            const size = (await document.getPage(index + 1)).getViewport({ scale: 1 });
            return size.height / size.width;
          }),
        );
        if (controller.signal.aborted) return;
        setFirstPage({ width: first.width, height: first.height });
        setRatios(
          savedPosition?.ratios.length === document.numPages
            ? savedPosition.ratios
            : Array.from(
                { length: document.numPages },
                (_, index) => sizes[index] ?? first.height / first.width,
              ),
        );
        setPdf(document);
      })
      .catch((cause: unknown) => {
        if (!disposed && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Unable to open PDF.");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      void task?.destroy();
    };
  }, [props.src, revision, initialPage, savedPosition]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure the PDF viewport before paint and observe resizes for fit-width sizing and visible-page selection.
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const update = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    update();
    return observeResize(node, update);
  }, []);
  const shown = rotatedPdfRatios(ratios, rotation);
  const { scale, width } = pdfPageWidth(
    viewport,
    rotation % 180 === 0 ? firstPage.width : firstPage.height,
    zoom,
    pdfSpreadColumns(spread),
    shown.length ? Math.max(...shown) : 1,
  );
  const layout = pdfLayout(shown, width, spread, viewport.width);
  const current = currentPdfPage(layout, scrollTop);
  const visible = visiblePdfPages(shown, layout, scrollTop, viewport.height);
  // Stable callbacks let page canvases survive scroll and find updates.
  const [onSize] = useState(
    () => (index: number, ratio: number) =>
      setRatios((old) =>
        old[index] === ratio ? old : old.map((value, i) => (i === index ? ratio : value)),
      ),
  );
  const jumpToPage = useEffectEvent((index: number) => {
    scroll.current?.scrollTo({ top: pdfPageScrollTop(layout, index) });
  });
  const saveView = (node: HTMLDivElement, notify = true) => {
    const page = currentPdfPage(layout, node.scrollTop);
    if (!pdf) return;
    const view = {
      page,
      offset: Math.max(0, node.scrollTop - (layout.tops[page]! - 16)),
      zoom,
      left: node.scrollLeft,
    };
    if (notify) props.onViewChange?.(view);
    if (props.positionKey !== undefined) {
      positions.delete(props.positionKey);
      positions.set(props.positionKey, { ...view, width, ratios });
      const oldest = positions.keys().next();
      if (positions.size > MAX_POSITIONS && !oldest.done) positions.delete(oldest.value);
    }
  };
  const restoreView = useEffectEvent(() => {
    const node = scroll.current;
    if (!pdf || !node) return;
    node.scrollTo({
      top: pdfRestoredScrollTop(shown, width, initialView, savedPosition?.width, spread),
      left: initialView.left,
    });
    setScrollTop(node.scrollTop);
    saveView(node);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the saved PDF scroll position after the loaded document's page layout commits.
  useLayoutEffect(() => {
    if (pdf) restoreView();
  }, [pdf]);
  const showPage = (index: number) => {
    scroll.current?.scrollTo({ top: pdfPageScrollTop(layout, index) });
  };
  // Keeps the current page in view while the page size, turn, or arrangement changes.
  const anchorCurrentPage = (keepOffset: boolean) => {
    zoomAnchor.current = {
      page: current,
      offset: keepOffset ? (scroll.current?.scrollTop ?? 0) - (layout.tops[current]! - 16) : 0,
      width: keepOffset ? width : 0,
    };
  };
  const changeZoom = (value: PdfZoom) => {
    anchorCurrentPage(true);
    setZoom(value);
  };
  const toggleSidebar = () => {
    if (sidebar) setLastSidebar(sidebar);
    setSidebar(sidebar ? null : lastSidebar);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Restore the DOM scroll anchor after the new zoom width has committed to page layout.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    const node = scroll.current;
    if (!node || !pdf) return;
    if (anchor && (anchor.width === 0 || anchor.width !== width)) {
      node.scrollTo({
        top:
          layout.tops[anchor.page]! -
          16 +
          (anchor.width ? (anchor.offset * width) / anchor.width : 0),
      });
    }
    saveView(node, anchor !== null);
  });
  const firstMatch = matches[0];
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll to the first asynchronous search result after its measured page offsets have committed.
  useLayoutEffect(() => {
    if (firstMatch !== undefined) jumpToPage(firstMatch);
  }, [firstMatch]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Debounce pdf.js text extraction and cancel obsolete searches when the query or document changes.
  useEffect(() => {
    if (!pdf || !query.trim()) {
      // oxlint-disable-next-line react/set-state-in-effect -- A blank query cancels the previous search.
      setFinding(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setFinding(true);
      setFindError(null);
      setMatches([]);
      setMatch(0);
      void (async () => {
        const found: number[] = [];
        const sizes: number[] = [];
        let size = 0;
        for (let index = 0; index < pdf.numPages; index++) {
          const page = await pdf.getPage(index + 1);
          const pageSize = page.getViewport({ scale: 1 });
          sizes.push(pageSize.height / pageSize.width);
          const content = await page.getTextContent();
          if (cancelled) return;
          const text = pdfPageText(content.items);
          size += text.length;
          if (size > MAX_FIND_TEXT)
            throw new Error(
              "This PDF has too much text to search. Save it to search in another app.",
            );
          if (!pdfFindIncludes(text, query)) continue;
          found.push(index);
          if (found.length > 1) continue;
          // Pages up to the first hit are measured, so its jump lands before the scan finishes.
          setRatios((old) => [...sizes, ...old.slice(sizes.length)]);
          setMatches([index]);
        }
        if (cancelled) return;
        setRatios(sizes);
        setMatches(found);
      })()
        .catch((cause: unknown) => {
          if (!cancelled)
            setFindError(cause instanceof Error ? cause.message : "Could not search this PDF.");
        })
        .finally(() => {
          if (!cancelled) setFinding(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pdf, query]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1 text-xs">
        <FileSurfaceAction
          label={sidebar ? "Hide pages and bookmarks" : "Show pages and bookmarks"}
          pressed={sidebar !== null}
          disabled={!pdf}
          onPress={toggleSidebar}
        >
          <PanelLeftIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="mr-auto px-1 tabular-nums" aria-live="polite">
          {pdf ? `${current + 1} / ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"}` : "PDF"}
        </span>
        <FileSurfaceAction
          label="Previous page"
          disabled={!pdf || current === 0}
          onPress={() => showPage(current - 1)}
        >
          <ChevronUpIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Next page"
          disabled={!pdf || current + 1 >= pdf.numPages}
          onPress={() => showPage(current + 1)}
        >
          <ChevronDownIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Zoom out"
          disabled={scale <= PDF_MIN_ZOOM}
          onPress={() => changeZoom(stepPdfZoom(scale, -1))}
        >
          <MinusIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="min-w-14 text-center tabular-nums">
          {zoom === null
            ? "Fit width"
            : zoom === "page"
              ? "Fit page"
              : `${Math.round(scale * 100)}%`}
        </span>
        <FileSurfaceAction
          label="Zoom in"
          disabled={scale >= PDF_MAX_ZOOM}
          onPress={() => changeZoom(stepPdfZoom(scale, 1))}
        >
          <PlusIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Fit width"
          onPress={() => {
            changeZoom(null);
            scroll.current?.scrollTo({ left: 0 });
          }}
        >
          <ScanIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Fit page"
          onPress={() => {
            changeZoom("page");
            scroll.current?.scrollTo({ left: 0 });
          }}
        >
          <Maximize2Icon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Rotate clockwise"
          disabled={!pdf}
          onPress={() => {
            anchorCurrentPage(false);
            setRotation((value) => (value + 90) % 360);
          }}
        >
          <RotateCwIcon className="size-3.5" />
        </FileSurfaceAction>
        <div className="w-28">
          <Select
            value={spread}
            onValueChange={(value) => {
              if (value === null) return;
              anchorCurrentPage(false);
              setSpread(value);
            }}
          >
            <SelectTrigger aria-label="Page layout" size="xs">
              <SelectValue>{SPREADS.find((item) => item.value === spread)?.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {SPREADS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="w-28">
          <Input
            ref={find}
            size="compact"
            type="search"
            aria-label="Find in PDF"
            placeholder="Find in PDF"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatches([]);
              setFindError(null);
            }}
          />
        </div>
        {query ? (
          <>
            <span role="status">
              {finding
                ? "Searching…"
                : (findError ?? `${matches.length ? match + 1 : 0}/${matches.length}`)}
            </span>
            <FileSurfaceAction
              label="Next matching page"
              disabled={!matches.length}
              onPress={() => {
                const next = (match + 1) % matches.length;
                setMatch(next);
                showPage(matches[next]!);
              }}
            >
              <ChevronDownIcon className="size-3.5" />
            </FileSurfaceAction>
          </>
        ) : null}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        {pdf && sidebar ? (
          <PdfSidebar
            pdf={pdf}
            ratios={shown}
            rotation={rotation}
            current={current}
            tab={sidebar}
            onTab={setSidebar}
            onPage={showPage}
          />
        ) : null}
        <div
          ref={scroll}
          role="region"
          aria-label={props.title}
          tabIndex={0}
          className="relative min-h-0 min-w-0 w-full flex-1 overflow-auto scrollbar-gutter-stable bg-muted/40"
          onScroll={(event) => {
            const top = event.currentTarget.scrollTop;
            setScrollTop(top);
            saveView(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "f") {
              event.preventDefault();
              event.stopPropagation();
              find.current?.focus();
            }
          }}
        >
          {error ? (
            <FileSurfaceFailure
              message={error}
              onRetry={() => {
                setError(null);
                setPdf(null);
                setRevision((value) => value + 1);
              }}
            />
          ) : !pdf && password ? (
            <form
              className="mx-auto flex max-w-xs flex-col gap-2 px-4 py-10 text-sm"
              onSubmit={(event) => {
                event.preventDefault();
                // The form stays while pdf.js checks; it asks again if the password is wrong.
                password.update(passwordText);
                setPassword({ ...password, checking: true });
                setPasswordText("");
              }}
            >
              <label htmlFor="pdf-password">
                This PDF is protected. Enter its password to open it.
              </label>
              {password.wrong ? (
                <p role="alert" className="text-destructive">
                  That password is incorrect. Try again.
                </p>
              ) : null}
              <Input
                id="pdf-password"
                type="password"
                aria-invalid={password.wrong}
                autoFocus
                value={passwordText}
                onChange={(event) => setPasswordText(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={!passwordText || password.checking}>
                {password.checking ? "Opening…" : "Open"}
              </Button>
            </form>
          ) : !pdf ? (
            <FileSurfaceLoading />
          ) : (
            <div
              className="relative"
              style={{
                height: `max(${layout.height}px, calc(100% + ${(layout.tops.at(-1) ?? 16) - 16}px))`,
                minWidth: layout.width,
              }}
            >
              {visible.map(({ index, ratio }) => (
                <div
                  key={index}
                  className="absolute bg-white shadow-sm"
                  style={
                    {
                      top: layout.tops[index],
                      left: layout.lefts[index],
                      width,
                      height: width * ratio,
                      "--total-scale-factor": 1,
                    } as CSSProperties
                  }
                >
                  <PdfPage
                    document={pdf}
                    index={index}
                    width={width}
                    rotation={rotation}
                    query={query}
                    onSize={onSize}
                    onError={setError}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
