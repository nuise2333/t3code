// @effect-diagnostics nodeBuiltinImport:off - the home trash needs O_EXCL opens and same-device renames.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { encodeUtf16LeBase64, resolvePowerShellPath } from "../process/externalLauncher.ts";

export type HostTrashOutcome =
  | "trashed"
  | "unavailable"
  | "not_found"
  | "permission_denied"
  | "failed";

const HELPER_TIMEOUT = "30 seconds";
const FORCE_KILL_AFTER = "1 second";
const HELPER_OUTCOMES: ReadonlySet<string> = new Set<HostTrashOutcome>([
  "trashed",
  "unavailable",
  "not_found",
  "permission_denied",
  "failed",
]);

export class HostTrash extends Context.Service<
  HostTrash,
  {
    /** Takes resolved absolute paths; outcomes follow their order. */
    readonly trash: (
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<HostTrashOutcome>>;
  }
>()("t3/workspace/HostTrash") {}

// NSFileManager needs no Finder automation permission. Paths arrive as JSON on stdin.
const MACOS_TRASH_SCRIPT = `ObjC.import("Foundation");
function outcome(error) {
  const code = Number(error.code);
  const domain = error.domain.js;
  if (domain === "NSPOSIXErrorDomain") return code === 2 ? "not_found" : code === 1 || code === 13 || code === 30 ? "permission_denied" : "failed";
  if (code === 4 || code === 260) return "not_found";
  if (code === 257 || code === 513 || code === 642) return "permission_denied";
  if (code === 3328) return "unavailable";
  return "failed";
}
function run() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const paths = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
  const manager = $.NSFileManager.defaultManager;
  return JSON.stringify(paths.map((path) => {
    const error = $();
    if (manager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), null, error)) return "trashed";
    return outcome(error);
  }));
}`;

// IFileOperation without UI. The sink aborts any delete the Recycle Bin cannot take, which
// Windows would otherwise carry out permanently and without asking.
const WINDOWS_TRASH_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace T3Trash {
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {}
  [ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperationProgressSink {
    [PreserveSig] int StartOperations();
    [PreserveSig] int FinishOperations(int hrResult);
    [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem created);
    [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem created);
    [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem created);
    [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
    [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int hr, IShellItem created);
    [PreserveSig] int PreNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    [PreserveSig] int PostNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, [MarshalAs(UnmanagedType.LPWStr)] string template, uint attributes, int hr, IShellItem created);
    [PreserveSig] int UpdateProgress(uint total, uint done);
    [PreserveSig] int ResetTimer();
    [PreserveSig] int PauseTimer();
    [PreserveSig] int ResumeTimer();
  }
  [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOperation {
    uint Advise(IFileOperationProgressSink sink);
    void Unadvise(uint cookie);
    void SetOperationFlags(uint flags);
    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
    void SetProgressDialog(IntPtr dialog);
    void SetProperties(IntPtr properties);
    void SetOwnerWindow(IntPtr owner);
    void ApplyPropertiesToItem(IShellItem item);
    void ApplyPropertiesToItems([MarshalAs(UnmanagedType.Interface)] object items);
    void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
    void RenameItems([MarshalAs(UnmanagedType.Interface)] object items, [MarshalAs(UnmanagedType.LPWStr)] string newName);
    void MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
    void MoveItems([MarshalAs(UnmanagedType.Interface)] object items, IShellItem destination);
    void CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
    void CopyItems([MarshalAs(UnmanagedType.Interface)] object items, IShellItem destination);
    void DeleteItem(IShellItem item, IFileOperationProgressSink sink);
    void DeleteItems([MarshalAs(UnmanagedType.Interface)] object items);
    void NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IFileOperationProgressSink sink);
    void PerformOperations();
    [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
  }
  public class Sink : IFileOperationProgressSink {
    public bool WouldDelete;
    public int Result = 1;
    public int StartOperations() { return 0; }
    public int FinishOperations(int hrResult) { return 0; }
    public int PreRenameItem(uint flags, IShellItem item, string newName) { return 0; }
    public int PostRenameItem(uint flags, IShellItem item, string newName, int hr, IShellItem created) { return 0; }
    public int PreMoveItem(uint flags, IShellItem item, IShellItem destination, string newName) { return 0; }
    public int PostMoveItem(uint flags, IShellItem item, IShellItem destination, string newName, int hr, IShellItem created) { return 0; }
    public int PreCopyItem(uint flags, IShellItem item, IShellItem destination, string newName) { return 0; }
    public int PostCopyItem(uint flags, IShellItem item, IShellItem destination, string newName, int hr, IShellItem created) { return 0; }
    public int PreDeleteItem(uint flags, IShellItem item) {
      if ((flags & 0x80) == 0) { WouldDelete = true; return unchecked((int)0x80004004); }
      return 0;
    }
    public int PostDeleteItem(uint flags, IShellItem item, int hr, IShellItem created) { Result = hr; return 0; }
    public int PreNewItem(uint flags, IShellItem destination, string newName) { return 0; }
    public int PostNewItem(uint flags, IShellItem destination, string newName, string template, uint attributes, int hr, IShellItem created) { return 0; }
    public int UpdateProgress(uint total, uint done) { return 0; }
    public int ResetTimer() { return 0; }
    public int PauseTimer() { return 0; }
    public int ResumeTimer() { return 0; }
  }
  public static class Recycler {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr context, [In] ref Guid riid, out IShellItem item);
    public static string Trash(string path) {
      if (!System.IO.File.Exists(path) && !System.IO.Directory.Exists(path)) return "not_found";
      var sink = new Sink();
      try {
        Guid shellItem = typeof(IShellItem).GUID;
        IShellItem item;
        SHCreateItemFromParsingName(path, IntPtr.Zero, ref shellItem, out item);
        var operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
        // FOF_NO_UI | FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE
        operation.SetOperationFlags(0x614u | 0x40u | 0x80000u | 0x100000u);
        operation.DeleteItem(item, sink);
        operation.PerformOperations();
      } catch (COMException error) {
        if (sink.WouldDelete) return "unavailable";
        return error.ErrorCode == unchecked((int)0x80070005) ? "permission_denied" : "failed";
      } catch (UnauthorizedAccessException) {
        return "permission_denied";
      }
      if (sink.WouldDelete) return "unavailable";
      if (sink.Result == 0) return "trashed";
      if (sink.Result == unchecked((int)0x80070002) || sink.Result == unchecked((int)0x80070003)) return "not_found";
      if (sink.Result == unchecked((int)0x80070005)) return "permission_denied";
      return "failed";
    }
  }
}
'@
$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json
$outcomes = @(foreach ($path in $paths) { [T3Trash.Recycler]::Trash([string]$path) })
[Console]::Out.Write((ConvertTo-Json -InputObject $outcomes -Compress))`;

/** Every outcome is `failed` unless the helper answered one valid outcome per path. */
export function parseHelperOutcomes(
  stdout: string,
  count: number,
): ReadonlyArray<HostTrashOutcome> {
  const failed = Array.from({ length: count }, (): HostTrashOutcome => "failed");
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    const values = count === 1 && typeof parsed === "string" ? [parsed] : parsed;
    if (!Array.isArray(values) || values.length !== count) return failed;
    return values.map((value) =>
      typeof value === "string" && HELPER_OUTCOMES.has(value)
        ? (value as HostTrashOutcome)
        : "failed",
    );
  } catch {
    return failed;
  }
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function trashInfoContents(absolutePath: string, deletedAtMillis: number): string {
  const at = DateTime.toParts(
    DateTime.makeZonedUnsafe(deletedAtMillis, { timeZone: DateTime.zoneMakeLocal() }),
  );
  const encodedPath = absolutePath.split("/").map(encodeURIComponent).join("/");
  const date = `${at.year}-${pad(at.month)}-${pad(at.day)}T${pad(at.hour)}:${pad(at.minute)}:${pad(at.second)}`;
  return `[Trash Info]\nPath=${encodedPath}\nDeletionDate=${date}\n`;
}

/** Helpers read their paths from stdin, never from arguments or script text. */
const helperStdin = (paths: ReadonlyArray<string>) => JSON.stringify(paths);

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

function outcomeForErrno(error: unknown): HostTrashOutcome {
  switch (errorCode(error)) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "permission_denied";
    case "EXDEV":
      return "unavailable";
    default:
      return "failed";
  }
}

/**
 * The freedesktop.org home trash, for items on its device only: another device would
 * mean copying the item, which the user did not ask for.
 */
export async function trashIntoHomeTrash(
  absolutePath: string,
  dataHome: string,
  deletedAtMillis: number,
): Promise<HostTrashOutcome> {
  const filesDirectory = NodePath.join(dataHome, "Trash", "files");
  const infoDirectory = NodePath.join(dataHome, "Trash", "info");
  try {
    await NodeFSP.mkdir(filesDirectory, { recursive: true, mode: 0o700 });
    await NodeFSP.mkdir(infoDirectory, { recursive: true, mode: 0o700 });
  } catch {
    return "unavailable";
  }
  try {
    const [item, trash] = await Promise.all([
      NodeFSP.lstat(absolutePath),
      NodeFSP.stat(filesDirectory),
    ]);
    if (item.dev !== trash.dev) return "unavailable";
  } catch (error) {
    return outcomeForErrno(error);
  }
  const baseName = NodePath.basename(absolutePath);
  const contents = trashInfoContents(absolutePath, deletedAtMillis);
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const name = attempt === 1 ? baseName : `${baseName}.${attempt}`;
    const infoPath = NodePath.join(infoDirectory, `${name}.trashinfo`);
    const trashedPath = NodePath.join(filesDirectory, name);
    // The info file claims the name first, as the spec requires.
    try {
      await NodeFSP.writeFile(infoPath, contents, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      return outcomeForErrno(error);
    }
    const taken = await NodeFSP.lstat(trashedPath).then(
      () => true,
      () => false,
    );
    if (taken) {
      await NodeFSP.unlink(infoPath).catch(() => undefined);
      continue;
    }
    try {
      await NodeFSP.rename(absolutePath, trashedPath);
      return "trashed";
    } catch (error) {
      await NodeFSP.unlink(infoPath).catch(() => undefined);
      return outcomeForErrno(error);
    }
  }
  return "failed";
}

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;

  const runHelper = Effect.fn("HostTrash.runHelper")(function* (
    command: string,
    args: ReadonlyArray<string>,
    paths: ReadonlyArray<string>,
  ) {
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            stdin: { stream: Stream.encodeText(Stream.make(helperStdin(paths))) },
            stderr: "ignore",
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        );
        const stdout = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
        yield* child.exitCode;
        return stdout;
      }),
    ).pipe(
      Effect.timeoutOption(HELPER_TIMEOUT),
      Effect.orElseSucceed(() => undefined),
    );
    return output === undefined || output._tag === "None"
      ? paths.map((): HostTrashOutcome => "failed")
      : parseHelperOutcomes(output.value, paths.length);
  });

  const dataHome =
    environment.XDG_DATA_HOME && NodePath.isAbsolute(environment.XDG_DATA_HOME)
      ? environment.XDG_DATA_HOME
      : NodePath.join(home, ".local", "share");
  const homeTrash = (path: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Effect.promise(() => trashIntoHomeTrash(path, dataHome, now))),
    );

  const gio = platform === "linux" ? yield* resolveCommandPath("gio") : null;
  // gio takes paths only as arguments; it runs without a shell, one path per process.
  const gioTrash = Effect.fn("HostTrash.gioTrash")(function* (gioPath: string, path: string) {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(gioPath, ["trash", "--", path], {
            stdin: "ignore",
            stdout: "ignore",
            env: { LC_ALL: "C" },
            extendEnv: true,
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        );
        const stderr = yield* child.stderr.pipe(Stream.decodeText, Stream.mkString);
        return { code: Number(yield* child.exitCode), stderr };
      }),
    ).pipe(Effect.timeoutOption(HELPER_TIMEOUT), Effect.option);
    if (result._tag === "None" || result.value._tag === "None") return yield* homeTrash(path);
    const { code, stderr } = result.value.value;
    if (code === 0) return "trashed" as const;
    if (/No such file/iu.test(stderr)) return "not_found" as const;
    if (/Permission denied/iu.test(stderr)) return "permission_denied" as const;
    return yield* homeTrash(path);
  });

  const trashOnPlatform = (paths: ReadonlyArray<string>) => {
    switch (platform) {
      case "darwin":
        return runHelper(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", MACOS_TRASH_SCRIPT],
          paths,
        );
      case "win32":
        return runHelper(
          resolvePowerShellPath(environment),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodeUtf16LeBase64(WINDOWS_TRASH_SCRIPT),
          ],
          paths,
        );
      default:
        return Effect.forEach(paths, (path) =>
          gio === null ? homeTrash(path) : gioTrash(gio, path),
        );
    }
  };

  const sameEntry = (path: string) =>
    NodeFSP.lstat(path).then(
      (stats) => ({ dev: stats.dev, ino: stats.ino }),
      () => null,
    );

  const trash: HostTrash["Service"]["trash"] = Effect.fn("HostTrash.trash")(function* (paths) {
    if (paths.length === 0) return [];
    const before = yield* Effect.promise(() => Promise.all(paths.map(sameEntry)));
    const outcomes = yield* trashOnPlatform(paths);
    // macOS answers success for items on a read-only volume and leaves them in place.
    return yield* Effect.promise(() =>
      Promise.all(
        outcomes.map(async (outcome, index): Promise<HostTrashOutcome> => {
          const original = before[index];
          if (outcome !== "trashed" || !original) return outcome;
          const after = await sameEntry(paths[index]!);
          return after?.dev === original.dev && after.ino === original.ino ? "failed" : outcome;
        }),
      ),
    );
  });

  return HostTrash.of({ trash });
});

export const layer = Layer.effect(HostTrash, make);
