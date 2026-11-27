import {
  type EnvironmentId,
  PROJECT_WRITE_FILE_BINARY_MAX_BYTES,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import type { MarkdownBlock } from "~/reader/blocks/markdownBlocks";
import { MarkdownBlockEditor } from "~/reader/blocks/MarkdownBlockEditor";
import {
  BlockPreview,
  BlockPreviewContext,
  type BlockPreviewKind,
} from "~/reader/blocks/BlockPreview";
import { readerFileSurfaceKey } from "~/reader/navigation/readerOutlineStore";
import { ReaderSurface } from "~/reader/navigation/ReaderSurface";
import { useRightPanelStore } from "~/rightPanelStore";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { contentsOnClose, reconcileIncoming } from "./fileMarkdownPublish";
import { FileMarkdownPreview, markdownFileBaseDir } from "./FileMarkdownPreview";
import {
  changeFileSaveSession,
  type FileSaveConflict,
  type FileSaveTarget,
  resolveFileSaveConflict,
  subscribeFileSaveConflict,
} from "./fileSaveSessions";
import { setProjectFileQueryData } from "./projectFilesQueryState";

// Keystrokes are published after a pause, and at once on blur, page hide and unmount.
const PUBLISH_DELAY_MS = 150;
// Blocks are parsed on the main thread; a file this long opens in source view instead.
const LARGEST_BLOCK_EDIT = 512 * 1024;

export interface MarkdownEditorHandle {
  readonly focus: () => void;
}

const RAW_KINDS: Readonly<Record<string, BlockPreviewKind>> = {
  yaml: "frontmatter",
  toml: "frontmatter",
  definition: "definition",
  footnoteDefinition: "footnote",
  html: "html",
};

function renderBlock(
  block: MarkdownBlock,
  text: string,
  onTaskToggle: (markerOffset: number, checked: boolean) => void,
) {
  return (
    <BlockPreview
      kind={RAW_KINDS[block.kind] ?? "other"}
      text={text}
      onTaskListChange={({ markerOffset, checked }) => onTaskToggle(markerOffset, checked)}
    />
  );
}

function imageExtension(file: File) {
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1];
  return (fromName ?? file.type.split("/")[1] ?? "png").toLowerCase().replace("jpeg", "jpg");
}

// Down to the millisecond, plus a running count, so two images pasted together never share a name.
let pastedImages = 0;
function pastedImageName(file: File, now: Date, random: string) {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 17);
  return `image-${stamp}-${random}.${imageExtension(file)}`;
}

async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
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
 * A workspace Markdown file, edited as ElyMark edits it: the file's text is the document, its
 * blocks drawn as the reading view draws them, the pressed one open as source. Keystrokes become
 * the file's contents after a pause; a change made elsewhere is taken in, merged with unpublished
 * keystrokes when they don't overlap, and otherwise offered side by side.
 */
