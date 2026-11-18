import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  memo,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button } from "~/components/ui/button";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isMacPlatform } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { useRemoteOpenResolution } from "~/remoteOpen";
import { useFilesystemReadAccess } from "~/state/filesystem";

import {
  GRID_PADDING,
  GRID_ROW_HEIGHT,
  type GridEntry,
  gridColumnCount,
  moveGridIndex,
} from "./fileGrid.logic";
import type { ThumbnailBudget } from "./fileThumbnails.logic";
import { useFileThumbnail, useThumbnailBudgetGeneration } from "./fileThumbnails";

export interface GridThumbnails {
  readonly budget: ThumbnailBudget;
  readonly epoch: number;
  readonly absolutePathOf: (path: string) => string;
  readonly resourceOf: (absolutePath: string) => AssetResource | null;
}

interface GridModifiers {
  readonly mod: boolean;
  readonly shift: boolean;
}

interface FileGridViewProps {
  readonly environmentId: EnvironmentId;
  readonly ariaLabel: string;
  /** Changes with the folder, so scroll and focus start over in each one. */
  readonly folderKey: string;
  readonly entries: readonly GridEntry[];
  readonly selectedPaths: ReadonlySet<string>;
  /** The tile to show first, such as the folder just left by going up. */
  readonly initialPath: string | null;
  readonly renamingPath: string | null;
  /** A rename's new name, shown before the listing catches up. */
  readonly renamed: { readonly path: string; readonly name: string } | null;
  readonly theme: "light" | "dark";
  readonly thumbnails: GridThumbnails;
  readonly onActivate: (entry: GridEntry, modifiers: GridModifiers) => void;
  readonly onOpen: (entry: GridEntry) => void;
  readonly onFocusMove: (entry: GridEntry) => void;
  readonly onUp: () => void;
  readonly onStartRename: (entry: GridEntry) => void;
  readonly onRename: (entry: GridEntry, name: string | null) => void;
  readonly onTileContextMenu: (entry: GridEntry, element: HTMLElement) => void;
}

const GRID_SHORTCUTS = "Meta+ArrowUp Control+ArrowUp";

export const treePathOf = (entry: GridEntry) =>
  entry.kind === "directory" ? `${entry.path}/` : entry.path;

