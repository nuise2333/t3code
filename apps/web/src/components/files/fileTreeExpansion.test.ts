import { describe, expect, it } from "vite-plus/test";

import {
  duplicateExpandedDirectories,
  readExpandedDirectories,
  writeExpandedDirectories,
} from "./fileTreeExpansion";

describe("Files tab expansion", () => {
  it("starts from the workspace, keeps a collapsed tab collapsed, and copies to a duplicate", () => {
    writeExpandedDirectories("env:/repo", ["src/"]);
    expect(readExpandedDirectories("env:/repo#files:a", "env:/repo")).toEqual(["src/"]);

    writeExpandedDirectories("env:/repo#files:a", [], true);
    expect(readExpandedDirectories("env:/repo#files:a", "env:/repo")).toEqual([]);

    writeExpandedDirectories("env:/repo#files:a", ["docs/"], true);
    writeExpandedDirectories("env:/host#files:a", ["x/"], true);
    duplicateExpandedDirectories("files:a", "files:b");
    expect(readExpandedDirectories("env:/repo#files:b", "env:/repo")).toEqual(["docs/"]);
    expect(readExpandedDirectories("env:/host#files:b")).toEqual(["x/"]);
    expect(readExpandedDirectories("env:/repo")).toEqual(["src/"]);
  });
});
