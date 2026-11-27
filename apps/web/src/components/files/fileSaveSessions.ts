import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  ProjectWriteFileConflictError,
  ProjectWriteFileError,
  type ProjectWriteFileResult,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import { toastManager } from "~/components/ui/toast";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "~/state/session";

import { mergeThreeWay } from "./markdownConflict";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { absoluteFilePath, isSameOrInside } from "./fileOperations.logic";
import {
  clearProjectFileQueryData,
  getProjectFileBase,
  setProjectFileQueryData,
  type ProjectFileBase,
  confirmProjectFileQueryData,
  getProjectFileQueryAtom,
  getUnsavedProjectFileQueryData,
} from "./projectFilesQueryState";

export interface FileSaveTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export type FilePendingListener = (relativePath: string, pending: boolean) => void;

export interface FileSaveConflict {
  readonly base: string;
  readonly disk: string;
  readonly local: string;
}
type ConflictListener = (conflict: FileSaveConflict | null) => void;

/** A conflict kept outside the page, with the disk revision a resolution is written against. */
export interface StoredFileSaveConflict extends FileSaveConflict {
  readonly revision: string;
}

export interface FileSaveSessionDeps {
  readonly debounceMs: number;
  readonly canPersist: (target: FileSaveTarget) => boolean;
  /** Calls `onWritable` each time the target environment regains write access. */
  readonly subscribeWritable: (target: FileSaveTarget, onWritable: () => void) => () => void;
  readonly persist: (
    target: FileSaveTarget,
    contents: string,
    expectedRevision?: string,
  ) => Promise<AtomCommandResult<ProjectWriteFileResult, unknown>>;
  readonly readBase: (target: FileSaveTarget) => ProjectFileBase | undefined;
  readonly publish: (target: FileSaveTarget, contents: string, base?: ProjectFileBase) => void;
  readonly reportConflict: (target: FileSaveTarget, message: string) => void;
  readonly confirm: (target: FileSaveTarget, contents: string, revision?: string) => boolean;
  readonly readUnsaved: (target: FileSaveTarget) => string | null;
  readonly discardUnsaved: (target: FileSaveTarget) => void;
  /** Keeps unsettled conflicts across reloads, keyed by `fileSaveKey`. */
  readonly conflictStore: {
    readonly read: (key: string) => StoredFileSaveConflict | null;
    readonly write: (key: string, conflict: StoredFileSaveConflict | null) => void;
  };
}

interface FileSaveSession {
  readonly target: FileSaveTarget;
  readonly coordinator: FileSaveCoordinator<ProjectWriteFileResult>;
  base: ProjectFileBase | undefined;
  conflict: FileSaveConflict | null;
  /** Resolved when the next write pass ends. */
  readonly settleWaiters: Array<() => void>;
  /** Lease count per listener; surfaces may share one listener. */
  readonly listeners: Map<FilePendingListener, number>;
  readonly unsubscribeWritable: () => void;
  leases: number;
  /** The last release flushed, and the session stays open until that settles. */
  flushingOnRelease: boolean;
}

/**
 * One save session, so one ordered write queue, per file. A released session
 * stays open until its flush settles, so a surface rejoining meanwhile reuses
 * it instead of racing the flush. A session that cannot write closes at once,
 * and the next one, or regained write access, resumes the unsaved draft.
 */
