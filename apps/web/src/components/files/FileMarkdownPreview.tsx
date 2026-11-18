import type { ScopedThreadRef } from "@t3tools/contracts";

import ChatMarkdown from "~/components/ChatMarkdown";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

import { readerFileSurfaceKey } from "~/reader/navigation/readerOutlineStore";
import { ReaderSurface } from "~/reader/navigation/ReaderSurface";

/** The folder a Markdown file's relative image and link paths resolve against. */
export function markdownFileBaseDir(cwd: string, relativePath: string): string {
  const lastSeparator = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
  return lastSeparator >= 0
    ? resolvePathLinkTarget(relativePath.slice(0, lastSeparator), cwd)
    : cwd;
}

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  return (
    <ReaderSurface surfaceKey={readerFileSurfaceKey(props.cwd, props.relativePath)}>
      <ChatMarkdown
        text={maskMarkdownFrontmatter(props.text)}
        cwd={props.cwd}
        imageBaseDir={markdownFileBaseDir(props.cwd, props.relativePath)}
        threadRef={props.threadRef}
        workspaceMutationId={props.workspaceMutationId}
        variant="reader"
        onTaskListChange={props.onTaskListChange}
      />
    </ReaderSurface>
  );
}
