import { useAtomValue } from "@effect/atom-react";
import { THREAD_SEARCH_QUERY_MAX_LENGTH } from "@t3tools/contracts";
import { matchesKeybindingShortcut } from "@t3tools/shared/keybindingMatching";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { useDeferredValue, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useTheme } from "~/hooks/useTheme";
import { formatShortcutLabel } from "~/keybindings";
import { useRightPanelStore } from "~/rightPanelStore";
import { clientHostEnvironmentAtom } from "~/state/clientHostEnvironment";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentPresentation } from "~/state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { CommandPaletteContent } from "../CommandPaletteContent";
import {
  buildRecentThreadItems,
  buildRootGroups,
  filterCommandPaletteGroups,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "../CommandPalette.logic";
import { CommandPaletteResults } from "../CommandPaletteResults";
import { useCommandPaletteThreadItems } from "../CommandPaletteThreadItems";
import { Kbd, KbdGroup } from "../ui/kbd";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  capProjectFilePickerThreadGroups,
  getProjectFilePickerSections,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
  PROJECT_FILE_PICKER_SCOPE_SHORTCUT,
  PROJECT_FILE_PICKER_TABS,
  projectFilePickerEmptyState,
  projectFilePickerHostScopeDisabledReason,
  projectFilePickerPastedPath,
  projectFilePickerPathFilter,
  stepProjectFilePickerTab,
  type ProjectFilePickerMatch,
  type ProjectFilePickerMatchRange,
  type ProjectFilePickerScope,
  type ProjectFilePickerTab,
} from "./ProjectFilePicker.logic";
import { useHostFilePickerQuery, useProjectFilePickerQuery } from "./projectFilesQueryState";

interface ProjectFilePickerProps {
  readonly setOpen: (open: boolean) => void;
}

interface ThreadSearchSection {
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly query: string;
  readonly isPending: boolean;
}

const NO_THREAD_SEARCH: ThreadSearchSection = { groups: [], query: "", isPending: false };

export function HighlightedFuzzyText(props: {
  readonly active: boolean;
  readonly ranges: ReadonlyArray<ProjectFilePickerMatchRange>;
  readonly value: string;
}) {
  if (!props.active) return props.value;

  const parts: ReactNode[] = [];
  let start = 0;
  for (const range of props.ranges) {
    if (start < range.start) parts.push(props.value.slice(start, range.start));
    parts.push(
      <strong className="font-semibold text-foreground" key={range.start}>
        {props.value.slice(range.start, range.end)}
      </strong>,
    );
    start = range.end;
  }
  if (start < props.value.length) parts.push(props.value.slice(start));

  return <span className="text-muted-foreground">{parts}</span>;
}

function inputPlaceholder(tab: ProjectFilePickerTab): string {
  switch (tab) {
    case "all":
      return "Search files, folders, and threads…";
    case "folders":
      return "Search folders…";
    case "threads":
      return "Search threads…";
    default:
      return "Search files…";
  }
}

/** The same thread rows, ranking and actions as the command palette's thread search. */
function ProjectFilePickerThreadSearch(props: {
  readonly query: string;
  readonly tab: ProjectFilePickerTab;
  readonly children: (threads: ThreadSearchSection) => ReactNode;
}) {
  const { activeThread } = useHandleNewThread();
  const query = useDeferredValue(props.query);
  const { threadItems, threadMessageItems, now, isSearchPending } = useCommandPaletteThreadItems({
    activeThread: activeThread ?? null,
    threadSearchQuery: query,
  });
  const groups = filterCommandPaletteGroups({
    activeGroups: buildRootGroups({
      actionItems: [],
      recentThreadItems: buildRecentThreadItems(threadItems, activeThread),
    }),
    query,
    isInSubmenu: false,
    projectSearchItems: [],
    threadSearchItems: threadItems,
    threadMessageItems,
    now,
  });
  return props.children({
    groups: capProjectFilePickerThreadGroups(groups, props.tab),
    query,
    isPending: isSearchPending,
  });
}

function EmptyProjectFilePicker() {
  return (
    <CommandPaletteContent
      aria-label="File picker"
      escapeLabel="Back"
      footerActionLabel="Open"
      inputProps={{ disabled: true, placeholder: "Search files…" }}
      mode="none"
      testId="project-file-picker"
      value=""
    >
      <div className="py-10 text-center text-sm text-muted-foreground">
        Open a project to search its files.
      </div>
    </CommandPaletteContent>
  );
}

