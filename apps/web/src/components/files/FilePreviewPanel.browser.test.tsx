import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import appCss from "~/index.css?inline";
import { isMacPlatform } from "~/lib/utils";
import {
  createWorkspaceFocusController,
  startWorkspaceFocus,
  workspaceAreaProps,
} from "~/lib/workspaceFocus";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  isNotFile: false,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
  assetUrl: { _tag: "Loading" } as import("~/assets/assetUrls").AssetUrlState,
  mintUrl: vi.fn<() => Promise<string | null>>(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => state.mintUrl,
  useAssetUrlState: () => state.assetUrl,
}));
// The Word engine compiles a large WebAssembly bundle; these tests only need the URL it loads.
vi.mock(import("./OfficeFilePreview"), () => ({
  OfficeFilePreview: ({ src }: { src: string }) => <div data-testid="office-preview">{src}</div>,
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./FileBrowserPanel"), () => ({
  default: (props: { cwd: string; selectedPath: string | null; view?: { folder: string } }) => (
    <div
      role="tree"
      data-cwd={props.cwd}
      data-selected-path={props.selectedPath ?? ""}
      data-view-folder={props.view?.folder}
    >
      <button type="button" role="treeitem" data-item-path="src/">
        src
      </button>
      <button type="button" role="treeitem" data-item-path="server.ts">
        server.ts
      </button>
    </div>
  ),
}));
vi.mock(import("../DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    data: state.file,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: state.isNotFile,
    isMissing: false,
    isFile: !state.isNotFile,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdownEditable"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.file = null;
  state.isNotFile = false;
  state.optimistic = null;
  state.assetUrl = { _tag: "Loading" };
  let mints = 0;
  state.mintUrl.mockReset().mockImplementation(async () => `/assets/report.docx?mint=${++mints}`);
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function markdownPreview(truncated: boolean, contents = "- [ ] Keep the rest of this file\n") {
  state.file = {
    relativePath: "tasks.md",
    contents,
    byteLength: truncated ? 1_200_000 : contents.length,
    truncated,
  };
  return filePreview("tasks.md");
}

function filePreview(
  relativePath: string,
  workspaceMutationId: string | null = null,
  revealRequestId = 0,
  filesView?: ComponentProps<typeof FilePreviewPanel>["filesView"],
  folderTrail?: string,
) {
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath={relativePath}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={null}
      revealRequestId={revealRequestId}
      onOpenFile={vi.fn()}
      onNavigateFolder={vi.fn()}
      folderTrail={folderTrail}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={workspaceMutationId}
      filesView={filesView}
    />
  );
}

function documentPreview(workspaceMutationId: string, fileRevision: string) {
  state.file = null;
  state.assetUrl = {
    _tag: "Success",
    url: "/assets/report.docx",
    expiresAt: Number.MAX_SAFE_INTEGER,
    fileRevision,
  };
  return filePreview("report.docx", workspaceMutationId);
}

function deepActiveElement() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

describe("source file focus", () => {
  it("hands panel focus to the file's editor, which owns mod+f", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const panel = () => (
      <div {...workspaceAreaProps("panel", 1, "Workspace panel")}>
        <div data-right-panel-surface-content>{filePreview("server.ts")}</div>
      </div>
    );
    const editorHasFocus = () => expect(deepActiveElement()?.matches("[data-content]")).toBe(true);

    await using screen = await render(panel());
    const focus = createWorkspaceFocusController(document);
    using _focus = { [Symbol.dispose]: focus.dispose };
    expect(focus.focus("panel")).toBe(true);
    state.file = {
      relativePath: "server.ts",
      contents: "const server = 1;\n",
      byteLength: 18,
      truncated: false,
    };
    await screen.rerender(panel());
    await vi.waitFor(editorHasFocus);
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(deepActiveElement()?.textContent).toContain("xconst server"));

    (deepActiveElement() as HTMLElement).blur();
    expect(focus.focus("panel", false)).toBe(true);
    await vi.waitFor(editorHasFocus);
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
    );
    await vi.waitFor(() => expect(deepActiveElement()).toBeInstanceOf(HTMLInputElement));
  });

  it("focuses the editor when a file row is clicked or activated with Enter", async () => {
    using _settings = setup();
    localStorage.setItem("t3code.fileExplorerOpen", "true");
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    state.file = {
      relativePath: "server.ts",
      contents: "const server = 1;\n",
      byteLength: 18,
      truncated: false,
    };
    await using screen = await render(
      <div {...workspaceAreaProps("panel", 1, "Workspace panel")} style={{ width: 900 }}>
        <div data-right-panel-surface-content>{filePreview("server.ts")}</div>
      </div>,
    );
    using _focus = {
      [Symbol.dispose]: startWorkspaceFocus({ subscribe: () => () => {} } as never),
    };
    const editorHasFocus = () => expect(deepActiveElement()?.matches("[data-content]")).toBe(true);
    // The explorer measures its parent row; a wrapper without a box would cap it at the minimum.
    await expect
      .element(screen.getByRole("separator", { name: "Resize file explorer" }))
      .toHaveAttribute("aria-valuemax", "560");
    const folderRow = screen.getByRole("treeitem", { name: "src" });
    const fileRow = screen.getByRole("treeitem", { name: "server.ts" });

    (folderRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(folderRow.element());

    await userEvent.click(fileRow);
    await vi.waitFor(editorHasFocus);

    (fileRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(editorHasFocus);
  });
});

