import { useAtomValue } from "@effect/atom-react";
import {
  decodePlanReviewDrafts,
  EMPTY_PLAN_REVIEW_DRAFT,
  withPlanReviewDraft,
  type PlanReviewDraft,
  type StoredPlanReviewDrafts,
} from "@t3tools/client-runtime/planReview";
import type { PlanId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { writeFileAtomically } from "../../../lib/atomic-file";
import { appAtomRegistry } from "../../../state/atom-registry";

const PERSIST_DEBOUNCE_MS = 300;

export function planReviewDraftKey(threadKey: string, planId: PlanId): string {
  return `${threadKey}:${planId}`;
}

const draftsAtom = Atom.make<StoredPlanReviewDrafts>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:plan-review-drafts"),
);

async function draftsFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, "plan-review");
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, "drafts.json");
}

// False until the saved drafts were read: a plan answered before then would go out without
// its saved notes, and answering clears them.
const loadedAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:plan-review-drafts-loaded"),
);

let loading: Promise<void> | null = null;
// Drafts edited before the file was read; what the file holds for them is stale.
const editedBeforeLoad = new Set<string>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

// An unreadable file is corrupt rather than unavailable, so it starts over empty.
function parseStoredDrafts(text: string): StoredPlanReviewDrafts {
  try {
    return decodePlanReviewDrafts(JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}

function ensureLoaded(): Promise<void> {
  loading ??= (async () => {
    const file = await draftsFile();
    const stored = file.exists ? parseStoredDrafts(await file.text()) : {};
    appAtomRegistry.set(draftsAtom, {
      ...Object.fromEntries(Object.entries(stored).filter(([key]) => !editedBeforeLoad.has(key))),
      ...appAtomRegistry.get(draftsAtom),
    });
    appAtomRegistry.set(loadedAtom, true);
  })().catch((error: unknown) => {
    // A failed read stays retryable and blocks writes, which would replace the unread file.
    loading = null;
    console.warn("[plan-review] failed to load drafts", error);
    throw error;
  });
  return loading;
}

function setDrafts(key: string, next: StoredPlanReviewDrafts) {
  if (!appAtomRegistry.get(loadedAtom)) editedBeforeLoad.add(key);
  appAtomRegistry.set(draftsAtom, next);
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void ensureLoaded()
      .then(async () =>
        writeFileAtomically(
          await draftsFile(),
          JSON.stringify({ drafts: appAtomRegistry.get(draftsAtom) }),
        ),
      )
      .catch((error: unknown) => console.warn("[plan-review] failed to save drafts", error));
  }, PERSIST_DEBOUNCE_MS);
}

export function updatePlanReviewDraft(
  key: string,
  change: (draft: PlanReviewDraft) => PlanReviewDraft,
): void {
  const drafts = appAtomRegistry.get(draftsAtom);
  const current = drafts[key] ?? EMPTY_PLAN_REVIEW_DRAFT;
  const next = change(current);
  if (next !== current) setDrafts(key, withPlanReviewDraft(drafts, key, next, Date.now()));
}

/** With `sent`, keeps notes written while that version was being sent. */
export function clearPlanReviewDraft(key: string, sent?: PlanReviewDraft): void {
  const drafts = appAtomRegistry.get(draftsAtom);
  const current = drafts[key] ?? EMPTY_PLAN_REVIEW_DRAFT;
  if (
    sent !== undefined &&
    (current.general !== sent.general ||
      JSON.stringify(current.annotations) !== JSON.stringify(sent.annotations))
  ) {
    return;
  }
  setDrafts(key, withPlanReviewDraft(drafts, key, EMPTY_PLAN_REVIEW_DRAFT, 0));
}

export function usePlanReviewDraft(key: string): PlanReviewDraft {
  const draft = useAtomValue(draftsAtom, (drafts) => drafts[key] ?? EMPTY_PLAN_REVIEW_DRAFT);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts loading saved review notes from native storage on first use
  useEffect(() => {
    ensureLoaded().catch(() => undefined);
  }, []);
  return draft;
}

export function usePlanReviewDraftsLoaded(): boolean {
  return useAtomValue(loadedAtom);
}
