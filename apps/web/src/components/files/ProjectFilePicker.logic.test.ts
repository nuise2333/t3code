import { assert, describe, it } from "vite-plus/test";

import type { ProjectEntry } from "@t3tools/contracts";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import {
  capProjectFilePickerThreadGroups,
  getProjectFilePickerMatches,
  getProjectFilePickerSections,
  projectFilePickerEmptyState,
  projectFilePickerHostScopeDisabledReason,
  projectFilePickerPastedPath,
} from "./ProjectFilePicker.logic";

function pathsForQuery(entries: Parameters<typeof getProjectFilePickerMatches>[0], query: string) {
  return getProjectFilePickerMatches(entries, query).map(({ name, path }) => ({ name, path }));
}

describe("getProjectFilePickerMatches", () => {
  it("preserves server order for every file entry", () => {
    const fuzzyEntries = [
      { kind: "file", path: "src/TestFlags.tsx" },
      { kind: "file", path: "src/SubtestFlow.tsx" },
      { kind: "file", path: "src/useSubtestFlags.ts" },
      {
        kind: "file",
        path: "src/useSubtestFlags/useTabActivity.ts",
      },
    ] as const;

    assert.deepEqual(
      pathsForQuery(fuzzyEntries, "testf").map(({ name }) => name),
      ["TestFlags.tsx", "SubtestFlow.tsx", "useSubtestFlags.ts", "useTabActivity.ts"],
    );
  });

  it.each([
    {
      path: "src/TestFlags.tsx",
      query: "tsfl",
      nameMatchRanges: [
        { start: 0, end: 1 },
        { start: 2, end: 3 },
        { start: 4, end: 6 },
      ],
      pathMatchRanges: [
        { start: 4, end: 5 },
        { start: 6, end: 7 },
        { start: 8, end: 10 },
      ],
    },
    {
      path: "src/index.ts",
      query: "@/src",
      nameMatchRanges: [],
      pathMatchRanges: [{ start: 0, end: 3 }],
    },
    {
      path: "tests/button.ts",
      query: "button test",
      nameMatchRanges: [{ start: 0, end: 6 }],
      pathMatchRanges: [
        { start: 0, end: 4 },
        { start: 6, end: 12 },
      ],
    },
    {
      path: "src/useSubtestFlags.ts",
      query: "flags",
      nameMatchRanges: [{ start: 10, end: 15 }],
      pathMatchRanges: [{ start: 14, end: 19 }],
    },
    {
      path: "src/fileLoader/flags.ts",
      query: "flags",
      nameMatchRanges: [{ start: 0, end: 5 }],
      pathMatchRanges: [{ start: 15, end: 20 }],
    },
  ])("highlights $query in $path", ({ path, query, nameMatchRanges, pathMatchRanges }) => {
    const match = getProjectFilePickerMatches([{ kind: "file", path }], query)[0];
    assert.deepEqual(match?.nameMatchRanges, nameMatchRanges);
    assert.deepEqual(match?.pathMatchRanges, pathMatchRanges);
  });
});

describe("getProjectFilePickerSections", () => {
  const entries: ProjectEntry[] = [
    { kind: "directory", path: "docs" },
    { kind: "file", path: "docs/guide.md" },
    { kind: "file", path: "src/index.ts" },
    { kind: "directory", path: "src" },
    { kind: "file", path: "assets/logo.png" },
    { kind: "file", path: ".gitignore" },
  ];

  it.each([
    {
      tab: "all",
      files: ["docs/guide.md", "src/index.ts", "assets/logo.png", ".gitignore"],
      folders: ["docs", "src"],
    },
    {
      tab: "files",
      files: ["docs/guide.md", "src/index.ts", "assets/logo.png", ".gitignore"],
      folders: [],
    },
    { tab: "folders", files: [], folders: ["docs", "src"] },
    { tab: "document", files: ["docs/guide.md"], folders: [] },
    { tab: "image", files: ["assets/logo.png"], folders: [] },
    { tab: "archive", files: [], folders: [] },
    { tab: "threads", files: [], folders: [] },
  ] as const)("splits $tab results in server order", ({ tab, files, folders }) => {
    const sections = getProjectFilePickerSections(entries, "", tab);
    assert.deepEqual(
      sections.files.map((match) => match.path),
      [...files],
    );
    assert.deepEqual(
      sections.folders.map((match) => match.path),
      [...folders],
    );
  });

  it("names host results by their basename on either separator", () => {
    const sections = getProjectFilePickerSections(
      [
        { kind: "file", path: "C:\\Users\\me\\report.pdf" },
        { kind: "directory", path: "/Users/me/Downloads" },
      ],
      "",
      "all",
    );
    assert.deepEqual(
      [...sections.files, ...sections.folders].map((match) => match.name),
      ["report.pdf", "Downloads"],
    );
  });

  it("caps each All section while other tabs keep the full limit", () => {
    const many: ProjectEntry[] = Array.from({ length: 120 }, (_, index) => ({
      kind: index % 2 === 0 ? "file" : "directory",
      path: `entry-${index}.ts`,
    }));
    const all = getProjectFilePickerSections(many, "", "all");
    assert.equal(all.files.length, 50);
    assert.equal(all.folders.length, 20);
    assert.equal(getProjectFilePickerSections(many, "", "code").files.length, 60);
    assert.equal(getProjectFilePickerSections(many, "", "folders").folders.length, 60);
  });
});

