// @effect-diagnostics globalTimers:off - the timeout guards a spawned process outside Effect.
// @effect-diagnostics nodeBuiltinImport:off - the host adapter spawns a specific PID and copies from a validated native descriptor.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import type { OpenMediaFile } from "../assets/MediaFile.ts";

export async function findSoffice(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const windows = platform === "win32";
  const candidates = [
    env.T3CODE_SOFFICE,
    ...["soffice", "libreoffice"].flatMap((name) =>
      (env.PATH ?? "")
        .split(NodePath.delimiter)
        .filter(Boolean)
        .map((dir) => NodePath.join(dir, windows ? name + ".exe" : name)),
    ),
  ];
  if (platform === "darwin")
    candidates.push("/Applications/LibreOffice.app/Contents/MacOS/soffice");
  if (windows) {
    for (const dir of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (dir) candidates.push(NodePath.join(dir, "LibreOffice/program/soffice.exe"));
    }
  }
  if (platform === "linux") {
    candidates.push("/usr/bin/soffice");
    for (const entry of await NodeFSP.readdir("/opt").catch(() => [])) {
      if (entry.startsWith("libreoffice"))
        candidates.push(NodePath.join("/opt", entry, "program/soffice"));
    }
  }
  for (const candidate of candidates) {
    if (
      candidate &&
      (await NodeFSP.access(candidate, NodeFS.constants.X_OK)
        .then(() => NodeFSP.stat(candidate))
        .then(
          (s) => s.isFile(),
          () => false,
        ))
    )
      return NodePath.resolve(candidate);
  }
  return null;
}

const fontAliases: Record<string, string[]> = {
  "Songti SC": ["宋体", "SimSun", "NSimSun"],
  "Heiti SC": ["黑体", "SimHei"],
  "Kaiti SC": ["楷体", "KaiTi"],
  STFangsong: ["仿宋", "FangSong"],
  "PingFang SC": ["微软雅黑", "Microsoft YaHei"],
};

