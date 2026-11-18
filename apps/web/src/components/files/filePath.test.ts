import { describe, expect, it } from "vite-plus/test";

import {
  breadcrumbPathOf,
  fileBreadcrumbChildren,
  fileBreadcrumbs,
  folderReadOutcome,
  hostParentOf,
  isListableHostFolder,
  missingFolderProbeStep,
  retainedBreadcrumbTrail,
} from "./filePath";

describe("fileBreadcrumbs", () => {
  it("starts host paths outside the workspace at the filesystem root", () => {
    expect(fileBreadcrumbs("t3code", "/tmp/t3-cleanup/report.md")).toEqual([
      { label: "tmp", path: "/tmp", kind: "directory" },
      { label: "t3-cleanup", path: "/tmp/t3-cleanup", kind: "directory" },
      { label: "report.md", path: "/tmp/t3-cleanup/report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "C:\\Temp\\report.md")).toEqual([
      { label: "C:", path: "C:\\", kind: "directory" },
      { label: "Temp", path: "C:\\Temp", kind: "directory" },
      { label: "report.md", path: "C:\\Temp\\report.md", kind: "file" },
    ]);
    expect(fileBreadcrumbs("t3code", "\\\\server\\share\\report.md").map((c) => c.path)).toEqual([
      "\\\\server",
      "\\\\server\\share",
      "\\\\server\\share\\report.md",
    ]);
  });

  it("builds home-relative breadcrumbs with navigable folders", () => {
    expect(fileBreadcrumbs("t3code", "~/.claude/CLAUDE.md")).toEqual([
      { label: "~", path: "~/", kind: "directory" },
      { label: ".claude", path: "~/.claude", kind: "directory" },
      { label: "CLAUDE.md", path: "~/.claude/CLAUDE.md", kind: "file" },
    ]);
    expect(isListableHostFolder("~/")).toBe(true);
    expect(isListableHostFolder("~/.claude")).toBe(true);
  });

  it("keeps a literal backslash inside a workspace path segment", () => {
    expect(fileBreadcrumbs("t3code", "dir\\one/report.txt")).toEqual([
      { label: "t3code", path: "", kind: "project" },
      { label: "dir\\one", path: "dir\\one", kind: "directory" },
      { label: "report.txt", path: "dir\\one/report.txt", kind: "file" },
    ]);
  });

  it("keeps a project folder named ~ inside the project", () => {
    expect(fileBreadcrumbs("t3code", "~").map((crumb) => crumb.path)).toEqual(["", "~"]);
  });
});

describe("breadcrumbPathOf", () => {
  it("keeps the home root listable", () => {
    expect(breadcrumbPathOf("~/")).toBe("~/");
  });
});

describe("hostParentOf", () => {
  it.each([
    ["/a", "/"],
    ["/tmp/report.md", "/tmp"],
    ["/tmp/folder/", "/tmp"],
    ["~/a", "~/"],
    ["~/.claude/CLAUDE.md", "~/.claude"],
    ["C:\\a", "C:\\"],
    ["C:/a", "C:\\"],
    ["C:\\Temp\\report.md", "C:\\Temp"],
    ["\\\\srv\\share\\a", "\\\\srv\\share"],
    ["/", null],
    ["~/", null],
    ["C:\\", null],
  ])("parent of %j is %j", (path, expected) => {
    expect(hostParentOf(path)).toBe(expected);
  });
});

describe("fileBreadcrumbChildren", () => {
  const entries = [
    { path: "README.md", kind: "file" as const },
    { path: "src", kind: "directory" as const },
    { path: "src-old", kind: "directory" as const },
    { path: "src/index.ts", kind: "file" as const },
    { path: "src/lib", kind: "directory" as const },
    { path: "src/lib/file10.ts", kind: "file" as const },
    { path: "src/lib/file2.ts", kind: "file" as const },
    { path: "src-old/index.ts", kind: "file" as const },
  ];

  it("honors segment boundaries and sorts folders before files", () => {
    expect(fileBreadcrumbChildren(entries, "src")).toEqual([
      { path: "src/lib", kind: "directory", label: "lib" },
      { path: "src/index.ts", kind: "file", label: "index.ts" },
    ]);
  });
});

describe("retainedBreadcrumbTrail", () => {
  it.each([
    ["apps/web/src", "apps/web", "apps/web/src"],
    ["apps/web/src", "", "apps/web/src"],
    ["apps/web/src", "apps/web/src", "apps/web/src"],
    ["apps/web/src", "apps/mobile", "apps/mobile"],
    ["src/lib", "src-old", "src-old"],
    ["apps/web", "apps/web/src/main.tsx", "apps/web/src/main.tsx"],
    ["apps/web/src", "/tmp/report", "/tmp/report"],
    ["/tmp/report", "", ""],
    ["C:\\Temp\\a", "", ""],
    ["/Users/me/projects/scope", "/Users/me", "/Users/me/projects/scope"],
    ["/Users/me/projects/scope", "/Users/me/proj", "/Users/me/proj"],
    ["/Volumes/Work/a", "/Volumes/Work/a/", "/Volumes/Work/a"],
    ["C:\\Users\\me\\scope", "C:\\", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "C:\\Users", "C:\\Users\\me\\scope"],
    ["C:\\Users\\me\\scope", "D:\\", "D:\\"],
    ["\\\\nas\\share\\docs\\notes", "\\\\nas\\share", "\\\\nas\\share\\docs\\notes"],
  ])("from trail %j to %j keeps %j", (trail, path, expected) => {
    expect(retainedBreadcrumbTrail(trail, path)).toBe(expected);
  });
});

describe("missingFolderProbeStep", () => {
  const read = (overrides: Partial<Parameters<typeof folderReadOutcome>[0]>) =>
    folderReadOutcome({
      data: null,
      error: null,
      isNotFile: false,
      isMissing: false,
      ...overrides,
    });

  it.each([
    ["src/gone", read({ isMissing: true, error: "missing" }), { kind: "walk", next: "src" }],
    ["src", read({ isMissing: true, error: "missing" }), { kind: "walk", next: "" }],
    ["src/now-a-file", read({ data: {} }), { kind: "walk", next: "src" }],
    ["src", read({ isNotFile: true, error: "folder" }), { kind: "target", path: "src" }],
    ["src", read({}), { kind: "wait" }],
    // Permission, escape, transport and missing-scope errors leave the folder where it is.
    ["/Users/me/Library/x", read({ error: "EACCES" }), { kind: "stop" }],
    ["", read({}), { kind: "target", path: "" }],
    ["/tmp/gone", read({ isMissing: true, error: "missing" }), { kind: "walk", next: "/tmp" }],
    ["/", read({ isMissing: true, error: "missing" }), { kind: "walk", next: null }],
    [null, read({}), { kind: "stop" }],
  ] as const)("candidate %j read as %j steps to %j", (candidate, outcome, expected) => {
    expect(missingFolderProbeStep(candidate, outcome)).toEqual(expected);
  });
});
