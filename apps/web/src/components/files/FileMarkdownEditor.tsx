import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import {
  buildMarkdownFileDoc,
  type MarkdownFileParse,
  parseMarkdownFile,
} from "~/reader/editor/markdownFileParse";
import {
  MARKDOWN_PARSE_WORKER_MIN_LENGTH,
  type MarkdownParseRequest,
  type MarkdownParseResponse,
} from "~/reader/editor/markdownFileParseProtocol";
import { serializeMarkdownFile } from "~/reader/editor/markdownFileSerialize";
import { ReaderEditor, type ReaderEditorHandle } from "~/reader/editor/ReaderEditor";
import { readerFileSurfaceKey } from "~/reader/navigation/readerOutlineStore";
import { ReaderSurface } from "~/reader/navigation/ReaderSurface";
import { useRightPanelStore } from "~/rightPanelStore";

import { decideIncomingContents } from "./fileMarkdownPublish";
import { FileMarkdownPreview, markdownFileBaseDir } from "./FileMarkdownPreview";
import { changeFileSaveSession, type FileSaveTarget } from "./fileSaveSessions";
import { FileSurfaceLoading } from "./fileSurfaceChrome";
import { setProjectFileQueryData } from "./projectFilesQueryState";

// Keystrokes are published after a pause, and at once on blur, page hide and unmount.
const PUBLISH_DELAY_MS = 150;

type Loaded =
  | { readonly kind: "ready"; readonly doc: ProseMirrorNode; readonly source: string }
  | { readonly kind: "failed"; readonly source: string };

/** The document, or `failed` when it would not write the file back byte for byte. */
function build(parse: MarkdownFileParse, source: string): Loaded {
  try {
    const doc = buildMarkdownFileDoc(parse);
    if (serializeMarkdownFile(doc) === source) return { kind: "ready", doc, source };
  } catch {
    // Reported below as a file the rendered view cannot edit.
  }
  return { kind: "failed", source };
}

function parseNow(source: string, math: boolean): Loaded {
  try {
    return build(parseMarkdownFile(source, { math }), source);
  } catch {
    return { kind: "failed", source };
  }
}

let parseWorker: Worker | null = null;
let nextParseId = 0;
const parseRequests = new Map<number, (response: MarkdownParseResponse) => void>();

function parseOffThread(source: string, math: boolean): Promise<MarkdownParseResponse> {
  if (!parseWorker) {
    parseWorker = new Worker(
      new URL("../../reader/editor/markdownFileParse.worker.ts", import.meta.url),
      { type: "module" },
    );
    parseWorker.addEventListener("message", (event: MessageEvent<MarkdownParseResponse>) => {
      parseRequests.get(event.data.id)?.(event.data);
      parseRequests.delete(event.data.id);
    });
    // A worker that fails to load answers nothing; its requests fall back to the main thread.
    parseWorker.addEventListener("error", () => {
      for (const [id, resolve] of parseRequests) resolve({ id, ok: false, message: "worker" });
      parseRequests.clear();
      parseWorker = null;
    });
  }
  nextParseId += 1;
  const request: MarkdownParseRequest = { id: nextParseId, source, math };
  const worker = parseWorker;
  return new Promise((resolve) => {
    parseRequests.set(request.id, resolve);
    worker.postMessage(request, []);
  });
}

/** A link's target: an external URL, or a path from the file's folder opened in the panel. */
function openFileLink(threadRef: ScopedThreadRef, cwd: string, relativePath: string, href: string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    const api = readLocalApi();
    if (api) void api.shell.openExternal(href);
    else window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  const path = href.replace(/[?#].*$/, "");
  if (path === "") return;
  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    // A malformed escape is opened as written.
  }
  const absolute = decoded.startsWith("/")
    ? resolvePathLinkTarget(decoded.slice(1), cwd)
    : resolvePathLinkTarget(decoded, markdownFileBaseDir(cwd, relativePath));
  const relative = absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute;
  useRightPanelStore.getState().openFile(threadRef, relative);
}

/**
 * A workspace Markdown file, edited in place in the reading view. It owns publishing to the
 * file's save session: keystrokes become the file's contents after a short pause, and new
 * contents from elsewhere are taken in unless unpublished keystrokes are newer.
 */
export function FileMarkdownEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onViewChange?: ((view: EditorView | null) => void) | undefined;
}) {
  const math = useClientSettings((settings) => settings.mathRenderingEnabled);
  // Changing math rendering changes the grammar, so the document is built again.
  return <FileMarkdownEditorBody key={String(math)} {...props} math={math} />;
}