export function createFileSaveSessions(deps: FileSaveSessionDeps) {
  const sessions = new Map<string, FileSaveSession>();

  const conflictListeners = new Map<string, Set<ConflictListener>>();
  const updateConflict = (session: FileSaveSession, conflict: FileSaveConflict | null) => {
    session.conflict = conflict;
    deps.conflictStore.write(
      fileSaveKey(session.target),
      conflict ? { ...conflict, revision: session.base?.revision ?? "" } : null,
    );
    for (const listener of conflictListeners.get(fileSaveKey(session.target)) ?? [])
      listener(conflict);
  };

  const recover = (session: FileSaveSession) => {
    // A conflict left unsettled by an earlier page comes back with its draft, still unwritten.
    const stored = session.conflict ? null : deps.conflictStore.read(fileSaveKey(session.target));
    if (stored) {
      session.base = { contents: stored.disk, revision: stored.revision };
      updateConflict(session, { base: stored.base, disk: stored.disk, local: stored.local });
      deps.publish(session.target, stored.local, session.base);
      session.coordinator.change(stored.local);
      return;
    }
    if (session.conflict || !deps.canPersist(session.target)) return;
    const unsaved = deps.readUnsaved(session.target);
    if (unsaved !== null) {
      session.base ??= deps.readBase(session.target);
      session.coordinator.change(unsaved);
    }
  };

  const create = (key: string, target: FileSaveTarget): FileSaveSession => {
    const listeners = new Map<FilePendingListener, number>();
    let retryingMerge = false;
    const coordinator: FileSaveCoordinator<ProjectWriteFileResult> = new FileSaveCoordinator({
      debounceMs: deps.debounceMs,
      canPersist: () => !session.conflict && deps.canPersist(target),
      // The last surface's listeners outlive it: a flush that settles after
      // the session is released still has to clear the pending marker.
      onPendingChange: (pending) => {
        for (const listener of listeners.keys()) listener(target.relativePath, pending);
      },
      persist: async (contents) => {
        const base = session.base;
        const result = await deps.persist(target, contents, base?.revision);
        const retry = retryingMerge;
        retryingMerge = false;
        if (result._tag === "Success" || coordinator.unconfirmedContents === null) return result;
        const cause = squashAtomCommandFailure(result);
        if (!isWriteConflict(cause)) return result;
        const disk = cause.currentContents;
        if (disk !== undefined && base) {
          const local = coordinator.unconfirmedContents;
          const { merged, conflicts } = mergeThreeWay(base.contents, local, disk);
          session.base = { contents: disk, revision: cause.currentRevision };
          if (!conflicts && !retry) {
            retryingMerge = true;
            deps.publish(target, merged, session.base);
            coordinator.change(merged);
            coordinator.flush();
            return result;
          }
          // The draft stays in the editor; only the conflict bar shows the disk's version.
          updateConflict(session, { base: base.contents, local, disk });
        }
        deps.reportConflict(target, cause.message);
        return result;
      },
      onConfirmed: (contents, result) => {
        session.base = { contents, revision: result.revision };
        return deps.confirm(target, contents, result.revision);
      },
      onSettled: () => {
        for (const resolve of session.settleWaiters.splice(0)) resolve();
        if (!session.flushingOnRelease) return;
        session.flushingOnRelease = false;
        if (session.leases === 0) {
          if (session.conflict) {
            session.listeners.clear();
            return;
          }
          if (sessions.get(key) === session) sessions.delete(key);
          session.unsubscribeWritable();
        } else if (coordinator.unconfirmedContents !== null) {
          // A surface rejoined while the release flush failed; retry it once.
          recover(session);
        }
      },
    });
    const unsubscribeWritable = deps.subscribeWritable(target, () => recover(session));
    const session: FileSaveSession = {
      target,
      coordinator,
      settleWaiters: [],
      listeners,
      unsubscribeWritable,
      base: undefined,
      conflict: null,
      leases: 0,
      flushingOnRelease: false,
    };
    return session;
  };

  const acquire = (target: FileSaveTarget, onPendingChange: FilePendingListener): (() => void) => {
    const key = fileSaveKey(target);
    const existing = sessions.get(key);
    const session = existing ?? create(key, target);
    sessions.set(key, session);
    session.leases += 1;
    session.listeners.set(onPendingChange, (session.listeners.get(onPendingChange) ?? 0) + 1);
    if (!existing) recover(session);
    else if (session.coordinator.unconfirmedContents !== null) {
      onPendingChange(target.relativePath, true);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.leases -= 1;
      if (session.leases > 0) {
        const count = (session.listeners.get(onPendingChange) ?? 1) - 1;
        if (count > 0) session.listeners.set(onPendingChange, count);
        else session.listeners.delete(onPendingChange);
        return;
      }
      session.flushingOnRelease = true;
      session.coordinator.flush();
    };
  };

  const sessionsUnder = (environmentId: EnvironmentId, paths: readonly string[]) =>
    [...sessions.values()].filter(
      ({ target }) =>
        target.environmentId === environmentId &&
        paths.some((path) =>
          isSameOrInside(absoluteFilePath(target.relativePath, target.cwd), path),
        ),
    );

  return {
    /** Holds the file's session open until the returned release runs. */
    acquire,
    subscribeConflict(target: FileSaveTarget, listener: ConflictListener): () => void {
      const key = fileSaveKey(target);
      const listeners = conflictListeners.get(key) ?? new Set<ConflictListener>();
      listeners.add(listener);
      conflictListeners.set(key, listeners);
      listener(sessions.get(key)?.conflict ?? null);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) conflictListeners.delete(key);
      };
    },
    resolveConflict(target: FileSaveTarget, contents: string): void {
      const session = sessions.get(fileSaveKey(target));
      if (!session?.conflict) return;
      updateConflict(session, null);
      deps.publish(target, contents, session.base);
      session.coordinator.change(contents);
      session.flushingOnRelease = session.leases === 0;
      session.coordinator.flush();
    },
    /** Writes drafts at or under the absolute `paths` before they move, and resolves once written. */
    flushUnder(environmentId: EnvironmentId, paths: readonly string[]): Promise<void> {
      return Promise.all(
        sessionsUnder(environmentId, paths).map(
          (session) =>
            new Promise<void>((resolve) => {
              session.settleWaiters.push(resolve);
              session.coordinator.flush();
            }),
        ),
      ).then(() => undefined);
    },
    /** Files at or under the absolute `paths` whose latest edit the server has not confirmed. */
    unsavedUnder(environmentId: EnvironmentId, paths: readonly string[]): readonly string[] {
      return sessionsUnder(environmentId, paths)
        .filter(
          ({ coordinator, conflict }) =>
            coordinator.unconfirmedContents !== null || conflict !== null,
        )
        .map(({ target }) => target.relativePath);
    },
    /** Forgets drafts at or under the absolute `paths`, which no longer exist. */
    discardUnder(environmentId: EnvironmentId, paths: readonly string[]): void {
      for (const session of sessionsUnder(environmentId, paths)) {
        updateConflict(session, null);
        session.coordinator.discard();
        if (!session.leases) {
          sessions.delete(fileSaveKey(session.target));
          session.unsubscribeWritable();
        }
        deps.discardUnsaved(session.target);
      }
    },
    /** Edits for a file nobody holds open are dropped, so retired editors stay inert. */
    change(target: FileSaveTarget, contents: string): void {
      const session = sessions.get(fileSaveKey(target));
      if (!session || !session.leases) return;
      if (session.coordinator.unconfirmedContents === null) session.base = deps.readBase(target);
      if (session.conflict) updateConflict(session, { ...session.conflict, local: contents });
      session.coordinator.change(contents);
    },
  };
}

