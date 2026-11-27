import { mergeThreeWay } from "./markdownConflict";

export interface PublishedContents {
  /** The file as the editor last knew it: what it opened, published, or took in from elsewhere. */
  readonly published: string;
  /** Keystrokes not published yet. */
  readonly dirty: boolean;
}

/**
 * What the editor does with a new version of the file from the panel: its own save coming back
 * is ignored; unpublished keystrokes win, as they do in the source editor, and are published;
 * anything else is a change made elsewhere and is taken in, a revert to an older version too.
 */
export function decideIncomingContents(
  incoming: string,
  state: PublishedContents,
): "ignore" | "publish" | "apply" {
  if (incoming === state.published) return "ignore";
  return state.dirty ? "publish" : "apply";
}

export type IncomingOutcome =
  | { readonly kind: "ignore" }
  | { readonly kind: "apply"; readonly text: string }
  /** Both sides merged; `published` is the disk's version, so a merge that differs is saved. */
  | {
      readonly kind: "merged";
      readonly text: string;
      readonly published: string;
      readonly dirty: boolean;
    }
  | { readonly kind: "conflict"; readonly base: string; readonly disk: string };

/**
 * A new version of the file reconciled with keystrokes not published yet: taken in when there
 * are none, merged when the two touch different lines, and held as a conflict when they overlap.
 */
export function reconcileIncoming(
  incoming: string,
  state: PublishedContents & { readonly latest: string },
): IncomingOutcome {
  const decision = decideIncomingContents(incoming, state);
  if (decision === "ignore") return { kind: "ignore" };
  if (decision === "apply") return { kind: "apply", text: incoming };
  const merged = mergeThreeWay(state.published, state.latest, incoming);
  if (merged.conflicts > 0) return { kind: "conflict", base: state.published, disk: incoming };
  return {
    kind: "merged",
    text: merged.merged,
    published: incoming,
    dirty: merged.merged !== incoming,
  };
}

/** What the editor writes as it goes away: an unsettled conflict keeps both sides, marked. */
export function contentsOnClose(
  latest: string,
  conflict: { readonly base: string; readonly disk: string } | null,
): string {
  return conflict ? mergeThreeWay(conflict.base, latest, conflict.disk).merged : latest;
}
