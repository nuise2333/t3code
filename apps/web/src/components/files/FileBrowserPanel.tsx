import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  AssetResource,
  ContextMenuItem,
  EnvironmentId,
  ProjectEntry,
} from "@t3tools/contracts";
import {
  FileTree,
  useFileTree,
  useFileTreeSearch,
  useFileTreeSelection,
  useFileTreeSelector,
} from "@pierre/trees/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import {
  ArrowUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  LayoutGridIcon,
  ListIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
import { useFileIconTheme } from "~/fileIconThemes";
import { fileTreeIconsFor } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { FileGridView, type GridThumbnails, treePathOf } from "./FileGridView";
import { joinHostPath } from "./filePath";
import {
  GRID_MAX_ENTRIES,
  type GridEntry,
  gridRangePaths,
  sortGridEntries,
} from "./fileGrid.logic";
import { nextThumbnailEpoch, thumbnailBudget } from "./fileThumbnails";
import {
  canPasteFiles,
  copyFilePaths,
  copyFilesToClipboard,
  createFileEntry,
  duplicateFiles,
  type FileOperationsTarget,
  pasteFiles,
  renameFileEntry,
  trashFiles,
  useCanWriteFiles,
} from "./fileOperations";
import {
  absoluteFilePath,
  type FileOperationMenuAction,
  type FilePathMove,
  fileOperationMenuItems,
} from "./fileOperations.logic";
import { subscribeFileTreeChanges, type FileTreeChange } from "./fileOperationsState";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import {
  areAllDirectoriesExpanded,
  coalesceReentrantCalls,
  readExpandedDirectories,
  setAllDirectoriesExpanded,
  writeExpandedDirectories,
} from "./fileTreeExpansion";
import {
  buildFileTreePathUpdates,
  moveFileTreePaths,
  shouldRebuildFileTree,
} from "./fileTreePathReconciliation";
import { loadFileAncestors } from "./loadFileAncestors";
import { useDirectoryEntries } from "./useDirectoryEntries";
import { useProjectPathSearch } from "~/state/queries";
import { isMacPlatform } from "~/lib/utils";
import { type PreviewAction, subscribePreviewAction } from "../preview/previewActionBus";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  /** Host-folder entries use absolute paths. Avoid full traversal: disable expand-all and search only
   * loaded folders. */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
  answersPanelFind?: boolean;
  /** A Files tab's own expansion; it starts from the workspace's when it has none saved. */
  expansionKey?: string;
  onOpenFolderInNewTab?: (path: string) => void;
  /** Absolute moves from a rename or paste here, so the acting panel retargets its tabs. */
  onPathsMoved?: (moves: readonly FilePathMove[]) => void;
  /** A Files tab picks list or icon view; other panels only list. */
  view?: FileBrowserView;
}

export interface FileBrowserView {
  readonly mode: "list" | "grid";
  readonly onModeChange: (mode: "list" | "grid") => void;
  /** The folder the icon view shows, relative to the panel root. */
  readonly folder: string;
  /** A child of `folder` to show first, such as the one just left by going up. */
  readonly returnPath: string | null;
  readonly onEnterFolder: (path: string) => void;
  readonly onUp: (() => void) | null;
  readonly thumbnailResource: (absolutePath: string) => AssetResource;
  /** Remote thumbnail bytes are budgeted per Files tab. */
  readonly budgetKey: string;
}

const FILE_OPERATION_SHORTCUTS = ["Meta", "Control"]
  .flatMap((modifier) => ["C", "X", "V", "D", "Backspace"].map((key) => `${modifier}+${key}`))
  .join(" ");

/** A tree row or an icon-view tile. */
const ENTRY_SELECTOR = '[role="treeitem"], [data-grid-tile]';
const THUMBNAIL_REFRESH_SETTLE_MS = 750;

function treeParentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