describe("capProjectFilePickerThreadGroups", () => {
  const item = (value: string): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [],
    title: value,
    icon: null,
    run: async () => {},
  });
  const groups = [
    {
      value: "threads-search",
      label: "Threads",
      items: Array.from({ length: 15 }, (_, i) => item(`t${i}`)),
    },
    {
      value: "threads-messages",
      label: "In messages",
      items: Array.from({ length: 10 }, (_, i) => item(`m${i}`)),
    },
  ];

  it("shares one row budget across thread sections on All only", () => {
    assert.deepEqual(
      capProjectFilePickerThreadGroups(groups, "all").map((group) => group.items.length),
      [15, 5],
    );
    assert.deepEqual(
      capProjectFilePickerThreadGroups(groups, "threads").map((group) => group.items.length),
      [15, 10],
    );
  });
});

describe("projectFilePickerPastedPath", () => {
  it.each([
    { query: "/Users/me/a.txt", path: "/Users/me/a.txt", leads: true },
    { query: "  ~/Downloads/  ", path: "~/Downloads/", leads: true },
    { query: "~/a", path: "~/a", leads: true },
    { query: "'/Users/me/a b.txt'", path: "/Users/me/a b.txt", leads: true },
    { query: "'/src'", path: "/src", leads: true },
    { query: "C:\\Users\\me\\a.txt", path: "C:\\Users\\me\\a.txt", leads: true },
    { query: "\\\\server\\share", path: "\\\\server\\share", leads: true },
    { query: "file:///src", path: "/src", leads: true },
    { query: "/", path: "/", leads: false },
    { query: "/src", path: "/src", leads: false },
    { query: "/comp", path: "/comp", leads: false },
    { query: "/Users/", path: "/Users/", leads: false },
    { query: "src/index.ts", path: null },
    { query: "index", path: null },
    { query: "~me/a", path: null },
    { query: "file://%", path: null },
  ])("reads $query as $path", ({ query, path, leads }) => {
    assert.deepStrictEqual(
      projectFilePickerPastedPath(query),
      path === null ? null : { path, leads },
    );
  });
});

describe("projectFilePickerHostScopeDisabledReason", () => {
  it.each([
    { hostFileSearch: "spotlight", canReadFiles: true, enabled: true },
    { hostFileSearch: undefined, canReadFiles: true, enabled: false },
    { hostFileSearch: "everything", canReadFiles: false, enabled: false },
  ] as const)(
    "index $hostFileSearch with read access $canReadFiles",
    ({ hostFileSearch, canReadFiles, enabled }) => {
      assert.equal(
        projectFilePickerHostScopeDisabledReason({ hostFileSearch, canReadFiles }) === null,
        enabled,
      );
    },
  );
});

describe("projectFilePickerEmptyState", () => {
  const base = {
    scope: "host",
    tab: "all",
    query: "report",
    error: null,
    isPending: false,
    truncated: false,
    queryTooShort: false,
    hostName: "this computer",
  } as const;

  it.each([
    {
      name: "a failure",
      change: { error: "File search is not available on this host." },
      message: "File search is not available on this host.",
    },
    {
      name: "a short query",
      change: { query: "r", queryTooShort: true },
      message: "Type at least 2 characters to search this computer.",
    },
    { name: "a running search", change: { isPending: true }, message: "Searching this computer…" },
    {
      name: "a deadline with no rows",
      change: { truncated: true },
      message: "Still indexing or slow. Try a longer name.",
    },
    {
      name: "no matches",
      change: {},
      message: "No matches on this computer. Only indexed locations are searched.",
    },
    {
      name: "the threads tab",
      change: { tab: "threads", queryTooShort: true },
      message: "No matching threads.",
    },
    {
      name: "the project scope",
      change: { scope: "project", queryTooShort: true },
      message: "No matching files, folders, or threads.",
    },
  ] as const)("host scope shows $name", ({ change, message }) => {
    assert.equal(projectFilePickerEmptyState({ ...base, ...change }), message);
  });
});
