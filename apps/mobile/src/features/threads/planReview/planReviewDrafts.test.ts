import { expect, it, vi } from "vite-plus/test";

const fs = vi.hoisted(() => ({
  contents: JSON.stringify({
    drafts: { saved: { annotations: [], general: "kept", updatedAt: 1 } },
  }),
  failNextRead: true,
  writes: [] as string[],
}));

vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  Directory: class {
    create() {}
  },
  File: class {
    exists = true;
    async text() {
      if (fs.failNextRead) {
        fs.failNextRead = false;
        throw new Error("transient read failure");
      }
      return fs.contents;
    }
  },
}));
vi.mock("../../../lib/atomic-file", () => ({
  writeFileAtomically: async (_file: unknown, contents: string) => {
    fs.writes.push(contents);
    fs.contents = contents;
  },
}));

import { clearPlanReviewDraft, updatePlanReviewDraft } from "./planReviewDrafts";

it("retries a failed read and keeps saved notes from edits made before it", async () => {
  vi.useFakeTimers();
  updatePlanReviewDraft("saved", (draft) => ({ ...draft, general: "typed while unread" }));
  await vi.advanceTimersByTimeAsync(400);
  expect(fs.writes).toEqual([]);

  updatePlanReviewDraft("saved", (draft) => ({ ...draft, general: "typed while unread" }));
  await vi.advanceTimersByTimeAsync(400);
  updatePlanReviewDraft("other", (draft) => ({ ...draft, general: "after the read" }));
  await vi.advanceTimersByTimeAsync(400);
  vi.useRealTimers();

  expect(fs.writes).toHaveLength(1);
  const written = JSON.parse(fs.writes[0]!) as { drafts: Record<string, { general: string }> };
  expect(written.drafts.saved?.general).toBe("kept");
  expect(written.drafts.other?.general).toBe("after the read");
});

it("keeps notes written while the sent version was going out", () => {
  let sent = { annotations: [], general: "" } as Parameters<typeof clearPlanReviewDraft>[1] & {};
  updatePlanReviewDraft("sending", (draft) => (sent = { ...draft, general: "sent" }));
  updatePlanReviewDraft("sending", (draft) => ({ ...draft, general: "typed during the send" }));

  clearPlanReviewDraft("sending", sent);
  let current = "";
  updatePlanReviewDraft("sending", (draft) => ((current = draft.general), draft));
  expect(current).toBe("typed during the send");

  updatePlanReviewDraft("sending", (draft) => ((sent = draft), draft));
  clearPlanReviewDraft("sending", sent);
  updatePlanReviewDraft("sending", (draft) => ((current = draft.general), draft));
  expect(current).toBe("");
});
