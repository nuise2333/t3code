import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  ProjectWriteFileError,
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

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { absoluteFilePath, isSameOrInside } from "./fileOperations.logic";
import {
  clearProjectFileQueryData,
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

export interface FileSaveSessionDeps {
  readonly debounceMs: number;
  readonly canPersist: (target: FileSaveTarget) => boolean;
  /** Calls `onWritable` each time the target environment regains write access. */
  readonly subscribeWritable: (target: FileSaveTarget, onWritable: () => void) => () => void;
  readonly persist: (
    target: FileSaveTarget,
    contents: string,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly confirm: (target: FileSaveTarget, contents: string) => boolean;
  readonly readUnsaved: (target: FileSaveTarget) => string | null;
  readonly discardUnsaved: (target: FileSaveTarget) => void;
}

interface FileSaveSession {
  readonly target: FileSaveTarget;
  readonly coordinator: FileSaveCoordinator;
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

  const recover = (target: FileSaveTarget, coordinator: FileSaveCoordinator) => {
    if (!deps.canPersist(target)) return;
    const unsaved = deps.readUnsaved(target);
    if (unsaved !== null) coordinator.change(unsaved);
  };

  const create = (key: string, target: FileSaveTarget): FileSaveSession => {
    const listeners = new Map<FilePendingListener, number>();
    const coordinator: FileSaveCoordinator = new FileSaveCoordinator({
      debounceMs: deps.debounceMs,
      canPersist: () => deps.canPersist(target),
      // The last surface's listeners outlive it: a flush that settles after
      // the session is released still has to clear the pending marker.
      onPendingChange: (pending) => {
        for (const listener of listeners.keys()) listener(target.relativePath, pending);
      },
      persist: (contents) => deps.persist(target, contents),
      onConfirmed: (contents) => deps.confirm(target, contents),
      onSettled: () => {
        for (const resolve of session.settleWaiters.splice(0)) resolve();
        if (!session.flushingOnRelease) return;
        session.flushingOnRelease = false;
        if (session.leases === 0) {
          if (sessions.get(key) === session) sessions.delete(key);
          session.unsubscribeWritable();
        } else if (coordinator.unconfirmedContents !== null) {
          // A surface rejoined while the release flush failed; retry it once.
          recover(target, coordinator);
        }
      },
    });
    const unsubscribeWritable = deps.subscribeWritable(target, () => recover(target, coordinator));
    const session: FileSaveSession = {
      target,
      coordinator,
      settleWaiters: [],
      listeners,
      unsubscribeWritable,
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
    if (!existing) recover(target, session.coordinator);
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
        .filter(({ coordinator }) => coordinator.unconfirmedContents !== null)
        .map(({ target }) => target.relativePath);
    },
    /** Forgets drafts at or under the absolute `paths`, which no longer exist. */
    discardUnder(environmentId: EnvironmentId, paths: readonly string[]): void {
      for (const session of sessionsUnder(environmentId, paths)) {
        session.coordinator.discard();
        deps.discardUnsaved(session.target);
      }
    },
    /** Edits for a file nobody holds open are dropped, so retired editors stay inert. */
    change(target: FileSaveTarget, contents: string): void {
      const session = sessions.get(fileSaveKey(target));
      if (session && session.leases > 0) session.coordinator.change(contents);
    },
  };
}

function fileSaveKey({ environmentId, cwd, relativePath }: FileSaveTarget): string {
  return `${environmentId}\u0000${cwd}\u0000${relativePath}`;
}

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
  persist: async (target, contents) => {
    const { environmentId, cwd, relativePath } = target;
    const result = await runAtomCommand(appAtomRegistry, projectEnvironment.writeFile, {
      environmentId,
      input: { cwd, relativePath, contents, createIfMissing: knownMissing(target) },
    });
    reportMissingFile(target, result);
    return result;
  },
  confirm: ({ environmentId, cwd, relativePath }, contents) =>
    confirmProjectFileQueryData(environmentId, cwd, relativePath, contents),
  readUnsaved: ({ environmentId, cwd, relativePath }) =>
    getUnsavedProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? null,
  discardUnsaved: ({ environmentId, cwd, relativePath }) =>
    clearProjectFileQueryData(environmentId, cwd, relativePath),
});

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