export function officeProfile(
  profile: string,
  fontDirectories: readonly string[],
  families: readonly string[],
) {
  const links = fontDirectories.map((source) => ({
    source,
    target: NodePath.join(profile, "user", "fonts", encodeURIComponent(source)),
  }));
  const prop = (name: string, value: string) =>
    `<prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop>`;
  const pairs = Object.entries(fontAliases)
    .filter(([target]) => families.includes(target))
    .flatMap(([target, sources]) =>
      sources.map(
        (source) =>
          `<node oor:name="${source}" oor:op="replace">${prop("ReplaceFont", source)}${prop("SubstituteFont", target)}${prop("Always", "true")}${prop("OnScreenOnly", "false")}</node>`,
      ),
    );
  const fonts = "/org.openoffice.Office.Common/Font/Substitution";
  const registry = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting">${prop("DisableMacrosExecution", "true")}${prop("DisableActiveContent", "true")}${prop("BlockUntrustedRefererLinks", "true")}</item>
${pairs.length ? `<item oor:path="${fonts}">${prop("Replacement", "true")}</item><item oor:path="${fonts}/FontPairs">${pairs.join("")}</item>` : ""}
</oor:items>`;
  return { links, registry };
}

export async function prepareProfile(profile: string, platform: NodeJS.Platform, home: string) {
  const directories: string[] = [];
  let families: string[] = [];
  if (platform === "darwin") {
    for (const dir of [
      "/System/Library/Fonts",
      "/Library/Fonts",
      NodePath.join(home, "Library/Fonts"),
    ]) {
      if (
        await NodeFSP.stat(dir).then(
          (s) => s.isDirectory(),
          () => false,
        )
      )
        directories.push(dir);
    }
    // Without a login session the font list is unavailable; documents then render unsubstituted.
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        'ObjC.import("AppKit"); ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies).join("\\n")',
      ],
      { timeout: 10000 },
    ).catch(() => ({ stdout: "" }));
    families = stdout.trim().split("\n").filter(Boolean);
  }
  const { links, registry } = officeProfile(profile, directories, families);
  await NodeFSP.mkdir(NodePath.join(profile, "user", "fonts"), { recursive: true });
  for (const { source, target } of links) {
    if ((await NodeFSP.readlink(target).catch(() => null)) !== source) {
      await NodeFSP.symlink(source, target);
    }
  }
  await NodeFSP.writeFile(NodePath.join(profile, "user", "registrymodifications.xcu"), registry);
}

export const cacheName = (filePath: string, file: OpenMediaFile) =>
  NodeCrypto.createHash("sha256")
    // A file replaced in place can keep its size and mtime; its inode and ctime still change.
    .update(
      [
        filePath,
        file.info.dev,
        file.info.ino,
        file.info.size,
        file.info.mtimeNs,
        file.info.ctimeNs,
      ].join("\0"),
    )
    .digest("hex") + ".pdf";

const SOFFICE_TIMEOUT_MS = 60_000;
// Office files larger than this are not converted; LibreOffice's output can outgrow its input.
export const OFFICE_RENDER_MAX_SOURCE_BYTES = 100 * 1024 * 1024;

/**
 * Runs one conversion. On Linux and macOS `soffice` is a launcher that starts `soffice.bin`, so
 * the run gets its own process group and a timeout kills the whole group, not just the launcher.
 * The run ends when the launcher exits, even if a child still holds stderr open.
 */
export function runSoffice(binary: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const windows = NodePath.sep === "\\";
    const child = NodeChildProcess.spawn(binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: !windows,
    });
    let stderr = "";
    let settled = false;
    const killGroup = () => {
      try {
        if (!windows && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(new Error(`LibreOffice took longer than ${SOFFICE_TIMEOUT_MS / 1000} s. ${stderr}`));
    }, SOFFICE_TIMEOUT_MS);
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(stderr);
    };
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr = (stderr + text).slice(-2048);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      // A launcher that exits leaves nothing of this run behind.
      if (code !== 0) killGroup();
      finish(code === 0 ? null : new Error(`LibreOffice exited with ${signal ?? code}. ${stderr}`));
    });
  });
}

/** Working folders of conversions a previous server run left behind when it stopped mid-way. */
export async function removeStaleConversions(cache: string) {
  for (const name of await NodeFSP.readdir(cache).catch(() => [])) {
    if (name.startsWith("convert-"))
      await NodeFSP.rm(NodePath.join(cache, name), { recursive: true, force: true });
  }
}

export async function touchCached(filePath: string, millis: number) {
  const now = millis / 1000;
  try {
    const info = await NodeFSP.lstat(filePath);
    if (!info.isFile()) throw new Error("Invalid entry in the render cache.");
    // Only access time drives eviction. PDF range responses use mtime as a validator.
    await NodeFSP.utimes(filePath, now, info.mtimeMs / 1000);
    return true;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

export async function convert(
  binary: string,
  source: string,
  file: OpenMediaFile,
  pdf: string,
  budget: number,
  run: typeof runSoffice,
) {
  if (file.info.size > BigInt(Math.min(budget, OFFICE_RENDER_MAX_SOURCE_BYTES)))
    throw new Error("This file is too large to render.");
  const cache = NodePath.dirname(pdf);
  const temp = await NodeFSP.mkdtemp(NodePath.join(cache, "convert-"));
  try {
    const copy = NodePath.join(temp, "source" + NodePath.extname(source));
    await NodeStreamPromises.pipeline(
      file.handle.createReadStream({ autoClose: false, start: 0 }),
      NodeFS.createWriteStream(copy, { flags: "wx" }),
    );
    const info = await file.handle.stat({ bigint: true });
    if (
      info.mtimeNs !== file.info.mtimeNs ||
      info.size !== file.info.size ||
      info.ctimeNs !== file.info.ctimeNs
    )
      throw new Error("Source changed during conversion.");
    const stderr = await run(binary, [
      `-env:UserInstallation=${NodeURL.pathToFileURL(NodePath.join(cache, "profile")).href}`,
      "--headless",
      "--norestore",
      "--nologo",
      "--convert-to",
      "pdf",
      "--outdir",
      temp,
      copy,
    ]);
    const output = NodePath.join(temp, "source.pdf");
    const size = (await NodeFSP.stat(output).catch(() => null))?.size;
    if (!size) throw new Error("LibreOffice produced no PDF. " + stderr);
    if (size > budget) throw new Error("Rendered PDF exceeds the cache budget.");
    const entries = await Promise.all(
      (await NodeFSP.readdir(cache))
        .filter((name) => /^[0-9a-f]{64}\.pdf$/.test(name))
        .map(async (name) => ({ name, info: await NodeFSP.stat(NodePath.join(cache, name)) })),
    );
    let total = entries.reduce((sum, entry) => sum + entry.info.size, size);
    for (const entry of entries.sort((a, b) => a.info.atimeMs - b.info.atimeMs)) {
      if (total <= budget) break;
      await NodeFSP.unlink(NodePath.join(cache, entry.name));
      total -= entry.info.size;
    }
    await NodeFSP.rename(output, pdf);
  } finally {
    await NodeFSP.rm(temp, { recursive: true, force: true });
  }
  return pdf;
}