describe("host file explorer", () => {
  it("roots the tree at the file's folder on each open, despite a hidden explorer", async () => {
    using _settings = setup();
    const path = "/tmp/notes/report.md";
    state.file = { relativePath: path, contents: "Notes\n", byteLength: 6, truncated: false };
    await using screen = await render(filePreview(path, null, 1));
    const tree = screen.getByRole("tree");
    await expect.element(tree).toHaveAttribute("data-cwd", "/tmp/notes");
    await expect.element(tree).toHaveAttribute("data-selected-path", "report.md");

    await userEvent.click(screen.getByRole("button", { name: "Hide file explorer" }));
    await expect.element(tree).not.toBeInTheDocument();

    await screen.rerender(filePreview(path, null, 2));
    await expect.element(screen.getByRole("tree")).toHaveAttribute("data-cwd", "/tmp/notes");

    state.file = null;
    await screen.rerender(filePreview("/tmp/notes/todo.md", null, 3));
    await expect.element(screen.getByRole("tree")).toHaveAttribute("data-cwd", "/tmp/notes");
    await expect.element(screen.getByRole("tree")).toHaveAttribute("data-selected-path", "todo.md");

    await screen.rerender(filePreview("/other/report.md", null, 4));
    await expect.element(screen.getByRole("tree")).not.toBeInTheDocument();
  });

  it("offers the icon view for a folder read but never for a file", async () => {
    using _settings = setup();
    const filesView = { mode: "list" as const, onModeChange: vi.fn() };
    state.file = {
      relativePath: "/tmp/notes/a.md",
      contents: "A\n",
      byteLength: 2,
      truncated: false,
    };
    await using screen = await render(filePreview("/tmp/notes/a.md", null, 1, filesView));
    await expect.element(screen.getByRole("tree")).toHaveAttribute("data-cwd", "/tmp/notes");
    await expect.element(screen.getByRole("tree")).not.toHaveAttribute("data-view-folder");

    state.file = null;
    state.isNotFile = true;
    await screen.rerender(filePreview("/tmp/notes", null, 1, filesView));
    await expect.element(screen.getByRole("tree")).toHaveAttribute("data-view-folder", "");

    await screen.rerender(filePreview("src", null, 1, filesView));
    await expect.element(screen.getByRole("tree")).toHaveAttribute("data-view-folder", "src");

    state.isNotFile = false;
    await screen.rerender(filePreview("src/lib", null, 1, filesView, "src/lib/deep"));
    await expect.element(screen.getByRole("tree")).toHaveAttribute("data-view-folder", "src/lib");
  });
});