const fromTreePath = (path: string) => path.replace(/\/$/, "");

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function SubheaderButton(props: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            aria-pressed={props.pressed}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField({
  ref,
  ...props
}: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  ref: Ref<HTMLInputElement>;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        ref={ref}
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        data-workspace-focus-default
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

function buildTreeEntries(
  directoryEntries: readonly ProjectEntry[],
  searchEntries: readonly ProjectEntry[],
  searchPending: boolean,
  query: string,
) {
  const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
  if (query.trim() && !searchPending) {
    for (const entry of searchEntries) {
      if (!result.has(entry.path)) result.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!result.has(path)) result.set(path, { path, kind: "directory" });
      }
    }
  }
  const entries = [...result.values()];
  const entryKinds: ReadonlyMap<string, ProjectEntry["kind"]> = new Map(
    entries.map((entry) => [entry.path, entry.kind] as const),
  );
  const treePaths = entries.map(treePath);
  const directories = entries.filter((entry) => entry.kind === "directory");
  const directoryPaths = directories.map(treePath);
  // Expanding a folder lists it, and an ignored one such as `node_modules` can hold tens of
  // thousands, so expand all skips ignored folders. They still open by hand.
  const expandableDirectoryPaths = directories.filter((entry) => !entry.ignored).map(treePath);
  return { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths };
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  hostFolder = false,
  answersPanelFind = false,
  expansionKey,
  onOpenFolderInNewTab,
  onPathsMoved,
  view,
}: FileBrowserPanelProps) {
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
  const { resolvedTheme } = useTheme();
  const treeIcons = fileTreeIconsFor(useFileIconTheme(), resolvedTheme);
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const canWrite = useCanWriteFiles(environmentId);
  const operations: FileOperationsTarget = {
    environmentId,
    root: cwd,
    hostFolder,
    onMoved: onPathsMoved,
  };
  const {
    entries: directoryEntries,
    childrenOf,
    load,
    refresh,
    refreshDirectories,
    ready,
    error,
    isPending,
    loadingDirectories,
  } = useDirectoryEntries(environmentId, cwd);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: query.slice(0, 256) },
    200,
  );
  const { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths } =
    buildTreeEntries(directoryEntries, pathSearch.entries, pathSearch.isPending, query);
  const gridRequested = view?.mode === "grid";
  const gridFolder = view?.folder ?? "";
  const gridListing = gridRequested ? childrenOf(gridFolder) : undefined;
  const gridTooLarge = (gridListing?.length ?? 0) > GRID_MAX_ENTRIES;
  // Search matches across folders, so the tree shows its results until the query clears.
  const gridActive = gridRequested && !query.trim() && !gridTooLarge;
  const gridEntries = gridActive && gridListing ? sortGridEntries(gridListing) : [];
  const gridTreePaths = new Set(gridEntries.map(treePathOf));
  const [gridRenamingPath, setGridRenamingPath] = useState<string | null>(null);
  /** Shows a grid rename's new name until the listing catches up or the server refuses it. */
  const [gridRenamed, setGridRenamed] = useState<{
    path: string;
    name: string;
    listing: typeof gridListing;
  } | null>(null);
  const gridRenameOverride = gridRenamed?.listing === gridListing ? gridRenamed : null;
  const gridAnchorRef = useRef<string | null>(null);
  const [thumbnailEpoch, setThumbnailEpoch] = useState(0);
  const [thumbnailsStale, setThumbnailsStale] = useState(false);
  const entryKindsRef = useRef(entryKinds);
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  /** The last listing applied, which a failed rename returns the tree to. */
  const listedTreePathsRef = useRef<readonly string[] | null>(null);
  /** A just-created entry that opens for renaming once its listing reaches the tree. */
  const pendingRenamePathRef = useRef<string | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // Shadow-DOM row rects are unreliable; capture the composed contextmenu event's viewport position.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);

  const canRenameEntry = useStableCallback((path: string) => canWrite && path !== "");

  const loadingDirectoriesRef = useRef(loadingDirectories);
  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );
  const { model } = useFileTree({
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: treeIcons,
    onSelectionChange: (selectedPaths) => {
      // Update drag selection even for reveals so subsequent drags cannot use stale paths.
      dragMention.handleSelectionChange(selectedPaths);
      if (syncingSelectionRef.current) return;
      if (dragMention.isDragInProgress()) {
        return;
      }
      // Shift and Mod clicks build a selection for file operations instead of opening files.
      if (selectedPaths.length !== 1) return;
      const selectedPath = selectedPaths[0]?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(panelPath(selectedPath));
      }
    },
    paths: [],
    renaming: {
      canRename: (item) => canRenameEntry(item.path),
      onError: (message) =>
        toastManager.add({ type: "error", title: "Couldn't rename", description: message }),
    },
    renderRowDecoration: ({ item, row }) =>
      row.kind === "directory" &&
      row.isExpanded &&
      loadingDirectoriesRef.current.has(item.path.replace(/\/$/, ""))
        ? { icon: "t3-tree-icon-loading", title: "Loading…" }
        : null,
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the icon set into the imperative Pierre file tree model
  useEffect(() => {
    model.setIcons(treeIcons);
  }, [treeIcons, model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when loading directories change
  useEffect(() => {
    if (loadingDirectoriesRef.current === loadingDirectories) return;
    loadingDirectoriesRef.current = loadingDirectories;
    model.setComposition(model.getComposition());
  }, [loadingDirectories, model]);
  const menuPosition = (fallback: DOMRect | null) => {
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    if (pointerIsFresh) return { position: { x: pointer.x, y: pointer.y }, pointerIsFresh };
    return {
      position: fallback ? { x: fallback.left, y: fallback.bottom } : undefined,
      pointerIsFresh,
    };
  };

  // Renaming selects the entry, which must not open it.
  const beginRename = (path: string) => {
    if (gridActive) {
      setGridRenamingPath(fromTreePath(path));
      return true;
    }
    syncingSelectionRef.current = true;
    const started = model.startRenaming(path);
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
    return started;
  };

  // Finder-style: the entry is created with a free name, then opens for renaming.
  const startCreating = async (kind: "file" | "directory", folder: string) => {
    const prefix = folder === "" ? "" : `${folder}/`;
    const siblings = new Set(
      directoryEntries
        .filter((entry) => treeParentPath(entry.path) === folder && entry.path.startsWith(prefix))
        .map((entry) => fileBasename(entry.path)),
    );
    const folderItem = folder === "" ? null : model.getItem(`${folder}/`);
    if (folderItem && "expand" in folderItem) folderItem.expand();
    const created = await createFileEntry(operations, kind, folder, siblings);
    if (created === null) return;
    const path = kind === "directory" ? `${created}/` : created;
    if (model.getItem(path) && beginRename(path)) return;
    pendingRenamePathRef.current = path;
  };

  /** Paths are tree paths without the folder slash; "" is the root's empty space. */
  const runOperationMenuAction = (
    action: FileOperationMenuAction,
    targets: readonly string[],
    folder: string,
  ) => {
    switch (action) {
      case "new-file":
      case "new-folder":
        void startCreating(action === "new-file" ? "file" : "directory", folder);
        return;
      case "rename": {
        const [target] = targets;
        if (target === undefined) return;
        const kind = entryKindsRef.current.get(target);
        beginRename(kind === "directory" ? `${target}/` : target);
        return;
      }
      case "duplicate":
        void duplicateFiles(operations, targets);
        return;
      case "cut":
      case "copy":
        copyFilesToClipboard(operations, targets, action);
        return;
      case "paste":
        void pasteFiles(operations, folder);
        return;
      case "copy-path":
      case "copy-relative-path":
        void copyFilePaths(operations, targets, action === "copy-relative-path");
        return;
      case "trash":
        void trashFiles(operations, targets);
        return;
    }
  };

  const operationMenu = (targets: readonly string[], folder: string) =>
    fileOperationMenuItems({
      targetCount: targets.length,
      canWrite,
      canPaste: canPasteFiles(operations, folder),
      hasRelativePaths: !hostFolder,
    });

  const isOperationMenuAction = (
    items: readonly ContextMenuItem<string>[],
    clicked: string,
  ): clicked is FileOperationMenuAction => items.some((item) => item.id === clicked);

  const selectOnly = (path: string) => {
    syncingSelectionRef.current = true;
    for (const selected of model.getSelectedPaths()) model.getItem(selected)?.deselect();
    model.getItem(path)?.select();
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  };

  /** The grid shares the tree's selection, which can still hold paths from folders left behind. */
  const visibleSelection = () => {
    const selected = model.getSelectedPaths();
    return gridActive ? selected.filter((path) => gridTreePaths.has(path)) : selected;
  };

  const showEntryContextMenu = useEffectEvent(
    (
      item: { readonly path: string },
      context: {
        readonly anchorElement: Element;
        close: (options?: { restoreFocus?: boolean }) => void;
      },
    ) => {
      const api = readLocalApi();
      if (!api) {
        context.close();
        return;
      }
      // Right-clicking a selected row acts on the selection; any other row acts alone.
      const selected = visibleSelection();
      const actsOnSelection = selected.includes(item.path) && selected.length > 1;
      if (!actsOnSelection && !(selected.length === 1 && selected[0] === item.path)) {
        selectOnly(item.path);
      }
      const targets = actsOnSelection ? selected.map(fromTreePath) : [fromTreePath(item.path)];
      const relativePath = fromTreePath(item.path);
      const isFolder = item.path.endsWith("/");
      const single = targets.length === 1;
      const folder = single && isFolder ? relativePath : treeParentPath(relativePath);
      const mention = serializeComposerFileLink(panelPath(relativePath));
      const { position, pointerIsFresh } = menuPosition(
        context.anchorElement.getBoundingClientRect(),
      );
      const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
      const fileMenuItems = single ? fileContextMenu.buildItems(fileTarget) : [];
      const opensInNewTab = onOpenFolderInNewTab !== undefined && isFolder && single;
      const operationItems = operationMenu(targets, folder);
      const leadingItems: ContextMenuItem<string>[] = [
        ...(opensInNewTab ? [{ id: "open-in-new-tab", label: "Open in new tab" }] : []),
        ...fileMenuItems,
        ...(single
          ? [
              { id: "copy-mention", label: "Copy mention" },
              { id: "add-to-chat", label: "Add to chat" },
            ]
          : []),
      ];
      const [firstOperation, ...restOperations] = operationItems;
      // The app menu owns focus; the tree's outside-click handler would dismiss it before click.
      context.close({ restoreFocus: !pointerIsFresh });
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            ...leadingItems,
            ...(firstOperation
              ? [{ ...firstOperation, separatorBefore: leadingItems.length > 0 }, ...restOperations]
              : []),
          ],
          position,
        );
        if (clicked === null) return;
        if (clicked === "open-in-new-tab") {
          onOpenFolderInNewTab?.(panelPath(relativePath));
          return;
        }
        if (isOperationMenuAction(operationItems, clicked)) {
          runOperationMenuAction(clicked, targets, folder);
          return;
        }
        // Open-with submenu ids are absent from the top-level item list.
        const isFileMenuAction =
          fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
        if (isFileMenuAction) {
          await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
          return;
        }
        if (clicked === "copy-mention") {
          try {
            await writeTextToClipboard(mention);
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Failed to copy mention",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
          return;
        }
        if (clicked === "add-to-chat") {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "Open a chat for this project and try again.",
            });
            return;
          }
          const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
          if (!inserted) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "The chat isn't ready to accept input right now.",
            });
          }
        }
      }).then((result) => {
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const showFolderContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const onRow = event.nativeEvent
      .composedPath()
      .some((node) => node instanceof Element && node.matches(ENTRY_SELECTOR));
    const api = readLocalApi();
    if (onRow || !api) return;
    event.preventDefault();
    const folder = gridActive ? gridFolder : "";
    const items = operationMenu([], folder);
    const position = { x: event.clientX, y: event.clientY };
    void settlePromise(async () => {
      const clicked = await api.contextMenu.show(items, position);
      if (clicked !== null && isOperationMenuAction(items, clicked)) {
        runOperationMenuAction(clicked, [], folder);
      }
    });
  };

  const revertTreeToListing = () => {
    const listed = listedTreePathsRef.current;
    const shown = previousTreePathsRef.current;
    if (listed === null || shown === null) return;
    previousTreePathsRef.current = listed;
    const updates = buildFileTreePathUpdates(shown, listed);
    if (updates.length > 0) model.batch(updates);
  };

  // Only a rename moves rows: listings add and remove, and dropping is off. The tree already
  // shows the new name here, and a refusal puts the listing back.
  const handleTreeRename = (from: string, to: string) => {
    const shown = previousTreePathsRef.current;
    if (shown !== null) previousTreePathsRef.current = moveFileTreePaths(shown, from, to);
    void renameFileEntry(operations, fromTreePath(from), fileBasename(fromTreePath(to))).then(
      (renamed) => {
        if (!renamed) revertTreeToListing();
      },
    );
  };
  const beginRenameAfterListing = useEffectEvent((path: string) => beginRename(path));
  const onTreeMove = useEffectEvent((from: string, to: string) => handleTreeRename(from, to));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Pierre model's renames, which it applies before telling us
  useEffect(() => model.onMutation("move", (event) => onTreeMove(event.from, event.to)), [model]);

  const focusedEntryPath = (gridFocusedPath: string | null) => {
    if (!gridActive) return model.getFocusedPath() ?? null;
    if (gridFocusedPath === null) return null;
    const entry = gridEntries.find((candidate) => candidate.path === gridFocusedPath);
    return entry ? treePathOf(entry) : null;
  };

  const selectionTargets = (gridFocusedPath: string | null) => {
    const selected = visibleSelection();
    const focused = focusedEntryPath(gridFocusedPath);
    return (selected.length > 0 ? selected : focused ? [focused] : []).map(fromTreePath);
  };

  // In the grid, pasting goes into the folder shown unless one folder tile is selected.
  const pasteFolder = () => {
    const selected = visibleSelection();
    if (gridActive) {
      const only = selected.length === 1 ? selected[0] : undefined;
      return only?.endsWith("/") ? fromTreePath(only) : gridFolder;
    }
    const anchor = selected.length === 1 ? selected[0] : (model.getFocusedPath() ?? undefined);
    if (anchor === undefined) return "";
    return anchor.endsWith("/") ? fromTreePath(anchor) : treeParentPath(anchor);
  };

  /** Mod+C/X/V/D/Backspace act on the tree only while a row has focus, never on text. */
  const handleOperationShortcut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canWrite || event.altKey || event.shiftKey) return;
    const isModPressed = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (!isModPressed) return;
    const path = event.nativeEvent.composedPath();
    const grid = path.find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.matches("[data-file-grid]"),
    );
    const onRow =
      grid !== undefined ||
      path.some((node) => node instanceof Element && node.matches(ENTRY_SELECTOR));
    const inText = path.some(
      (node) => node instanceof Element && node.matches("input, textarea, [contenteditable]"),
    );
    if (!onRow || inText) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const targets = selectionTargets(grid?.dataset.focusedPath ?? null);
    if (key === "c" || key === "x") {
      copyFilesToClipboard(operations, targets, key === "x" ? "cut" : "copy");
    } else if (key === "v") {
      void pasteFiles(operations, pasteFolder());
    } else if (key === "d") {
      void duplicateFiles(operations, targets);
    } else if (key === "Backspace") {
      void trashFiles(operations, targets);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onFileTreeChange = useEffectEvent((change: FileTreeChange) => {
    if (change.environmentId !== environmentId) return;
    const directories = change.directories.flatMap((directory) => {
      const relative = workspaceRelativeFilePath(directory, cwd);
      return relative === null ? [] : [relative === "." ? "" : relative];
    });
    if (directories.length === 0) return;
    refreshDirectories(directories);
    if (query.trim()) pathSearch.refresh();
    if (gridActive) setThumbnailsStale(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for file operations anywhere in this window; the server pushes no listing changes
  useEffect(() => subscribeFileTreeChanges(onFileTreeChange), []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs the row context menu on the Pierre model once it exists, since the menu acts on its selection
  useEffect(() => {
    model.setComposition({
      ...model.getComposition(),
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => showEntryContextMenu(item, context),
      },
    });
  }, [model]);

  const search = useFileTreeSearch(model);
  // Pierre restores the unfiltered tree when a search has no matches.
  const hasNoSearchMatches = search.value.trim().length > 0 && search.matchingPaths.length === 0;
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, expandableDirectoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(
      model,
      expanded ? expandableDirectoryPaths : directoryPaths,
      expanded,
    );
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  const searchInputRef = useRef<HTMLInputElement>(null);
  const focusSearch = () => {
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  };
  const onPanelAction = useEffectEvent((action: PreviewAction) => {
    // Hidden panel tabs stay mounted; only the visible Files tab answers.
    if (action === "find" && searchInputRef.current?.getClientRects().length) focusSearch();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the panel find command, which fires while focus is anywhere in the right panel
  useEffect(() => {
    if (!answersPanelFind) return;
    return subscribePreviewAction(onPanelAction);
  }, [answersPanelFind]);
  const expandedPathsRef = useRef(new Set<string>());
  const workspaceExpansionRoot = `${environmentId}:${cwd}`;
  const expansionRoot = expansionKey ?? workspaceExpansionRoot;
  const keepEmptyExpansion = expansionKey !== undefined;
  // Folders expanded when the panel last unmounted; each reopens once lazy loading lists it.
  const [pendingExpandedPaths] = useState(
    () =>
      new Set(
        readExpandedDirectories(
          expansionRoot,
          expansionKey === undefined ? undefined : workspaceExpansionRoot,
        ),
      ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Pierre tree model to load directories as they are expanded
  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    for (const path of expandedPathsRef.current) {
      if (!currentPaths.has(path)) expandedPathsRef.current.delete(path);
    }
    // Restoring calls item.expand(), which notifies subscribers synchronously.
    const loadExpanded = coalesceReentrantCalls(() => {
      if (model.isSearchOpen()) return;
      let changed = false;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item?.isDirectory() && pendingExpandedPaths.delete(path) && "expand" in item) {
          item.expand();
        }
        if (item?.isDirectory() && "isExpanded" in item && item.isExpanded()) {
          if (!expandedPathsRef.current.has(path)) {
            expandedPathsRef.current.add(path);
            changed = true;
            void load(path.replace(/\/$/, ""));
          }
        } else {
          if (item?.isDirectory() && expandedPathsRef.current.has(path)) setExpandAll(false);
          if (expandedPathsRef.current.delete(path)) changed = true;
        }
      }
      if (changed) {
        writeExpandedDirectories(
          expansionRoot,
          [...expandedPathsRef.current, ...pendingExpandedPaths],
          keepEmptyExpansion,
        );
      }
    });
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryPaths, expansionRoot, keepEmptyExpansion, load, model, pendingExpandedPaths]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes ignored-file status into the imperative Pierre tree model
  useEffect(() => {
    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({
          path: treePath(entry),
          status: "ignored",
        })),
    );
  }, [entries, model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected file's ancestor directories and aborts on cleanup
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void loadFileAncestors(selectedPath, load, { signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);
  const handleSearchValueChange = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const handleRefresh = () => {
    refresh();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
      if (gridActive) setThumbnailsStale(true);
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for a burst of workspace changes and its listing refreshes to settle, then has visible thumbnails re-check their revisions once
  useEffect(() => {
    if (!thumbnailsStale || isPending) return;
    const timer = setTimeout(() => {
      setThumbnailsStale(false);
      setThumbnailEpoch(nextThumbnailEpoch());
    }, THUMBNAIL_REFRESH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [isPending, thumbnailsStale]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lists the icon view's folder and its ancestors, so refreshes reach it and a deleted folder is noticed
  useEffect(() => {
    if (!gridRequested) return;
    const controller = new AbortController();
    if (gridFolder !== "") void loadFileAncestors(gridFolder, load, { signal: controller.signal });
    void load(gridFolder);
    return () => controller.abort();
  }, [gridFolder, gridRequested, load]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies tree path changes to the imperative Pierre tree model as a reset or batch update
  useEffect(() => {
    if (!ready) return;
    if (listedTreePathsRef.current === treePaths) return;
    listedTreePathsRef.current = treePaths;
    entryKindsRef.current = entryKinds;
    const startPendingRename = () => {
      const pending = pendingRenamePathRef.current;
      if (pending === null || !model.getItem(pending)) return;
      pendingRenamePathRef.current = null;
      beginRenameAfterListing(pending);
    };
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      startPendingRename();
      return;
    }
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
    if (shouldRebuildFileTree(previousTreePaths, treePaths, updates)) {
      // A reset keeps old search matches, so search closes first and recomputes afterwards.
      const activeSearch = model.isSearchOpen() ? model.getSearchValue() : null;
      if (activeSearch !== null) model.closeSearch();
      model.resetPaths(treePaths, { initialExpandedPaths: [...expandedPathsRef.current] });
      if (activeSearch !== null) model.setSearch(activeSearch);
      startPendingRename();
      return;
    }
    if (updates.length > 0) model.batch(updates);
    startPendingRename();
  }, [ready, entryKinds, model, treePaths]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands every directory in the Pierre tree model while expand-all is on and no search is active
  useEffect(() => {
    if (expandAll && !query.trim())
      setAllDirectoriesExpanded(model, expandableDirectoryPaths, true);
  }, [expandableDirectoryPaths, expandAll, model, query]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally selected path in the Pierre tree model by expanding, selecting and scrolling
  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const selectedKind = entryKinds.get(selectedPath);
    if (selectedKind === undefined) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Refresh rebuilds treePaths; replaying handled reveals would close search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    const selectedTreePath = selectedKind === "directory" ? `${selectedPath}/` : selectedPath;
    const selectedItem = model.getItem(selectedTreePath);
    if (!selectedItem) return;

    // Reveal only external selections; tree selections are visible and re-revealing would close search.
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory paths include trailing slashes; ancestor lookups must match.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: "center",
    });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId]);

  const selectedTreePaths = useFileTreeSelection(model);
  const gridSelectedPaths = new Set(selectedTreePaths.map(fromTreePath));
  const withSyncedSelection = (update: () => void) => {
    syncingSelectionRef.current = true;
    update();
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  };
  // A file opens on click, as in the tree; a folder only selects until opened.
  const activateGridEntry = useStableCallback(
    (entry: GridEntry, modifiers: { mod: boolean; shift: boolean }) => {
      if (modifiers.shift) {
        const range = new Set(
          gridRangePaths(
            gridEntries.map((candidate) => candidate.path),
            gridAnchorRef.current,
            entry.path,
          ),
        );
        withSyncedSelection(() => {
          if (!modifiers.mod) {
            for (const selected of model.getSelectedPaths()) {
              if (!range.has(fromTreePath(selected))) model.getItem(selected)?.deselect();
            }
          }
          for (const candidate of gridEntries) {
            if (range.has(candidate.path)) model.getItem(treePathOf(candidate))?.select();
          }
        });
        return;
      }
      gridAnchorRef.current = entry.path;
      if (modifiers.mod) {
        withSyncedSelection(() => model.getItem(treePathOf(entry))?.toggleSelect());
        return;
      }
      selectOnly(treePathOf(entry));
      if (entry.kind === "file") onOpenFile(panelPath(entry.path));
    },
  );
  const openGridEntry = useStableCallback((entry: GridEntry) => {
    if (entry.kind === "directory") {
      view?.onEnterFolder(entry.path);
      return;
    }
    selectOnly(treePathOf(entry));
    onOpenFile(panelPath(entry.path));
  });
  const renameGridEntry = useStableCallback((entry: GridEntry, name: string | null) => {
    setGridRenamingPath(null);
    if (!name || name === entry.name) return;
    setGridRenamed({ path: entry.path, name, listing: gridListing });
    void renameFileEntry(operations, entry.path, name).then((renamed) => {
      if (!renamed) setGridRenamed(null);
    });
  });
  const focusGridEntry = useStableCallback((entry: GridEntry) => {
    gridAnchorRef.current = entry.path;
    selectOnly(treePathOf(entry));
  });
  const goUpGrid = useStableCallback(() => view?.onUp?.());
  const startGridRename = useStableCallback((entry: GridEntry) => {
    if (canWrite) setGridRenamingPath(entry.path);
  });
  const showGridTileContextMenu = useStableCallback((entry: GridEntry, element: HTMLElement) =>
    showEntryContextMenu({ path: treePathOf(entry) }, { anchorElement: element, close: () => {} }),
  );
  const budgetKey = view?.budgetKey;
  const thumbnailResource = view?.thumbnailResource;
  const gridThumbnails: GridThumbnails | null =
    budgetKey !== undefined && thumbnailResource
      ? {
          budget: thumbnailBudget(budgetKey),
          epoch: thumbnailEpoch,
          absolutePathOf: (path) => absoluteFilePath(path, cwd),
          resourceOf: thumbnailResource,
        }
      : null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      // Capture runs before the tree's shadow-internal row handler opens the menu.
      onContextMenuCapture={(event) => {
        contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      }}
      // Capture dragstart before the tree selects the row so selection sees the drag flag.
      onDragStartCapture={(event) => dragMention.handleDragStart(event.nativeEvent)}
      onDragEnd={() => dragMention.handleDragEnd((path) => model.getItem(path)?.deselect())}
      onKeyDown={(event) => {
        handleOperationShortcut(event);
        if (event.defaultPrevented) return;
        const isModPressed = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
        if (!isModPressed || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f")
          return;
        event.preventDefault();
        focusSearch();
      }}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        <FileSearchField
          ref={searchInputRef}
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={closeSearch}
        />
        {view ? (
          <>
            {gridRequested ? (
              <SubheaderButton
                label="Go to enclosing folder"
                disabled={view.onUp === null}
                onClick={() => view.onUp?.()}
              >
                <ArrowUpIcon className="size-3.5" />
              </SubheaderButton>
            ) : null}
            <SubheaderButton
              label="Show as list"
              pressed={!gridRequested}
              onClick={() => view.onModeChange("list")}
            >
              <ListIcon className="size-3.5" />
            </SubheaderButton>
            <SubheaderButton
              label="Show as icons"
              pressed={gridRequested}
              onClick={() => view.onModeChange("grid")}
            >
              <LayoutGridIcon className="size-3.5" />
            </SubheaderButton>
          </>
        ) : null}
        {directoryPaths.length > 0 && !hostFolder && !gridRequested ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    expandAll || allDirectoriesExpanded
                      ? "Collapse all folders"
                      : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {expandAll || allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {error || pathSearch.error ? (
        <button
          type="button"
          onClick={handleRefresh}
          className="p-4 text-left text-xs leading-relaxed text-destructive"
        >
          {error ?? pathSearch.error} Click to retry.
        </button>
      ) : null}
      {gridRequested && gridTooLarge && !query.trim() ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          This folder has {gridListing?.length.toLocaleString()} items, too many for icons, so it
          shows as a list.
        </div>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      {(!ready || pathSearch.isPending) && (
        <div
          role="status"
          className={
            entries.length > 0 && !hasNoSearchMatches
              ? "sr-only"
              : "px-3 py-1 text-xs text-muted-foreground"
          }
        >
          Loading files…
        </div>
      )}
      {hasNoSearchMatches ? (
        ready && !isPending && !pathSearch.isPending && !error && !pathSearch.error ? (
          <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
            No matching files.
          </div>
        ) : null
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          onContextMenu={showFolderContextMenu}
          // Keeps these keys from the app's shortcuts, such as Mod+D, while a row has focus.
          {...(canWrite
            ? {
                "aria-keyshortcuts": FILE_OPERATION_SHORTCUTS,
                "data-local-shortcuts": FILE_OPERATION_SHORTCUTS,
              }
            : {})}
        >
          {gridActive && gridThumbnails ? (
            gridListing === undefined ? (
              loadingDirectories.has(gridFolder) ? (
                <div role="status" className="px-3 py-1 text-xs text-muted-foreground">
                  Loading files…
                </div>
              ) : null
            ) : (
              <FileGridView
                environmentId={environmentId}
                ariaLabel={`${projectName} files`}
                folderKey={`${environmentId}:${cwd}:${gridFolder}`}
                entries={gridEntries}
                selectedPaths={gridSelectedPaths}
                initialPath={
                  view?.returnPath ??
                  gridEntries.find((entry) => gridSelectedPaths.has(entry.path))?.path ??
                  null
                }
                renamingPath={canWrite ? gridRenamingPath : null}
                renamed={gridRenameOverride}
                theme={resolvedTheme}
                thumbnails={gridThumbnails}
                onActivate={activateGridEntry}
                onOpen={openGridEntry}
                onFocusMove={focusGridEntry}
                onUp={goUpGrid}
                onStartRename={startGridRename}
                onRename={renameGridEntry}
                onTileContextMenu={showGridTileContextMenu}
              />
            )
          ) : (
            <FileTree
              model={model}
              aria-label={`${projectName} files`}
              className="min-h-0 flex-1 overflow-hidden"
              style={pierreTreeStyle(resolvedTheme)}
            />
          )}
        </div>
      )}
    </div>
  );
}
