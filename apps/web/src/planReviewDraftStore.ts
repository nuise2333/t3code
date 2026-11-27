import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  decodePlanReviewDrafts,
  EMPTY_PLAN_REVIEW_DRAFT,
  withPlanReviewDraft,
  type PlanReviewDraft,
  type StoredPlanReviewDrafts,
} from "@t3tools/client-runtime/planReview";
import type { PlanId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

const STORAGE_KEY = "t3code:plan-review-drafts:v1";
const storage = resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);

interface PlanReviewDraftStoreState {
  drafts: StoredPlanReviewDrafts;
  update: (key: string, change: (draft: PlanReviewDraft) => PlanReviewDraft) => void;
  /** Clears a sent draft unless it changed since, such as in another tab while it was sending. */
  clearSent: (key: string, sent: PlanReviewDraft) => void;
}

export function planReviewDraftKey(threadRef: ScopedThreadRef, planId: PlanId): string {
  return `${scopedThreadKey(threadRef)}:${planId}`;
}

// Each write saves the whole table, so it starts from what storage holds now and changes one
// draft; starting from this tab's last read would undo what other tabs saved since.
function storedDrafts(): StoredPlanReviewDrafts {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return typeof raw === "string"
      ? decodePlanReviewDrafts((JSON.parse(raw) as { state?: unknown } | null)?.state)
      : {};
  } catch {
    return {};
  }
}

export const usePlanReviewDraftStore = create<PlanReviewDraftStoreState>()(
  persist(
    (set) => ({
      drafts: {},
      update: (key, change) => {
        const stored = storedDrafts();
        set({
          drafts: withPlanReviewDraft(
            stored,
            key,
            change(stored[key] ?? EMPTY_PLAN_REVIEW_DRAFT),
            Date.now(),
          ),
        });
      },
      clearSent: (key, sent) => {
        const stored = storedDrafts();
        const current = stored[key] ?? EMPTY_PLAN_REVIEW_DRAFT;
        const same =
          current.general === sent.general &&
          JSON.stringify(current.annotations) === JSON.stringify(sent.annotations);
        set({
          drafts: same ? withPlanReviewDraft(stored, key, EMPTY_PLAN_REVIEW_DRAFT, 0) : stored,
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => storage),
      version: 1,
      partialize: ({ drafts }) => ({ drafts }),
      merge: (persisted, current) => ({ ...current, drafts: decodePlanReviewDrafts(persisted) }),
    },
  ),
);

// Another tab's edits must reach this tab before it sends or clears the same draft.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) void usePlanReviewDraftStore.persist.rehydrate();
  });
}

export function usePlanReviewDraft(key: string | null): PlanReviewDraft {
  return usePlanReviewDraftStore(
    (state) => (key === null ? undefined : state.drafts[key]) ?? EMPTY_PLAN_REVIEW_DRAFT,
  );
}
