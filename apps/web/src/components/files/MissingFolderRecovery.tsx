import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";

import {
  fileBreadcrumbs,
  folderParentOf,
  folderReadOutcome,
  missingFolderProbeStep,
} from "./filePath";
import { useProjectFileQuery } from "./projectFilesQueryState";

/** Walks up from a Files tab's missing folder until a read reports an existing folder. */
export function MissingFolderRecovery(props: {
  environmentId: EnvironmentId;
  cwd: string;
  path: string;
  projectName: string;
  onNavigate: (path: string) => void;
}) {
  const [probe, setProbe] = useState(() => ({
    for: props.path,
    candidate: folderParentOf(props.path),
  }));
  const candidate = probe.for === props.path ? probe.candidate : folderParentOf(props.path);
  if (probe.for !== props.path) setProbe({ for: props.path, candidate });
  const read = useProjectFileQuery(
    props.environmentId,
    props.cwd,
    candidate || null,
    Boolean(candidate),
    true,
  );
  const step = missingFolderProbeStep(candidate, folderReadOutcome(read));
  if (step.kind === "walk") setProbe({ for: props.path, candidate: step.next });
  const target = step.kind === "target" ? step.path : null;
  const label =
    target === ""
      ? props.projectName
      : target === null
        ? null
        : (fileBreadcrumbs("", target).at(-1)?.label ?? target);
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-2xs text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">This folder no longer exists.</span>
      {target !== null ? (
        <Button size="micro" variant="outline" onClick={() => props.onNavigate(target)}>
          Go to {label}
        </Button>
      ) : null}
    </div>
  );
}
