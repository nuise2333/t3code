import { describe, expect, it } from "vite-plus/test";

import { fileCategoryOf } from "./fileCategory.ts";

describe("fileCategoryOf", () => {
  it.each([
    ["docs/Report.PDF", "document"],
    ["notes.md", "document"],
    ["public/icon.svg", "image"],
    ["src/app.tsx", "code"],
    ["clips/demo.mov", "video"],
    ["sounds/ping.opus", "audio"],
    ["release.tar.gz", "archive"],
    [".gitignore", null],
    ["src/.env", null],
    ["Makefile", null],
    ["data.bin", null],
    ["v1.0/README", null],
  ] as const)("%s is %s", (path, category) => {
    expect(fileCategoryOf(path)).toBe(category);
  });
});
