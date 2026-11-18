import { describe, expect, it } from "vite-plus/test";

import { decideIncomingContents } from "./fileMarkdownPublish";

describe("decideIncomingContents", () => {
  it.each<[string, string, { published: string; dirty: boolean }, string]>([
    ["an echo of the last save", "b", { published: "b", dirty: false }, "ignore"],
    ["an echo while typing on", "b", { published: "b", dirty: true }, "ignore"],
    ["a change elsewhere over keystrokes", "c", { published: "b", dirty: true }, "publish"],
    ["a change elsewhere", "c", { published: "b", dirty: false }, "apply"],
    // The file put back as the editor opened it, after edits were saved.
    ["a revert elsewhere", "a", { published: "b", dirty: false }, "apply"],
  ])("decides %s", (_name, incoming, state, expected) => {
    expect(decideIncomingContents(incoming, state)).toBe(expected);
  });
});