describe("rendered Markdown task saves", () => {
  it("keeps a truncated read read-only without queuing a replacement", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(true));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.readOnly).toBe(true);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(checkbox.checked).toBe(false);
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("still toggles and saves tasks from a complete read", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    // The editor publishes after its pause, then the save session after its own.
    await vi.advanceTimersByTimeAsync(700);
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "tasks.md",
        contents: "- [x] Keep the rest of this file\n",
        createIfMissing: false,
      },
    });
  });
});

describe("workspace document previews", () => {
  it("keeps an unchanged document loaded when another workspace change lands", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");
    const loaded = preview.element();

    await screen.rerender(documentPreview("mutation-2", "revision-1"));

    expect(state.mintUrl, "an unchanged document re-minted its URL").toHaveBeenCalledOnce();
    expect(screen.container.contains(loaded), "an unchanged document was remounted").toBe(true);
  });

  it("keeps an unchanged document mounted while its revision check reloads", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");
    const loaded = preview.element();

    state.assetUrl = { _tag: "Loading" };
    await screen.rerender(filePreview("report.docx", "mutation-1"));
    await screen.rerender(documentPreview("mutation-1", "revision-1"));

    expect(
      state.mintUrl,
      "a reloading revision check re-minted the document URL",
    ).toHaveBeenCalledOnce();
    expect(
      screen.container.contains(loaded),
      "a reloading revision check remounted the document",
    ).toBe(true);
  });

  it("reloads the document when its URL can no longer be minted", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");

    state.assetUrl = { _tag: "Failure" };
    await screen.rerender(filePreview("report.docx", "mutation-2"));

    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=2");
  });

  it("loads the new bytes when the document itself changes", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");

    await screen.rerender(documentPreview("mutation-2", "revision-2"));

    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=2");
  });
});

describe("rendered Markdown editing", () => {
  it("opens a Markdown file in the editor by default, and a truncated one read-only", async () => {
    using _settings = setup();
    localStorage.removeItem("t3code.renderMarkdownEditable");
    await using screen = await render(markdownPreview(false));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-reader-editor]")).not.toBeNull(),
    );
    await screen.rerender(markdownPreview(true));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-reader-editor]")).toBeNull(),
    );
    expect(screen.container.querySelector(".markdown-reader")).not.toBeNull();
  });

  it("saves the last keystrokes when the editor goes away", async () => {
    using _settings = setup();
    const screen = await render(markdownPreview(false, "Body text.\n"));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-reader-editor]")).not.toBeNull(),
    );
    await userEvent.click(screen.getByText("Body text."));
    await userEvent.keyboard("{End}!");
    await screen.unmount();
    await vi.waitFor(() =>
      expect(state.writeFile).toHaveBeenCalledWith({
        environmentId,
        input: {
          cwd: "/workspace",
          relativePath: "tasks.md",
          contents: "Body text.!\n",
          createIfMissing: false,
        },
      }),
    );
    await screen[Symbol.asyncDispose]();
  });
});

describe("rendered Markdown select all", () => {
  it("selects only the rendered file, including after a task toggle", async () => {
    using _settings = setup();
    await using screen = await render(
      <>
        <p>Transcript text from the chat thread.</p>
        {markdownPreview(false, "- [ ] Task item\n\nRendered file body.\n")}
      </>,
    );
    const expectFileOnlySelection = async () => {
      await userEvent.keyboard(
        isMacPlatform(navigator.platform) ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
      );
      const selection = window.getSelection()?.toString() ?? "";
      expect(selection).toContain("Rendered file body.");
      expect(selection).not.toContain("Transcript text from the chat thread.");
    };

    await userEvent.click(screen.getByText("Rendered file body."));
    await expectFileOnlySelection();
    // A toggled checkbox keeps focus on an input inside the preview.
    await userEvent.click(screen.getByRole("checkbox"));
    await expectFileOnlySelection();
  });
});