export function FileGridView(props: FileGridViewProps) {
  const { entries } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<LegendListRef>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const [width, setWidth] = useState(0);
  const initialIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.path === props.initialPath),
  );
  const [focus, setFocus] = useState({ folderKey: props.folderKey, index: initialIndex });
  if (focus.folderKey !== props.folderKey)
    setFocus({ folderKey: props.folderKey, index: initialIndex });
  const focusedIndex = Math.min(
    focus.folderKey === props.folderKey ? focus.index : initialIndex,
    Math.max(0, entries.length - 1),
  );
  const columns = gridColumnCount(width);
  // A hidden panel tab keeps its grid mounted at zero width; it starts no thumbnail work.
  const visible = width > 0;
  const { canReadFiles } = useFilesystemReadAccess(props.environmentId);
  const remoteResolution = useRemoteOpenResolution(props.environmentId);
  // Until the connection is known, assume the stricter remote limits.
  const remote = !remoteResolution.isResolved || remoteResolution.state.mode !== "local-exec";
  const { budget } = props.thumbnails;
  useThumbnailBudgetGeneration(budget);
  const previewsPaused = remote && budget.exhausted;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the pane, whose width sets the column count and whether the panel is shown
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setWidth(container.clientWidth);
    return observeResize(container, ([entry]) => setWidth(entry?.contentRect.width ?? 0));
  }, []);

  /** A tile scrolled into view for keyboard focus takes it once it mounts. */
  const takePendingFocus = useStableCallback((path: string) => {
    if (pendingFocusRef.current !== path) return false;
    pendingFocusRef.current = null;
    return true;
  });
  const onFocusTile = useStableCallback((index: number) =>
    setFocus({ folderKey: props.folderKey, index }),
  );
  // Virtualization unmounts a tile scrolled far away; the listbox keeps focus and keys for it.
  const onTileFocusLost = useStableCallback(() =>
    containerRef.current?.focus({ preventScroll: true }),
  );

  const focusTile = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    setFocus({ folderKey: props.folderKey, index });
    const tile = containerRef.current?.querySelector<HTMLElement>(`[data-grid-index="${index}"]`);
    if (tile) {
      tile.focus({ preventScroll: false });
      return;
    }
    pendingFocusRef.current = entry.path;
    void listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
  };

  const focusShownFolder = useEffectEvent(() => {
    const active = document.activeElement;
    const container = containerRef.current;
    if (!container?.getClientRects().length || entries.length === 0) return;
    if (active === null || active === document.body || container.contains(active)) {
      focusTile(initialIndex);
    }
  });
  const hasEntries = entries.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus into a newly shown folder when the focused tile went away with the old one; refreshes in place keep focus
  useEffect(
    () => focusShownFolder(),
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new folder, or the first entries of one, is what moves focus.
    [props.folderKey, hasEntries],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    const isMod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    if (isMod && !event.altKey && !event.shiftKey && event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      props.onUp();
      return;
    }
    if (isMod || event.altKey) return;
    const entry = entries[focusedIndex];
    if (event.key === "Enter" && entry) {
      event.preventDefault();
      props.onOpen(entry);
      return;
    }
    if (event.key === "F2" && entry) {
      event.preventDefault();
      focusTile(focusedIndex);
      props.onStartRename(entry);
      return;
    }
    const next = moveGridIndex(focusedIndex, event.key, columns, entries.length);
    if (next === null || event.shiftKey) return;
    event.preventDefault();
    const target = entries[next];
    if (!target) return;
    focusTile(next);
    props.onFocusMove(target);
  };

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={props.ariaLabel}
      aria-multiselectable
      tabIndex={0}
      data-file-grid
      data-focused-path={entries[focusedIndex]?.path}
      className="flex min-h-0 flex-1 flex-col outline-none"
      // Mod+ArrowUp goes up a folder here instead of reaching the app's shortcuts.
      aria-keyshortcuts={GRID_SHORTCUTS}
      data-local-shortcuts={GRID_SHORTCUTS}
      onKeyDown={handleKeyDown}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return;
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        focusTile(focusedIndex);
      }}
    >
      {previewsPaused ? (
        <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Previews paused to limit data over this connection.
          </span>
          <Button type="button" size="xs" variant="outline" onClick={() => budget.extend()}>
            Load previews
          </Button>
        </div>
      ) : null}
      {entries.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground">This folder is empty.</div>
      ) : (
        <LegendList<GridEntry>
          key={props.folderKey}
          ref={listRef}
          data={entries}
          numColumns={columns}
          keyExtractor={(entry) => entry.path}
          extraData={{
            selected: props.selectedPaths,
            focusedIndex,
            renaming: props.renamingPath,
            thumbnailsEnabled: canReadFiles && visible,
            remote,
            thumbnails: props.thumbnails,
            renamed: props.renamed,
          }}
          initialScrollIndex={{ index: focusedIndex, viewPosition: 0.5 }}
          estimatedItemSize={GRID_ROW_HEIGHT}
          getFixedItemSize={() => GRID_ROW_HEIGHT}
          drawDistance={GRID_ROW_HEIGHT * 2}
          className="min-h-0 flex-1"
          style={{ paddingInline: GRID_PADDING, paddingBlock: GRID_PADDING / 2 }}
          renderItem={({ item, index }) => (
            <GridTile
              entry={item}
              index={index}
              environmentId={props.environmentId}
              name={props.renamed?.path === item.path ? props.renamed.name : item.name}
              selected={props.selectedPaths.has(item.path)}
              focused={index === focusedIndex}
              renaming={props.renamingPath === item.path}
              theme={props.theme}
              thumbnails={props.thumbnails}
              thumbnailsEnabled={canReadFiles && visible}
              remote={remote}
              takePendingFocus={takePendingFocus}
              onFocusTile={onFocusTile}
              onFocusLost={onTileFocusLost}
              onActivate={props.onActivate}
              onOpen={props.onOpen}
              onRename={props.onRename}
              onContextMenu={props.onTileContextMenu}
            />
          )}
        />
      )}
    </div>
  );
}

