import type { CouncilSettings, TokenSaverSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/**
 * A new thread's token saver and Council, picked before it exists. Absent keys start the thread
 * with the user's defaults; null starts it off. Kept in memory: a reload falls back to defaults.
 */
export interface DraftThreadAssists {
  readonly tokenSaver?: TokenSaverSettings | null;
  readonly council?: CouncilSettings | null;
}

export const draftThreadAssistsAtom = Atom.family((_draftId: string) =>
  Atom.make<DraftThreadAssists>({}).pipe(Atom.keepAlive),
);
