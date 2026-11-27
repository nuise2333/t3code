import { describe, expect, it } from "vite-plus/test";

import { contentsOnClose, decideIncomingContents, reconcileIncoming } from "./fileMarkdownPublish";

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

describe("reconcileIncoming", () => {
  const base = "one\ntwo\nthree\n";

  it("merges a change elsewhere with unpublished keystrokes and keeps the merge to publish", () => {
    const outcome = reconcileIncoming("one\ntwo\nthree!\n", {
      published: base,
      latest: "one!\ntwo\nthree\n",
      dirty: true,
    });
    // The disk's version is what was published; the merge still differs from it and is saved.
    expect(outcome).toEqual({
      kind: "merged",
      text: "one!\ntwo\nthree!\n",
      published: "one\ntwo\nthree!\n",
      dirty: true,
    });
  });

  it("holds overlapping changes as a conflict instead of writing either side", () => {
    expect(
      reconcileIncoming("one\nDISK\nthree\n", {
        published: base,
        latest: "one\nMINE\nthree\n",
        dirty: true,
      }),
    ).toEqual({ kind: "conflict", base, disk: "one\nDISK\nthree\n" });
  });
});

describe("contentsOnClose", () => {
  it("keeps both sides of an unsettled conflict when the editor goes away", () => {
    const kept = contentsOnClose("one\nMINE\nthree\n", {
      base: "one\ntwo\nthree\n",
      disk: "one\nDISK\nthree\n",
    });
    expect(kept).toContain("MINE");
    expect(kept).toContain("DISK");
  });

  it("is the typed text when nothing conflicts", () => {
    expect(contentsOnClose("typed", null)).toBe("typed");
  });
});
