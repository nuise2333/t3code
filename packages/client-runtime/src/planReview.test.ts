import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PLAN_REVIEW_DRAFT,
  buildPlanApprovalMessage,
  buildPlanRevisionMessage,
  decodePlanReviewDrafts,
  diffPlanMarkdown,
  findPlanQuoteLine,
  hasPlanReviewFeedback,
  PLAN_IMPLEMENTATION_PROMPT_PREFIX,
  PLAN_REVISION_PROMPT,
  planTextAnchor,
  resolvePlanTextAnchor,
  withPlanReviewDraft,
  type PlanReviewDraft,
} from "./planReview.ts";

const draft: PlanReviewDraft = {
  annotations: [
    { id: "a", action: "delete", quote: "Use Redis", line: 3 },
    { id: "b", action: "replace", quote: "nightly", replacement: "hourly", comment: "too slow" },
    { id: "c", action: "comment", quote: "Ship it", comment: "Add a rollback step." },
    { id: "d", action: "replace", quote: "half done", replacement: "  " },
    { id: "e", action: "comment", quote: "no words yet" },
  ],
  general: " Keep it small. ",
};

describe("plan review messages", () => {
  it("sends a plan back with every finished note written out in the message", () => {
    expect(buildPlanRevisionMessage(draft)).toBe(
      [
        PLAN_REVISION_PROMPT,
        "## 1. Remove (line 3)\n> Use Redis\n\nThe user wants this part left out.",
        "## 2. Replace\n> nightly\n\nReplace with:\nhourly\nComment: too slow",
        "## 3. Comment\n> Ship it\n\nComment: Add a rollback step.",
        "## 4. General feedback\nKeep it small.",
      ].join("\n\n"),
    );
  });

  it("keeps a long note whole and quotes every line of a passage", () => {
    const long = "x".repeat(40_000);
    const text = buildPlanRevisionMessage({
      annotations: [{ id: "a", action: "comment", quote: "Step 1\n\nStep 2", comment: long }],
      general: long,
    })!;

    expect(text.includes(`> Step 1\n>\n> Step 2\n\nComment: ${long}\n\n`)).toBe(true);
    expect(text.endsWith(`## 2. General feedback\n${long}`)).toBe(true);
  });

  it("has nothing to send back until the reviewer leaves feedback", () => {
    const unfinished: PlanReviewDraft = {
      annotations: [{ id: "e", action: "comment", quote: "no words yet", comment: " " }],
      general: "  ",
    };

    expect(hasPlanReviewFeedback(unfinished)).toBe(false);
    expect(buildPlanRevisionMessage(unfinished)).toBeNull();
    expect(hasPlanReviewFeedback(draft)).toBe(true);
  });

  it("approves with the plan, and with notes only when there are any", () => {
    expect(buildPlanApprovalMessage("# Plan\n\nShip it\n", EMPTY_PLAN_REVIEW_DRAFT)).toBe(
      `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan\n\nShip it`,
    );

    const noted = buildPlanApprovalMessage("# Plan", {
      annotations: [{ id: "a", action: "delete", quote: "Use Redis" }],
      general: "",
    });
    expect(noted).toMatch(
      /^PLEASE IMPLEMENT THIS PLAN:\n# Plan\n\nREVIEWER NOTES\. .*:\n\n## 1\. Remove\n> Use Redis\n\nThe user wants this part left out\.$/,
    );
  });
});

const note = { id: "a", action: "delete", quote: "Step 2", line: 4 } as const;

describe("plan review drafts", () => {
  it("drops a draft once it is empty", () => {
    const drafts = withPlanReviewDraft({}, "t:p", { annotations: [note], general: "" }, 1);
    expect(drafts["t:p"]).toEqual({ annotations: [note], general: "", updatedAt: 1 });
    expect(withPlanReviewDraft(drafts, "t:p", { annotations: [], general: "" }, 2)).toEqual({});
  });

  it("keeps the 200 most recently edited drafts", () => {
    let drafts = {};
    for (let index = 0; index < 202; index += 1) {
      drafts = withPlanReviewDraft(drafts, `k${index}`, { annotations: [], general: "x" }, index);
    }
    expect(Object.keys(drafts)).toHaveLength(200);
    expect(drafts).not.toHaveProperty("k0");
    expect(drafts).not.toHaveProperty("k1");
    expect(drafts).toHaveProperty("k2");
    expect(drafts).toHaveProperty("k201");
  });

  it("reads back only well-formed drafts and notes", () => {
    expect(
      decodePlanReviewDrafts({
        drafts: {
          good: { annotations: [note, { id: 1 }], general: "why", updatedAt: 5 },
          bare: { annotations: [] },
          broken: { general: "no notes list" },
          gone: null,
        },
      }),
    ).toEqual({
      good: { annotations: [note], general: "why", updatedAt: 5 },
      bare: { annotations: [], general: "", updatedAt: 0 },
    });
    expect(decodePlanReviewDrafts("not a document")).toEqual({});
  });
});

