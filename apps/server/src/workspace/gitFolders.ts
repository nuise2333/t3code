// @effect-diagnostics nodeBuiltinImport:off - one lstat per marker, with errno-level control.
import * as NodeFSP from "node:fs/promises";

import type * as Path from "effect/Path";

// NTFS reaches .git through trailing dots/spaces, stream suffixes and GIT~1; compare uppercased names.
export const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

// Reject Git folders, including renamed bare repos whose config/hooks can execute; paths must be normalized.
// Stop at linked worktrees' .git files since worktrees can sit inside bare repos.
export const isInGitFolder = async (path: Path.Path, absolutePath: string) => {
  if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
  for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
    const [head, commondir, objects, refs, dotGit] = await Promise.all(
      ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
        NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
          // Any other failure leaves the folder unknown, so the write is refused.
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        }),
      ),
    );
    // Git recognizes HEAD with commondir or objects/refs as a repository.
    if (head && (commondir || (objects && refs))) return true;
    if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
  }
};
