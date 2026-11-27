import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, use } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";

/** How a block draws when it isn't open: as the reader renders it, or as its muted source. */
export type BlockPreviewKind = "definition" | "frontmatter" | "footnote" | "html" | "other";

export interface BlockPreviewContextValue {
  readonly cwd: string;
  readonly imageBaseDir: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
}

export const BlockPreviewContext = createContext<BlockPreviewContextValue | null>(null);

const FOOTNOTE_LABEL = /^\[\^([^\]\r\n]+)\]:[ \t]?/;

/** A Markdown block as the reading view renders it. */
export function BlockPreview(props: {
  readonly kind: BlockPreviewKind;
  readonly text: string;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const context = use(BlockPreviewContext);
  const { kind, text } = props;
  // Nothing the reader draws: the source itself, muted.
  if (
    !context ||
    kind === "definition" ||
    kind === "frontmatter" ||
    (kind === "html" && /^\s*<!--[\s\S]*-->\s*$/.test(text))
  ) {
    return <div className="reader-raw-muted">{text}</div>;
  }
  const markdown = (source: string) => (
    <ChatMarkdown
      bare
      variant="reader"
      text={source}
      cwd={context.cwd}
      imageBaseDir={context.imageBaseDir}
      threadRef={context.threadRef}
      workspaceMutationId={context.workspaceMutationId}
      onTaskListChange={props.onTaskListChange}
    />
  );
  if (kind === "footnote") {
    const label = FOOTNOTE_LABEL.exec(text);
    if (label) {
      // A definition alone renders nothing: the reader shows notes only where they are cited.
      const body = text
        .slice(label[0].length)
        .split(/\r?\n/)
        .map((line) => line.replace(/^ {1,4}/, ""))
        .join("\n");
      return (
        <div className="reader-raw-footnote">
          <span className="reader-md-footnote-label">{label[1]}</span>
          {markdown(body)}
        </div>
      );
    }
  }
  return markdown(text);
}