export function FileMarkdownEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onViewChange?: ((handle: MarkdownEditorHandle | null) => void) | undefined;
}) {
  const { environmentId, cwd, relativePath, contents, threadRef } = props;
  const math = useClientSettings((settings) => settings.mathRenderingEnabled);
  const [text, setText] = useState(contents);
  const [externalRevision, setExternalRevision] = useState(0);
  const [conflict, setConflict] = useState<{ readonly disk: string; readonly base: string } | null>(
    null,
  );
  const root = useRef<HTMLDivElement>(null);
  const status = useRef({
    published: contents,
    latest: contents,
    dirty: false,
    conflicted: false,
    conflict: null as { readonly base: string; readonly disk: string } | null,
    /** The save session refused a write because the disk changed under it; it holds the draft. */
    sessionConflict: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const saveTarget: FileSaveTarget = { environmentId, cwd, relativePath };
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });

  const publish = useEffectEvent(() => {
    const current = status.current;
    clearTimeout(current.timer);
    current.timer = undefined;
    // Nothing is written over the disk's version until the conflict is settled.
    if (!current.dirty || current.conflicted) return;
    current.dirty = false;
    const next = current.latest;
    if (next === current.published) return;
    current.published = next;
    setProjectFileQueryData(environmentId, cwd, relativePath, next);
    changeFileSaveSession(saveTarget, next);
  });

  const onTextChange = (next: string) => {
    const current = status.current;
    setText(next);
    current.latest = next;
    current.dirty = true;
    clearTimeout(current.timer);
    current.timer = setTimeout(publish, PUBLISH_DELAY_MS);
  };

  const settle = () => {
    setConflict(null);
    status.current.conflicted = false;
    status.current.conflict = null;
    status.current.sessionConflict = false;
  };

  const takeIn = (next: string) => {
    setText(next);
    status.current.latest = next;
    status.current.published = next;
    setExternalRevision((revision) => revision + 1);
  };

  const reconcile = useEffectEvent((contents: string) => {
    const current = status.current;
    // The session publishes the disk's version as it holds the draft back; the bar decides.
    if (current.sessionConflict) return;
    const outcome = reconcileIncoming(contents, current);
    // While a conflict stands, `published` is still the base both sides started from, so a newer
    // disk version is weighed against it again: a clean merge or a revert to the base settles it.
    if (current.conflict && outcome.kind !== "conflict") {
      settle();
      if (outcome.kind === "ignore") {
        current.dirty = true;
        publish();
        return;
      }
    }
    if (outcome.kind === "ignore") return;
    if (outcome.kind === "apply") {
      takeIn(outcome.text);
      return;
    }
    if (outcome.kind === "merged") {
      takeIn(outcome.text);
      current.published = outcome.published;
      current.dirty = outcome.dirty;
      if (current.dirty) publish();
      return;
    }
    clearTimeout(current.timer);
    current.conflicted = true;
    current.conflict = { base: outcome.base, disk: outcome.disk };
    setConflict(current.conflict);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- new file contents from the panel (a save echo or a change elsewhere) are reconciled with keystrokes not yet published, which live in a ref outside React
  useLayoutEffect(() => {
    reconcile(contents);
  }, [contents]);

  const onSessionConflict = useEffectEvent((next: FileSaveConflict | null) => {
    const current = status.current;
    if (!next) return;
    clearTimeout(current.timer);
    current.sessionConflict = true;
    current.conflicted = true;
    current.conflict = { base: next.base, disk: next.disk };
    current.latest = next.local;
    current.published = next.local;
    current.dirty = false;
    if (next.local !== text) takeIn(next.local);
    setConflict(current.conflict);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the save session reports a write it refused because the file changed on disk; it lives outside React
  useEffect(
    () => subscribeFileSaveConflict({ environmentId, cwd, relativePath }, onSessionConflict),
    [environmentId, cwd, relativePath],
  );

  /** Settles a conflict with `contents`, through the save session when it holds the draft. */
  const resolveWith = (contents: string, disk: string) => {
    const current = status.current;
    if (!current.sessionConflict) return false;
    settle();
    takeIn(contents);
    current.dirty = false;
    resolveFileSaveConflict(saveTarget, contents);
    if (contents === disk) current.published = disk;
    return true;
  };

  const leave = useEffectEvent(() => {
    const current = status.current;
    // The session keeps a refused draft until the conflict is settled; give it the latest one.
    if (current.sessionConflict) {
      changeFileSaveSession(saveTarget, current.latest);
      return;
    }
    if (current.conflict) {
      current.latest = contentsOnClose(current.latest, current.conflict);
      current.published = current.conflict.disk;
      current.dirty = true;
      current.conflicted = false;
      current.conflict = null;
    }
    publish();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the last keystrokes reach the save session before the page is hidden, and before the session's lease is released on unmount: layout cleanups run ahead of passive ones
  useLayoutEffect(() => {
    const onPageHide = () => leave();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      leave();
    };
  }, []);

  const onViewChange = useEffectEvent((handle: MarkdownEditorHandle | null) =>
    props.onViewChange?.(handle),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the panel focuses the editor from outside React (tree clicks, keyboard), through this handle
  useLayoutEffect(() => {
    onViewChange({
      focus: () =>
        root.current?.querySelector<HTMLElement>("[data-markdown-block-editor]")?.focus(),
    });
    return () => onViewChange(null);
  }, []);

  const pasteImage = async (file: File) => {
    const folder = relativePath.includes("/")
      ? relativePath.slice(0, relativePath.lastIndexOf("/") + 1)
      : "";
    if (file.size > PROJECT_WRITE_FILE_BINARY_MAX_BYTES) {
      toastManager.add({ type: "error", title: "Images over 25 MB can't be pasted" });
      return null;
    }
    const name = pastedImageName(file, new Date(), String((pastedImages += 1)));
    const result = await writeFile({
      environmentId,
      input: {
        cwd,
        relativePath: `${folder}assets/${name}`,
        contents: await fileBase64(file),
        encoding: "base64",
        createIfMissing: true,
      },
    });
    if (result._tag === "Success") return `assets/${name}`;
    toastManager.add({
      type: "error",
      title: "Could not save the pasted image",
      description: "Check that you can write to this folder, then paste again.",
    });
    return null;
  };

  if (text.length > LARGEST_BLOCK_EDIT) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 border-b px-3 py-1.5 text-2xs text-muted-foreground">
          Too large for block editing. Use Show markdown source to edit it.
        </p>
        <FileMarkdownPreview
          cwd={cwd}
          relativePath={relativePath}
          text={text}
          threadRef={threadRef}
          workspaceMutationId={props.workspaceMutationId}
        />
      </div>
    );
  }
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      {conflict ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs"
        >
          <span className="mr-auto">
            This file changed on disk while you were editing. Saving is paused until you choose a
            version.
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              if (resolveWith(status.current.latest, conflict.disk)) return;
              settle();
              status.current.published = conflict.disk;
              status.current.dirty = true;
              publish();
            }}
          >
            Keep mine
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              if (resolveWith(conflict.disk, conflict.disk)) return;
              settle();
              status.current.dirty = false;
              takeIn(conflict.disk);
            }}
          >
            Use disk version
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              const merged = contentsOnClose(status.current.latest, conflict);
              if (resolveWith(merged, conflict.disk)) return;
              settle();
              takeIn(merged);
              status.current.published = conflict.disk;
              status.current.latest = merged;
              status.current.dirty = true;
              publish();
            }}
          >
            Insert conflict markers
          </Button>
        </div>
      ) : null}
      <ReaderSurface surfaceKey={readerFileSurfaceKey(cwd, relativePath)}>
        <BlockPreviewContext
          value={{
            cwd,
            imageBaseDir: markdownFileBaseDir(cwd, relativePath),
            threadRef,
            workspaceMutationId: props.workspaceMutationId,
          }}
        >
          <MarkdownBlockEditor
            text={text}
            math={math}
            externalRevision={externalRevision}
            onTextChange={onTextChange}
            renderBlock={renderBlock}
            onPasteImage={pasteImage}
            onOpenLink={(href) => openFileLink(threadRef, cwd, relativePath, href)}
          />
        </BlockPreviewContext>
      </ReaderSurface>
    </div>
  );
}