function OpenProjectFilePicker(props: ProjectFilePickerProps & { target: ActiveProjectTarget }) {
  const { target } = props;
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<ProjectFilePickerTab>("all");
  const [scope, setScope] = useState<ProjectFilePickerScope>("project");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const fileAccess = useFilesystemReadAccess(target.environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(target.environmentId));
  const isClientHost = useAtomValue(clientHostEnvironmentAtom(target.environmentId));
  const environmentLabel =
    useEnvironmentPresentation(target.environmentId).presentation?.entry.target.label ?? "Host";
  const hostScopeLabel = isClientHost ? "This computer" : environmentLabel;
  const hostName = isClientHost ? "this computer" : environmentLabel;
  const hostScopeDisabledReason = projectFilePickerHostScopeDisabledReason({
    hostFileSearch: serverConfig?.hostFileSearch,
    canReadFiles: fileAccess.canReadFiles,
  });
  const activeScope: ProjectFilePickerScope = hostScopeDisabledReason === null ? scope : "project";
  const pasted = fileAccess.canReadFiles ? projectFilePickerPastedPath(query) : null;
  const pastedPath = pasted?.path ?? null;
  const pathFilter = projectFilePickerPathFilter(tab);
  const projectResult = useProjectFilePickerQuery(
    target.environmentId,
    target.cwd,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
    activeScope === "project" ? pathFilter : null,
  );
  // A pasted path opens from its own row; the host's name index would not match it.
  const hostResult = useHostFilePickerQuery(
    target.environmentId,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
    activeScope === "host" && !pasted?.leads ? pathFilter : null,
  );
  const result = activeScope === "host" ? hostResult : projectResult;
  const { resolvedTheme } = useTheme();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sections = getProjectFilePickerSections(result.entries, result.matchedQuery, tab);
  const hasMatchedQuery = /\S/.test(result.matchedQuery);
  // A host path inside the project opens as the project's file, with its tree and editor. A pasted
  // `~/` path stays a host file: the client does not know the host's home folder.
  const openablePath = (path: string) => workspaceRelativeFilePath(path, target.cwd) ?? path;
  const pathItem =
    (kind: "file" | "directory") =>
    (match: ProjectFilePickerMatch): CommandPaletteActionItem => ({
      kind: "action",
      value: `${kind === "file" ? "file" : "folder"}:${match.path}`,
      searchTerms: [match.name, match.path],
      title: (
        <HighlightedFuzzyText
          active={hasMatchedQuery}
          value={match.name}
          ranges={match.nameMatchRanges}
        />
      ),
      description: (
        <HighlightedFuzzyText
          active={hasMatchedQuery}
          value={match.path}
          ranges={match.pathMatchRanges}
        />
      ),
      icon: <PierreEntryIcon pathValue={match.path} kind={kind} theme={resolvedTheme} />,
      // A folder path opens as a folder surface in the Files panel.
      run: async () => {
        useRightPanelStore.getState().openFile(target.threadRef, openablePath(match.path));
      },
    });
  const pastedPathValue = pastedPath === null ? null : `open-path:${pastedPath}`;
  const pastedPathGroups: CommandPaletteGroup[] =
    pastedPath === null
      ? []
      : [
          {
            value: "open-path",
            label: "Path",
            items: [
              {
                kind: "action",
                value: `open-path:${pastedPath}`,
                searchTerms: [pastedPath],
                title: `Open ${pastedPath}`,
                icon: (
                  <PierreEntryIcon
                    pathValue={pastedPath}
                    kind={/[/\\]$/.test(pastedPath) ? "directory" : "file"}
                    theme={resolvedTheme}
                  />
                ),
                run: async () => {
                  useRightPanelStore
                    .getState()
                    .openFile(target.threadRef, openablePath(pastedPath));
                },
              },
            ],
          },
        ];
  const pathGroups: CommandPaletteGroup[] = [
    { value: "project-files", label: "Files", items: sections.files.map(pathItem("file")) },
    {
      value: "project-folders",
      label: "Folders",
      items: sections.folders.map(pathItem("directory")),
    },
  ].filter((group) => group.items.length > 0);

  const toggleScope = () => {
    if (hostScopeDisabledReason !== null) return;
    setHighlightedItemValue(null);
    setScope(activeScope === "project" ? "host" : "project");
  };
  const selectTab = (next: ProjectFilePickerTab) => {
    setHighlightedItemValue(null);
    setTab(next);
    tabsRef.current
      ?.querySelector(`[data-picker-tab="${next}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const togglesScope = matchesKeybindingShortcut(
      event.nativeEvent,
      PROJECT_FILE_PICKER_SCOPE_SHORTCUT,
      navigator.platform,
    );
    if (!togglesScope && (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey)) {
      return;
    }
    (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
    event.preventDefault();
    if (togglesScope) toggleScope();
    else selectTab(stepProjectFilePickerTab(tab, event.shiftKey ? -1 : 1));
  };

  const hostScopeToggle = (
    <Toggle disabled={hostScopeDisabledReason !== null} value="host">
      {hostScopeLabel}
    </Toggle>
  );

  const tabs = (
    <div className="px-2 pb-1.5">
      <ScrollArea hideScrollbars radius="none" scrollFade>
        <div className="flex w-max items-center gap-2">
          <ToggleGroup
            aria-label="Search scope"
            variant="segmented"
            value={[activeScope]}
            onMouseDown={(event) => event.preventDefault()}
            onValueChange={(next) => {
              if (next[0] !== undefined && next[0] !== activeScope) toggleScope();
            }}
          >
            <Toggle value="project">Project</Toggle>
            {hostScopeDisabledReason === null ? (
              hostScopeToggle
            ) : (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  {hostScopeToggle}
                </TooltipTrigger>
                <TooltipPopup side="bottom">{hostScopeDisabledReason}</TooltipPopup>
              </Tooltip>
            )}
          </ToggleGroup>
          <ToggleGroup
            aria-label="Search category"
            ref={tabsRef}
            variant="segmented"
            value={[tab]}
            // Clicking a tab keeps focus, and so typing, in the search input.
            onMouseDown={(event) => event.preventDefault()}
            onValueChange={(next) => {
              const value = PROJECT_FILE_PICKER_TABS.find((option) => option.value === next[0]);
              if (value) selectTab(value.value);
            }}
          >
            {PROJECT_FILE_PICKER_TABS.map((option) => (
              <Toggle data-picker-tab={option.value} key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </ScrollArea>
    </div>
  );

  const renderResults = (threads: ThreadSearchSection) => {
    const normalizedThreadQuery = query.trim().slice(0, THREAD_SEARCH_QUERY_MAX_LENGTH).trim();
    const isPending = (pathFilter !== null && result.isPending) || threads.isPending;
    return (
      <CommandPaletteResults
        groups={
          pasted?.leads
            ? [...pastedPathGroups, ...pathGroups, ...threads.groups]
            : [...pathGroups, ...pastedPathGroups, ...threads.groups]
        }
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action") return;
          // Rows kept from an earlier query must not open from an Enter typed ahead of the search.
          const isCurrent = item.value.startsWith("thread:")
            ? threads.query === query &&
              (item.threadContentMatch === undefined ||
                item.threadContentMatch.query === normalizedThreadQuery)
            : item.value.startsWith("open-path:")
              ? item.value === pastedPathValue
              : result.matchedQuery === query.trim();
          if (!isCurrent) return;
          props.setOpen(false);
          void item.run();
        }}
        emptyStateMessage={projectFilePickerEmptyState({
          scope: activeScope,
          tab,
          query,
          error: result.error,
          isPending,
          truncated: hostResult.truncated && hostResult.entries.length === 0,
          queryTooShort: hostResult.queryTooShort,
          hostName,
        })}
      />
    );
  };

  return (
    <CommandPaletteContent
      aria-label="File picker"
      autoHighlight="always"
      escapeLabel="Back"
      footerActionLabel="Open"
      footerTrailing={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {hostScopeDisabledReason === null ? (
            <KbdGroup>
              <Kbd>{formatShortcutLabel(PROJECT_FILE_PICKER_SCOPE_SHORTCUT)}</Kbd>
              <span>Switch scope</span>
            </KbdGroup>
          ) : null}
          <KbdGroup>
            <Kbd>Tab</Kbd>
            <span>Switch category</span>
          </KbdGroup>
        </div>
      }
      inputAccessory={tabs}
      inputProps={{ placeholder: inputPlaceholder(tab), onKeyDown: handleKeyDown }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      panelSize="tall-list"
      testId="project-file-picker"
      value={query}
    >
      {tab === "all" || tab === "threads" ? (
        <ProjectFilePickerThreadSearch query={query} tab={tab}>
          {renderResults}
        </ProjectFilePickerThreadSearch>
      ) : (
        renderResults(NO_THREAD_SEARCH)
      )}
    </CommandPaletteContent>
  );
}

export function ProjectFilePicker(props: ProjectFilePickerProps) {
  const target = useActiveProjectTarget();

  if (!target) {
    return <EmptyProjectFilePicker />;
  }

  return <OpenProjectFilePicker setOpen={props.setOpen} target={target} />;
}
