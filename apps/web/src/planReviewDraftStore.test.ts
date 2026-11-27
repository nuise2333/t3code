import { expect, it, vi } from "vite-plus/test";

const storage = vi.hoisted(() => {
  const items = new Map<string, string>();
  const localStorage = {
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  };
  const listeners: Array<(event: { key: string }) => void> = [];
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: (_type: string, listener: (event: { key: string }) => void) =>
      listeners.push(listener),
  });
  return Object.assign(localStorage, { listeners });
});

import { usePlanReviewDraftStore } from "./planReviewDraftStore";

const STORAGE_KEY = "t3code:plan-review-drafts:v1";
const note = (id: string) => ({ id, action: "delete" as const, quote: id });
const stored = () =>
  (JSON.parse(storage.getItem(STORAGE_KEY)!) as { state: { drafts: Record<string, unknown> } })
    .state.drafts;

it("keeps the drafts another tab saved since this one last wrote", () => {
  const { update, clearSent } = usePlanReviewDraftStore.getState();
  update("thread:a", () => ({ annotations: [note("mine")], general: "" }));

  const other = { annotations: [note("theirs")], general: "from the other tab", updatedAt: 5 };
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ state: { drafts: { ...stored(), "thread:b": other } }, version: 1 }),
  );
  update("thread:a", (draft) => ({ ...draft, general: "more" }));

  expect(stored()).toMatchObject({
    "thread:a": { annotations: [note("mine")], general: "more" },
    "thread:b": other,
  });
  expect(usePlanReviewDraftStore.getState().drafts["thread:b"]).toEqual(other);

  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ state: { drafts: { ...stored(), "thread:c": other } }, version: 1 }),
  );
  clearSent("thread:a", { annotations: [note("mine")], general: "more" });
  expect(Object.keys(stored())).toEqual(["thread:b", "thread:c"]);
});

it("sees another tab's note on the same plan before this tab sends it", async () => {
  const { update } = usePlanReviewDraftStore.getState();
  const theirs = { annotations: [note("theirs")], general: "", updatedAt: 6 };
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({ state: { drafts: { ...stored(), "thread:d": theirs } }, version: 1 }),
  );
  for (const listener of storage.listeners) listener({ key: STORAGE_KEY });
  await vi.waitFor(() =>
    expect(usePlanReviewDraftStore.getState().drafts["thread:d"]).toEqual(theirs),
  );

  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      state: { drafts: { ...stored(), "thread:d": { ...theirs, general: "later" } } },
      version: 1,
    }),
  );
  update("thread:d", (draft) => ({ ...draft, annotations: [...draft.annotations, note("mine")] }));
  expect(stored()["thread:d"]).toMatchObject({
    annotations: [note("theirs"), note("mine")],
    general: "later",
  });
});

it("keeps a note another tab added while this tab's send was in flight", () => {
  const { update, clearSent } = usePlanReviewDraftStore.getState();
  update("thread:e", () => ({ annotations: [note("sent")], general: "" }));
  const sent = usePlanReviewDraftStore.getState().drafts["thread:e"]!;
  update("thread:e", (draft) => ({ ...draft, general: "added during the send" }));

  clearSent("thread:e", sent);
  expect(stored()["thread:e"]).toMatchObject({ general: "added during the send" });

  clearSent("thread:e", usePlanReviewDraftStore.getState().drafts["thread:e"]!);
  expect(stored()["thread:e"]).toBeUndefined();
});