function fileSaveKey({ environmentId, cwd, relativePath }: FileSaveTarget): string {
  return `${environmentId}\u0000${cwd}\u0000${relativePath}`;
}

const isWriteConflict = Schema.is(ProjectWriteFileConflictError);
const CONFLICT_STORAGE_PREFIX = "t3code:file-save-conflict:";
const StoredConflictJson = Schema.fromJsonString(
  Schema.Struct({
    base: Schema.String,
    disk: Schema.String,
    local: Schema.String,
    revision: Schema.String,
  }),
);
const decodeStoredConflictOption = Schema.decodeOption(StoredConflictJson);
const decodeStoredConflict = (raw: string): StoredFileSaveConflict | null =>
  Option.getOrNull(decodeStoredConflictOption(raw));
const isProjectWriteFileError = Schema.is(ProjectWriteFileError);
const missingFileNotices = new Set<string>();

/** A file the server last reported absent is being created; any other may only be overwritten. */
function knownMissing({ environmentId, cwd, relativePath }: FileSaveTarget): boolean {
  const read = appAtomRegistry.get(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  return Option.getOrUndefined(AsyncResult.value(read))?.exists === false;
}

function reportMissingFile(target: FileSaveTarget, result: AtomCommandResult<unknown, unknown>) {
  const key = fileSaveKey(target);
  if (result._tag === "Success") {
    missingFileNotices.delete(key);
    return;
  }
  const cause = squashAtomCommandFailure(result);
  if (!isProjectWriteFileError(cause) || cause.failure !== "not_found") return;
  if (missingFileNotices.has(key)) return;
  missingFileNotices.add(key);
  toastManager.add({
    type: "warning",
    title: "Edits not saved",
    description: `${target.relativePath} was moved or deleted. Your edits are kept in this tab.`,
  });
}

const fileSaveSessions = createFileSaveSessions({
  debounceMs: 500,
  canPersist: ({ environmentId }) => readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
  subscribeWritable: ({ environmentId }, onWritable) => {
    let writable = readEnvironmentScope(environmentId, AuthFilesystemWriteScope);
    return appAtomRegistry.subscribe(
      environmentSession.sessionStateAtom(environmentId),
      (state) => {
        const next = sessionHasScope(state, AuthFilesystemWriteScope);
        if (next && !writable) onWritable();
        writable = next;
      },
    );
  },
  persist: async (target, contents, expectedRevision) => {
    const { environmentId, cwd, relativePath } = target;
    const result = await runAtomCommand(appAtomRegistry, projectEnvironment.writeFile, {
      environmentId,
      input: {
        cwd,
        relativePath,
        contents,
        expectedRevision,
        createIfMissing: knownMissing(target),
      },
    });
    reportMissingFile(target, result);
    return result;
  },
  readBase: ({ environmentId, cwd, relativePath }) =>
    getProjectFileBase(environmentId, cwd, relativePath),
  publish: ({ environmentId, cwd, relativePath }, contents, base) =>
    setProjectFileQueryData(environmentId, cwd, relativePath, contents, base),
  reportConflict: (_target, description) =>
    toastManager.add({ type: "warning", title: "Edits not saved", description }),
  confirm: ({ environmentId, cwd, relativePath }, contents, revision) =>
    confirmProjectFileQueryData(environmentId, cwd, relativePath, contents, revision),
  conflictStore: {
    read: (key) => {
      try {
        const raw = window.localStorage.getItem(CONFLICT_STORAGE_PREFIX + key);
        return raw === null ? null : decodeStoredConflict(raw);
      } catch {
        return null;
      }
    },
    write: (key, conflict) => {
      try {
        if (conflict)
          window.localStorage.setItem(CONFLICT_STORAGE_PREFIX + key, JSON.stringify(conflict));
        else window.localStorage.removeItem(CONFLICT_STORAGE_PREFIX + key);
      } catch {
        // Storage full or blocked: the conflict still lives in this page.
      }
    },
  },
  readUnsaved: ({ environmentId, cwd, relativePath }) =>
    getUnsavedProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? null,
  discardUnsaved: ({ environmentId, cwd, relativePath }) =>
    clearProjectFileQueryData(environmentId, cwd, relativePath),
});

/** @public */
export const subscribeFileSaveConflict = fileSaveSessions.subscribeConflict;
/** @public */
export const resolveFileSaveConflict = fileSaveSessions.resolveConflict;
export const flushFileSaveSessionsUnder = fileSaveSessions.flushUnder;
export const discardFileSaveSessionsUnder = fileSaveSessions.discardUnder;
export const unsavedFileSaveSessionsUnder = fileSaveSessions.unsavedUnder;

/** Holds the file's save session while the surface is mounted; the last surface to leave flushes. */
export function useFileSaveSession(
  { environmentId, cwd, relativePath }: FileSaveTarget,
  onPendingChange: FilePendingListener,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the lease is a mount-scoped external resource; React runs every unmount cleanup before mount setups, so a surface switch flushes before the next surface recovers.
  useEffect(
    () => fileSaveSessions.acquire({ environmentId, cwd, relativePath }, onPendingChange),
    [environmentId, cwd, relativePath, onPendingChange],
  );
}

export function changeFileSaveSession(target: FileSaveTarget, contents: string): void {
  fileSaveSessions.change(target, contents);
}