const GridTile = memo(function GridTile(props: {
  entry: GridEntry;
  index: number;
  environmentId: EnvironmentId;
  name: string;
  selected: boolean;
  focused: boolean;
  renaming: boolean;
  theme: "light" | "dark";
  thumbnails: GridThumbnails;
  thumbnailsEnabled: boolean;
  remote: boolean;
  takePendingFocus: (path: string) => boolean;
  onFocusTile: (index: number) => void;
  onFocusLost: () => void;
  onActivate: FileGridViewProps["onActivate"];
  onOpen: FileGridViewProps["onOpen"];
  onRename: FileGridViewProps["onRename"];
  onContextMenu: FileGridViewProps["onTileContextMenu"];
}) {
  const { entry, thumbnails, takePendingFocus, onFocusLost } = props;
  // Keeps one identity across renders, so its cleanup runs only when the tile unmounts.
  const tileRef = (element: HTMLDivElement) => {
    if (takePendingFocus(entry.path)) element.focus({ preventScroll: true });
    return () => {
      if (element.contains(document.activeElement)) onFocusLost();
    };
  };
  const absolutePath = thumbnails.absolutePathOf(entry.path);
  const thumbnail = useFileThumbnail({
    environmentId: props.environmentId,
    absolutePath,
    resource: entry.kind === "file" ? thumbnails.resourceOf(absolutePath) : null,
    enabled: props.thumbnailsEnabled && entry.kind === "file",
    remote: props.remote,
    budget: thumbnails.budget,
    epoch: thumbnails.epoch,
  });
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || props.renaming) return;
    const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
    props.onActivate(entry, { mod, shift: event.shiftKey });
  };
  return (
    <div
      ref={tileRef}
      role="option"
      aria-selected={props.selected}
      tabIndex={props.focused ? 0 : -1}
      draggable={!props.renaming}
      data-grid-tile
      data-grid-index={props.index}
      data-item-path={treePathOf(entry)}
      className="mx-auto flex h-[92px] w-20 cursor-default flex-col items-center gap-1 rounded-md px-1 pt-1.5 text-center text-foreground outline-none select-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-selected:bg-accent data-[ignored]:opacity-60"
      data-ignored={entry.ignored || undefined}
      onFocus={() => props.onFocusTile(props.index)}
      onClick={handleClick}
      onDoubleClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || props.renaming) return;
        if (entry.kind === "directory") props.onOpen(entry);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(entry, event.currentTarget);
      }}
    >
      <div className="flex h-12 w-16 shrink-0 items-center justify-center">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            draggable={false}
            decoding="async"
            className="max-h-12 max-w-16 rounded-sm object-contain"
          />
        ) : (
          <PierreEntryIcon
            pathValue={entry.path}
            kind={entry.kind}
            theme={props.theme}
            className="size-9"
          />
        )}
      </div>
      {props.renaming ? (
        <GridRenameInput entry={entry} name={props.name} onRename={props.onRename} />
      ) : (
        <span className="line-clamp-2 w-full text-2xs leading-tight break-all">{props.name}</span>
      )}
    </div>
  );
});

function GridRenameInput(props: {
  entry: GridEntry;
  name: string;
  onRename: FileGridViewProps["onRename"];
}) {
  const doneRef = useRef(false);
  const finish = (name: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    props.onRename(props.entry, name);
  };
  return (
    <input
      ref={(input) => {
        if (!input || doneRef.current || document.activeElement === input) return;
        input.focus();
        const dot = props.entry.kind === "file" ? props.name.lastIndexOf(".") : -1;
        input.setSelectionRange(0, dot > 0 ? dot : props.name.length);
      }}
      aria-label={`Rename ${props.name}`}
      defaultValue={props.name}
      spellCheck={false}
      className="w-full min-w-0 rounded-sm border border-ring bg-background px-0.5 text-center text-2xs leading-tight outline-none"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value.trim());
        else if (event.key === "Escape") finish(null);
      }}
      onBlur={(event) => finish(event.currentTarget.value.trim())}
    />
  );
}