describe("plan text anchors", () => {
  const text = "cache the cache, then drop the cache";

  it.each([
    { start: 0, occurrence: 0 },
    { start: 10, occurrence: 1 },
    { start: 31, occurrence: 2 },
  ])("finds repeat $occurrence of a quote again", ({ start, occurrence }) => {
    const anchor = planTextAnchor(text, start, start + 5);

    expect(anchor).toEqual({ text: "cache", occurrence });
    expect(resolvePlanTextAnchor(text, anchor)).toEqual({ start, end: start + 5 });
  });

  it("falls back to the last repeat left, and to nothing when the text is gone", () => {
    expect(resolvePlanTextAnchor("one cache", { text: "cache", occurrence: 2 })).toEqual({
      start: 4,
      end: 9,
    });
    expect(resolvePlanTextAnchor("nothing here", { text: "cache", occurrence: 0 })).toBeNull();
  });
});

describe("findPlanQuoteLine", () => {
  const markdown = [
    "# Rollout plan",
    "",
    "1. **Use Redis** for the [queue](https://example.com)",
    "2. Migrate rows in a long paragraph that",
    "   wraps onto a second source line",
    "- [ ] Use Redis again",
  ].join("\n");

  it.each([
    { quote: "Rollout plan", occurrence: 0, line: 1 },
    { quote: "Use Redis for the queue", occurrence: 0, line: 3 },
    { quote: "paragraph that wraps onto", occurrence: 0, line: 4 },
    { quote: "Use Redis", occurrence: 1, line: 6 },
    { quote: "\n\nUse Redis again\nmore", occurrence: 0, line: 6 },
    { quote: "not in the plan", occurrence: 0, line: undefined },
  ])("puts $quote on line $line", ({ quote, occurrence, line }) => {
    expect(findPlanQuoteLine(markdown, quote, occurrence)).toBe(line);
  });
});

describe("diffPlanMarkdown", () => {
  it("marks the words that changed in a rewritten line", () => {
    const diff = diffPlanMarkdown(
      "# Plan\n1. Use Redis for the queue\n2. Ship\n",
      "# Plan\n1. Use SQLite for the queue\n2. Ship\n3. Monitor",
    );

    expect(diff.lines).toEqual([
      { kind: "context", text: "# Plan", oldLine: 1, newLine: 1 },
      {
        kind: "removed",
        oldLine: 2,
        segments: [
          { text: "1. Use ", changed: false },
          { text: "Redis", changed: true },
          { text: " for the queue", changed: false },
        ],
      },
      {
        kind: "added",
        newLine: 2,
        segments: [
          { text: "1. Use ", changed: false },
          { text: "SQLite", changed: true },
          { text: " for the queue", changed: false },
        ],
      },
      { kind: "context", text: "2. Ship", oldLine: 3, newLine: 3 },
      { kind: "added", newLine: 4, segments: [{ text: "3. Monitor", changed: false }] },
    ]);
    expect({ added: diff.added, removed: diff.removed }).toEqual({ added: 2, removed: 1 });
  });

  it("splits Chinese by character and joins changed words across a space", () => {
    const chinese = diffPlanMarkdown("每晚同步一次数据", "每小时同步一次数据");
    expect(chinese.lines[1]).toEqual({
      kind: "added",
      newLine: 1,
      segments: [
        { text: "每", changed: false },
        { text: "小时", changed: true },
        { text: "同步一次数据", changed: false },
      ],
    });

    const words = diffPlanMarkdown("keep the old slow path here", "keep a new fast path here");
    expect(words.lines[0]).toMatchObject({
      segments: [
        { text: "keep ", changed: false },
        { text: "the old slow", changed: true },
        { text: " path here", changed: false },
      ],
    });
  });

  it("shows unrelated lines whole and identical plans as unchanged", () => {
    const rewritten = diffPlanMarkdown("Use Redis", "Something else entirely");
    expect(rewritten.lines).toEqual([
      { kind: "removed", oldLine: 1, segments: [{ text: "Use Redis", changed: false }] },
      {
        kind: "added",
        newLine: 1,
        segments: [{ text: "Something else entirely", changed: false }],
      },
    ]);

    expect(diffPlanMarkdown("a\nb\n", "a\nb")).toMatchObject({ added: 0, removed: 0 });
  });
});
