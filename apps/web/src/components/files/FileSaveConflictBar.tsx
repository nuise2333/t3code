import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";

import {
  type FileSaveConflict,
  type FileSaveTarget,
  resolveFileSaveConflict,
  subscribeFileSaveConflict,
} from "./fileSaveSessions";
import { mergeThreeWay } from "./markdownConflict";

/**
 * A save the disk refused because the file changed meanwhile. The editor keeps the draft; this bar
 * shows until the user picks what is written over the disk's version.
 */
export function FileSaveConflictBar(props: { readonly target: FileSaveTarget }) {
  const { environmentId, cwd, relativePath } = props.target;
  const [conflict, setConflict] = useState<FileSaveConflict | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the save session reports refused writes from outside React
  useEffect(
    () => subscribeFileSaveConflict({ environmentId, cwd, relativePath }, setConflict),
    [environmentId, cwd, relativePath],
  );
  if (!conflict) return null;
  const resolve = (contents: string) =>
    resolveFileSaveConflict({ environmentId, cwd, relativePath }, contents);
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs"
    >
      <span className="mr-auto">
        This file changed on disk while you were editing. Saving is paused until you choose a
        version.
      </span>
      <Button size="xs" variant="outline" onClick={() => resolve(conflict.local)}>
        Keep mine
      </Button>
      <Button size="xs" variant="outline" onClick={() => resolve(conflict.disk)}>
        Use disk version
      </Button>
      <Button
        size="xs"
        variant="outline"
        onClick={() => resolve(mergeThreeWay(conflict.base, conflict.local, conflict.disk).merged)}
      >
        Insert conflict markers
      </Button>
    </div>
  );
}
