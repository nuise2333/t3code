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
