import { AuthFilesystemReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  sessionWaiting: false,
  phase: "connected" as "connected" | "offline",
  sessionAtom: {},
  searchAtom: {},
  searchRequests: vi.fn(),
  hostSearchAtom: {},
  hostSearchRequests: vi.fn(),
  contentAtom: {},
  contentRequests: vi.fn(),
  contentError: null as string | null,
  contentData: {
    matches: [{ path: "src/index.ts", lineNumber: 3, lineContent: "a match", matchRanges: [] }],
    truncated: false,
  },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(value: A) => [value, vi.fn()],
}));
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./projects", () => ({
  projectEnvironment: {
    searchEntries: (target: unknown) => {
      state.searchRequests(target);
      return state.searchAtom;
    },
  },
  projectContentSearch: (target: unknown) => {
    state.contentRequests(target);
    return state.contentAtom;
  },
}));
vi.mock("./filesystem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./filesystem")>()),
  filesystemEnvironment: {
    searchHost: (target: unknown) => {
      state.hostSearchRequests(target);
      return state.hostSearchAtom;
    },
  },
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./threads", () => ({ useEnvironmentThread: vi.fn() }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === state.sessionAtom
        ? state.session
        : atom === state.searchAtom
          ? { entries: [{ path: "src/index.ts", kind: "file" }] }
          : atom === state.contentAtom
            ? state.contentData
            : null,
    error:
      atom === state.sessionAtom
        ? state.sessionError
        : atom === state.contentAtom
          ? state.contentError
          : null,
    isPending:
      atom === state.sessionAtom &&
      (state.sessionWaiting || (state.session === null && state.sessionError === null)),
    refresh: vi.fn(),
  }),
}));

import {
  retainedProjectPathSearch,
  useComposerPathSearch,
  useHostPathSearch,
  useProjectContentSearch,
} from "./queries";

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  cwd: "/repo",
  query: "src",
};

beforeEach(() => {
  state.session = null;
  state.sessionError = null;
  state.sessionWaiting = false;
  state.phase = "connected";
  state.searchRequests.mockClear();
  state.hostSearchRequests.mockClear();
  state.contentRequests.mockClear();
  state.contentError = null;
});

const contentTarget = {
  ...target,
  query: " a match ",
  caseSensitive: true,
  wholeWord: true,
  useRegex: false,
};

it.each([
  { query: "", expected: "" },
  { query: "src", expected: "src" },
  { query: "a".repeat(256), expected: "a".repeat(256) },
  {
    query: ["a".repeat(86), "b".repeat(86), "c".repeat(86), "unique.ts"].join("/"),
    expected: ["a".repeat(86), "b".repeat(86), "c".repeat(82)].join("/"),
  },
  { query: `${"a".repeat(255)}😀/boundary.ts`, expected: "a".repeat(255) },
  { query: `${"a".repeat(254)}😀/boundary.ts`, expected: `${"a".repeat(254)}😀` },
])(
  "bounds the path search request while preserving query identity: $query",
  ({ query, expected }) => {
    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    const result = useComposerPathSearch({ ...target, query: ` ${query} ` });

    expect(state.searchRequests).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { cwd: target.cwd, query: expected, limit: 80 },
    });
    expect(result.searchedTarget).toMatchObject({ ...target, query });
    expect(result.searchedQuery).toBe(query);
    expect(result.isPending).toBe(false);
  },
);

it.each([
  { query: null, input: null, queryTooShort: false },
  { query: " a ", input: null, queryTooShort: true },
  { query: " ab ", input: { query: "ab", limit: 50 }, queryTooShort: false },
  {
    query: "report",
    kind: "file" as const,
    category: "document" as const,
    input: { query: "report", limit: 50, kind: "file", category: "document" },
    queryTooShort: false,
  },
])(
  "host path search sends $query only from two characters",
  ({ query, kind, category, input, queryTooShort }) => {
    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    const result = useHostPathSearch(
      { environmentId: target.environmentId, query, kind, category },
      50,
    );

    expect(state.searchRequests).not.toHaveBeenCalled();
    if (input === null) expect(state.hostSearchRequests).not.toHaveBeenCalled();
    else
      expect(state.hostSearchRequests).toHaveBeenCalledExactlyOnceWith({
        environmentId: target.environmentId,
        input,
      });
    expect(result).toMatchObject({ isPending: false, error: null, queryTooShort });
  },
);

it.each([
  { name: "refines", change: { query: "src/in" }, retained: true },
  { name: "widens", change: { query: "s" }, retained: true },
  { name: "ignores surrounding whitespace", change: { query: " srcx " }, retained: true },
  { name: "drops an unrelated query", change: { query: "lib" }, retained: false },
  { name: "drops an empty query", change: { query: "" }, retained: false },
  { name: "keeps the same empty query", previousQuery: "", change: { query: " " }, retained: true },
  { name: "drops a cleared query", change: { query: null }, retained: false },
  { name: "drops another cwd", change: { cwd: "/other" }, retained: false },
  {
    name: "drops another environment",
    change: { environmentId: EnvironmentId.make("other-environment") },
    retained: false,
  },
  { name: "drops another kind", change: { kind: "directory" as const }, retained: false },
  { name: "drops another image filter", change: { imageOnly: true }, retained: false },
  { name: "drops another category", change: { category: "code" as const }, retained: false },
])("retained path search results: $name", ({ previousQuery = target.query, change, retained }) => {
  const previous = {
    target: { ...target, query: previousQuery, kind: "file" as const },
    entries: [{ path: "src/index.ts", kind: "file" as const }],
    truncated: true,
  };
  expect(retainedProjectPathSearch({ ...previous.target, ...change }, previous)).toBe(
    retained ? previous : null,
  );
});

it("explains an overlong content query instead of sending it", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  const result = useProjectContentSearch({ ...contentTarget, query: "a".repeat(257) });

  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result.matches).toEqual([]);
  expect(result.isPending).toBe(false);
  expect(result.error).toMatch(/256/);
});

it("shows content-search denial before typing and never issues an unauthorized request", () => {
  state.session = { authenticated: true, scopes: [] };
  for (const query of ["", contentTarget.query]) {
    const result = useProjectContentSearch({ ...contentTarget, query });
    expect(state.contentRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      canReadFiles: false,
      isCheckingAccess: false,
      matches: [],
      error: "This connection cannot search host files.",
      isPending: false,
    });
  }
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("keeps confirmed content access during revalidation and drops results when it is revoked", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionWaiting = true;
  expect(useProjectContentSearch(contentTarget)).toMatchObject({
    matches: state.contentData.matches,
    isPending: false,
  });

  state.contentRequests.mockClear();
  state.sessionWaiting = false;
  state.session = { authenticated: true, scopes: [] };
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: "This connection cannot search host files.",
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});

it("fails closed after a session check fails, even with a cached grant and matches", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = "The session has expired.";
  const result = useProjectContentSearch(contentTarget);
  expect(state.contentRequests).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    canReadFiles: false,
    matches: [],
    error: state.sessionError,
    isPending: false,
  });
  expect(state.contentRequests).not.toHaveBeenCalled();
});
