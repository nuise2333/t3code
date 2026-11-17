#!/usr/bin/env node
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(
    "T3 DeepSeek Harness ACP preset bridge\nUsage: node scripts/dsh-acp.mjs [dsh launcher options]\nRequires installed @deepseek-ai/dsh 0.2.2-rc.1.\n",
  );
  process.exit(0);
}
let executable;
for (const directory of (process.env.PATH ?? "").split(NodePath.delimiter)) {
  try {
    executable = await NodeFSP.realpath(NodePath.join(directory, "dsh"));
    break;
  } catch {}
}
if (!executable) throw new Error("DeepSeek Harness is not installed on PATH.");
let root = NodePath.dirname(executable);
while (root !== NodePath.dirname(root)) {
  try {
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "package.json"), "utf8"),
    );
    if (manifest.name === "@deepseek-ai/dsh") break;
  } catch {}
  root = NodePath.dirname(root);
}
const runtimeAnchor = NodePath.join(root, "package.json");
const require = NodeModule.createRequire(runtimeAnchor);
const bridgeManifest = JSON.parse(
  await NodeFSP.readFile(require.resolve("@deepseek-ai/dsh-acp/package.json"), "utf8"),
);
if (bridgeManifest.version !== "0.2.2-rc.1")
  throw new Error(`Unsupported DSH ACP version: ${bridgeManifest.version}. Expected 0.2.2-rc.1.`);
const webRoot = NodePath.dirname(require.resolve("@deepseek-ai/dsh-web-app/package.json"));
const webPatch = await NodeFSP.readFile(NodePath.join(webRoot, "cordis.patch.yml"), "utf8");
const marker = "- id: tool-plugin-manager\n";
if (!webPatch.includes(marker))
  throw new Error("Installed DSH preset composition is incompatible.");
const presetPlane = webPatch.slice(webPatch.indexOf(marker));
const presets = await Promise.all(
  ["standard", "ptc", "minimal", "cordis"].map((id) =>
    NodeFSP.readFile(NodePath.join(webRoot, "presets", `${id}.patch.yml`), "utf8"),
  ),
);
const stackRoot = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "dsh-stack",
);
presets.push(
  (await NodeFSP.readFile(NodePath.join(stackRoot, "preset.patch.yml"), "utf8")).replaceAll(
    "__T3_DSH_SKILLS_DIR__",
    JSON.stringify(NodePath.join(stackRoot, "skills")),
  ),
);
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dsh-acp-"));
try {
  const pluginPath = NodeURL.fileURLToPath(new URL("./lib/dsh-acp-presets.mjs", import.meta.url));
  const patch = NodePath.join(temporary, "presets.patch.yml");
  await NodeFSP.writeFile(
    patch,
    [
      presetPlane,
      ...presets,
      `\n- insert:\n    - id: subagent-model-selection-settings\n      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'\n    - id: schedule\n      name: '@deepseek-ai/dsh-schedule'\n    - id: cordis-host-runner\n      name: '@deepseek-ai/dsh-cordis-host-runner'\n    - id: cordis-inspect-providers\n      name: '@deepseek-ai/dsh-tool-cordis/host'\n- id: acp\n  disabled: true\n- insert:\n    - id: t3-acp\n      name: ${JSON.stringify(pluginPath)}\n      inject: [acpAppStartup, agentPresets, sessionQuery, loader]\n      config:\n        runtimeAnchor: ${JSON.stringify(runtimeAnchor)}\n`,
    ].join("\n"),
  );
  const child = NodeChildProcess.spawn(
    executable,
    ["--profile", "acp", ...args, "--patch", patch],
    {
      stdio: "inherit",
    },
  );
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
} finally {
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}
