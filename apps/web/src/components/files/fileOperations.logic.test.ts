import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canPasteInto,
  collapseDescendantPaths,
  fileOperationFailureSummary,
  fileOperationMenuItems,
  fileOperationRemovedPaths,
  freeEntryName,
  inverseFileOperations,
  parentFilePath,
  requestFilePath,
} from "./fileOperations.logic";

const env = EnvironmentId.make("env");
const root = "/repo";

describe("file operation paths", () => {
  it.each([
    ["/repo/src/a.ts", "src/a.ts"],
    ["/repo", "."],
    ["/elsewhere/a.ts", "/elsewhere/a.ts"],
    ["/repository/a.ts", "/repository/a.ts"],
  ])("sends %s as %s", (path, expected) => {
    expect(requestFilePath(path, root)).toBe(expected);
  });

  it.each([
    ["/repo/src/a.ts", "/repo/src"],
    ["/a", "/"],
    ["C:\\proj\\a.ts", "C:\\proj"],
    ["C:\\a.ts", "C:\\"],
  ])("finds the parent of %s", (path, expected) => {
    expect(parentFilePath(path)).toBe(expected);
  });

  it("drops duplicates and items inside another selected folder, in any order", () => {
    expect(
      collapseDescendantPaths([
        "/repo/src/c/b",
        "/repo/src/c/b/a",
        "/repo/src/c",
        "/repo/srcs",
        "/repo/src/c",
      ]),
    ).toEqual(["/repo/src/c", "/repo/srcs"]);
  });

  it("pastes only within the copying environment and never into a copied folder", () => {
    const clipboard = { environmentId: env, root, paths: ["/repo/src"], mode: "cut" as const };
    expect(canPasteInto(clipboard, env, "/repo/lib")).toBe(true);
    expect(canPasteInto(clipboard, env, "/repo/srcs")).toBe(true);
    expect(canPasteInto(clipboard, env, "/repo/src")).toBe(false);
    expect(canPasteInto(clipboard, env, "/repo/src/deep")).toBe(false);
    expect(canPasteInto(clipboard, EnvironmentId.make("other"), "/repo/lib")).toBe(false);
    expect(canPasteInto(null, env, "/repo/lib")).toBe(false);
  });

  it("names a new item after the ones its folder already holds, ignoring case", () => {
    expect(freeEntryName("untitled", new Set(["a.ts"]))).toBe("untitled");
    expect(freeEntryName("untitled", new Set(["Untitled", "untitled 2"]))).toBe("untitled 3");
  });
});

describe("inverseFileOperations", () => {
  it("renames back to the old name", () => {
    expect(
      inverseFileOperations(
        { _tag: "rename", path: "src/a.ts", name: "b.ts" },
        { items: [{ path: "src/a.ts", destination: "src/b.ts" }], changedDirectories: ["src"] },
        root,
      ),
    ).toEqual([{ _tag: "rename", path: "src/b.ts", name: "a.ts" }]);
  });

  it("moves each moved item back to its own folder, skipping failures and no-ops", () => {
    expect(
      inverseFileOperations(
        { _tag: "move", paths: ["a/x", "b/y", "c/z", "dest/w"], destinationDirectory: "dest" },
        {
          items: [
            { path: "a/x", destination: "dest/x" },
            { path: "b/y", destination: "dest/y" },
            { path: "c/z", failure: "name_taken" },
            { path: "dest/w", destination: "dest/w" },
          ],
          changedDirectories: ["a", "b", "dest"],
        },
        root,
      ),
    ).toEqual([
      { _tag: "move", paths: ["dest/x"], destinationDirectory: "a" },
      { _tag: "move", paths: ["dest/y"], destinationDirectory: "b" },
    ]);
  });

  it("has nothing to undo for a trash, and reports what the trash removed", () => {
    const operation = { _tag: "trash", paths: ["a", "/tmp/b"], onUnavailable: "fail" } as const;
    const result = {
      items: [{ path: "a" }, { path: "/tmp/b", failure: "trash_unavailable" as const }],
      changedDirectories: [""],
    };
    expect(inverseFileOperations(operation, result, root)).toEqual([]);
    expect(fileOperationRemovedPaths(operation, result, root)).toEqual(["/repo/a"]);
  });
});

describe("fileOperationFailureSummary", () => {
  it("names the single item, or counts the failures in a batch", () => {
    expect(
      fileOperationFailureSummary("rename", {
        items: [{ path: "src/a.ts", failure: "name_taken" }],
        changedDirectories: [],
      }),
    ).toEqual({
      title: "Couldn't rename a.ts",
      description: "An item with that name already exists.",
    });
    expect(
      fileOperationFailureSummary("move", {
        items: [
          { path: "a", destination: "d/a" },
          { path: "b/.git", failure: "protected" },
          { path: "c", failure: "not_found" },
        ],
        changedDirectories: [],
      })?.title,
    ).toBe("Couldn't move 2 of 3 items");
    expect(
      fileOperationFailureSummary("move", {
        items: [{ path: "a", destination: "d/a" }],
        changedDirectories: [],
      }),
    ).toBeNull();
  });
});

describe("fileOperationMenuItems", () => {
  const ids = (input: Parameters<typeof fileOperationMenuItems>[0]) =>
    fileOperationMenuItems(input).map((item) => (item.disabled ? `(${item.id})` : item.id));

  it.each([
    [
      "one item",
      { targetCount: 1, canWrite: true, canPaste: true, hasRelativePaths: true },
      [
        "new-file",
        "new-folder",
        "rename",
        "duplicate",
        "cut",
        "copy",
        "paste",
        "copy-path",
        "copy-relative-path",
        "trash",
      ],
    ],
    [
      "several items",
      { targetCount: 3, canWrite: true, canPaste: false, hasRelativePaths: false },
      ["duplicate", "cut", "copy", "(paste)", "copy-path", "trash"],
    ],
    [
      "empty space",
      { targetCount: 0, canWrite: true, canPaste: true, hasRelativePaths: true },
      ["new-file", "new-folder", "paste", "copy-path"],
    ],
    [
      "no write access",
      { targetCount: 2, canWrite: false, canPaste: true, hasRelativePaths: true },
      ["copy-path", "copy-relative-path"],
    ],
  ])("offers %s the actions it allows", (_name, input, expected) => {
    expect(ids(input)).toEqual(expected);
  });

  it("separates groups and marks trash destructive", () => {
    const items = fileOperationMenuItems({
      targetCount: 1,
      canWrite: true,
      canPaste: true,
      hasRelativePaths: false,
    });
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual([
      "rename",
      "cut",
      "copy-path",
      "trash",
    ]);
    expect(items.at(-1)).toMatchObject({ id: "trash", destructive: true });
  });
});