function FileMarkdownEditorBody(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onViewChange?: ((view: EditorView | null) => void) | undefined;
  readonly math: boolean;
}) {
  const { environmentId, cwd, relativePath, contents, threadRef, math } = props;
  const [initial] = useState(contents);
  const isLarge = initial.length >= MARKDOWN_PARSE_WORKER_MIN_LENGTH;
  const [loaded, setLoaded] = useState<Loaded | null>(() =>
    isLarge ? null : parseNow(initial, math),
  );
  const handleRef = useRef<ReaderEditorHandle | null>(null);
  // The worker parses the first contents, so those are what the editor starts from either way.
  const status = useRef({
    published: initial,
    dirty: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const saveTarget: FileSaveTarget = { environmentId, cwd, relativePath };

  const publish = useEffectEvent(() => {
    const current = status.current;
    clearTimeout(current.timer);
    current.timer = undefined;
    const view = handleRef.current?.view;
    if (!current.dirty || !view) return;
    current.dirty = false;
    const next = serializeMarkdownFile(view.state.doc);
    if (next === current.published) return;
    current.published = next;
    setProjectFileQueryData(environmentId, cwd, relativePath, next);
    changeFileSaveSession(saveTarget, next);
  });

  const onChange = (_state: EditorState, external: boolean) => {
    if (external) return;
    const current = status.current;
    current.dirty = true;
    clearTimeout(current.timer);
    current.timer = setTimeout(publish, PUBLISH_DELAY_MS);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a large file parses in a worker, an external process whose answer arrives after mount
  useEffect(() => {
    if (!isLarge) return;
    let isCurrent = true;
    void parseOffThread(initial, math).then((response) => {
      if (!isCurrent) return;
      setLoaded(response.ok ? build(response.parse, initial) : parseNow(initial, math));
    });
    return () => {
      isCurrent = false;
    };
  }, [initial, isLarge, math]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- new file contents from the panel (a save echo or a change elsewhere) are dispatched into the ProseMirror view, which lives outside React
  useLayoutEffect(() => {
    const editor = handleRef.current;
    if (loaded?.kind !== "ready" || !editor) return;
    const decision = decideIncomingContents(contents, status.current);
    if (decision === "publish") publish();
    if (decision !== "apply") return;
    editor.applyExternal(contents);
    status.current.published = contents;
  }, [contents, loaded]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the last keystrokes reach the save session before the page is hidden, and before the session's lease is released on unmount: layout cleanups run ahead of passive ones
  useLayoutEffect(() => {
    const onPageHide = () => publish();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      publish();
    };
  }, []);

  if (loaded === null) return <FileSurfaceLoading />;
  if (loaded.kind === "failed") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 border-b px-3 py-1.5 text-2xs text-muted-foreground">
          This file can't be edited in the rendered view; use source view.
        </p>
        <FileMarkdownPreview
          cwd={cwd}
          relativePath={relativePath}
          text={contents}
          threadRef={threadRef}
          workspaceMutationId={props.workspaceMutationId}
        />
      </div>
    );
  }
  return (
    <ReaderSurface surfaceKey={readerFileSurfaceKey(cwd, relativePath)}>
      <ReaderEditor
        doc={loaded.doc}
        math={math}
        preview={{
          cwd,
          imageBaseDir: markdownFileBaseDir(cwd, relativePath),
          threadRef,
          workspaceMutationId: props.workspaceMutationId,
        }}
        handleRef={handleRef}
        onChange={onChange}
        onBlur={publish}
        onOpenLink={(href) => openFileLink(threadRef, cwd, relativePath, href)}
        onViewChange={props.onViewChange}
      />
    </ReaderSurface>
  );
}
