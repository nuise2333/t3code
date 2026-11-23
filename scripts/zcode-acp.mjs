// Bridges ACP on stdio to ZCode's private `zcode app-server` protocol (launched by bin/zcode).
// Models: ZCODE_ACP_API_KEY + ZCODE_ACP_TEMPLATE (default bigmodel-api) write a provider config;
// otherwise ZCODE_PERSONAL_PROVIDER_CONFIG_FILE or ZCode's own provider_config.json is used.
// Also: ZCODE_APP, ZCODE_ACP_BASE_URL, ZCODE_ACP_MODELS, ZCODE_ACP_DEFAULT_MODE, ZCODE_ACP_LOG.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const VERSION = "0.1.0";
const APP = process.env.ZCODE_APP || "/Applications/ZCode.app";
const ZCODE_BIN = NodePath.join(APP, "Contents/MacOS/ZCode");
const ZCODE_CLI = NodePath.join(APP, "Contents/Resources/glm/zcode.cjs");
const BUILTIN_CONFIG = NodePath.join(APP, "Contents/Resources/config/provider/zcode-builtin.json");
const MODES = [
  { id: "build", name: "Build", description: "Ask before side effects" },
  { id: "plan", name: "Plan", description: "Read-only planning" },
  { id: "edit", name: "Edit", description: "Auto-approve file edits" },
  { id: "guarded", name: "Guarded", description: "Auto-approve low-risk actions" },
  { id: "auto", name: "Auto", description: "ZCode decides" },
  { id: "yolo", name: "Yolo", description: "Approve everything" },
];
const DEFAULT_MODE = process.env.ZCODE_ACP_DEFAULT_MODE || "build";

const logFile = process.env.ZCODE_ACP_LOG;
const log = (...args) => {
  if (!logFile) return;
  try {
    NodeFS.appendFileSync(
      logFile,
      `${new Date().toISOString()} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
    );
  } catch {}
};

let tempConfigFile = null;
function resolvePersonalConfig() {
  const apiKey = process.env.ZCODE_ACP_API_KEY?.trim();
  if (!apiKey) {
    return (
      process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
      NodePath.join(NodeOS.homedir(), ".zcode/v2/provider_config.json")
    );
  }
  const templateId = process.env.ZCODE_ACP_TEMPLATE?.trim() || "bigmodel-api";
  const builtin = JSON.parse(NodeFS.readFileSync(BUILTIN_CONFIG, "utf8"));
  const template = builtin.config.providerConfigRules.templateRules.find(
    (t) => t.templateId === templateId,
  );
  if (!template) throw new Error(`Unknown ZCode provider template: ${templateId}`);
  const models =
    process.env.ZCODE_ACP_MODELS?.split(",")
      .map((m) => m.trim())
      .filter(Boolean) ??
    template.config.builtinModelIds ??
    [];
  const config = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: `t3-${templateId}`,
            templateId,
            providerName: template.templateNameMap?.["en-US"] ?? templateId,
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: template.config.access.type, apiKey },
              api: {
                type: template.config.api.type,
                baseUrl: process.env.ZCODE_ACP_BASE_URL?.trim() || template.config.api.baseUrl,
              },
              personalModelIds: models,
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
  tempConfigFile = NodePath.join(
    NodeOS.tmpdir(),
    `zcode-acp-${process.pid}-${NodeCrypto.randomUUID()}.json`,
  );
  NodeFS.writeFileSync(tempConfigFile, JSON.stringify(config), { mode: 0o600 });
  return tempConfigFile;
}

function lineReader(stream, onMessage) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log("bad json", line.slice(0, 200));
        continue;
      }
      onMessage(msg);
    }
  });
}

// ACP side (stdout/stdin)
const acpPending = new Map();
let acpNextId = 1;
const acpWrite = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const acpNotify = (method, params) => acpWrite({ method, params });
const acpRequest = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `zc-${acpNextId++}`;
    acpPending.set(id, { resolve, reject });
    acpWrite({ id, method, params });
  });
const sessionUpdate = (sessionId, update) => acpNotify("session/update", { sessionId, update });

// ZCode side (child process)
let zc = null;
const zcPending = new Map();
let zcNextId = 1;
let zcExited = null;
function startZcode() {
  if (zc) return;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:
      process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || BUILTIN_CONFIG,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: resolvePersonalConfig(),
  };
  delete env.ZCODE_ACP_API_KEY;
  zc = NodeChildProcess.spawn(ZCODE_BIN, [ZCODE_CLI, "app-server", "--surface", "desktop"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  zc.stderr.setEncoding("utf8");
  zc.stderr.on("data", (d) => log("zcode stderr", d.slice(0, 2000)));
  zc.on("exit", (code, signal) => {
    zcExited = `zcode app-server exited (${code ?? signal})`;
    log(zcExited);
    for (const { reject } of zcPending.values()) reject(new Error(zcExited));
    zcPending.clear();
    for (const s of sessions.values()) s.turn?.reject(new Error(zcExited));
  });
  lineReader(zc.stdout, onZcodeMessage);
}
const zcWrite = (msg) => {
  if (!zc || zcExited) throw new Error(zcExited ?? "zcode not started");
  zc.stdin.write(`${JSON.stringify(msg)}\n`);
};
function zcRequest(method, params) {
  startZcode();
  return new Promise((resolve, reject) => {
    const id = zcNextId++;
    zcPending.set(id, { resolve, reject, method });
    log("zc >>", method);
    zcWrite({ id, method, params });
  });
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const sessions = new Map(); // sessionId -> { cwd, settings, tools: Map, turn, cancelRequested }

function workspaceFor(cwd) {
  return { workspacePath: cwd, workspaceKey: cwd };
}

const MODEL_SEP = "::";
const modelValue = (ref) => `${ref.providerId}${MODEL_SEP}${ref.modelId}`;
function parseModelValue(value) {
  const i = value.indexOf(MODEL_SEP);
  if (i < 0) return null;
  return { providerId: value.slice(0, i), modelId: value.slice(i + MODEL_SEP.length) };
}

function configOptions(session) {
  const settings = session.settings ?? {};
  const available = settings.model?.available ?? [];
  const current = settings.model?.current;
  const options = [];
  if (available.length > 0) {
    options.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current ? modelValue(current) : modelValue(available[0].ref),
      options: available.map((m) => ({
        value: modelValue(m.ref),
        name: m.label ?? m.ref.modelId,
        ...(m.providerLabel ? { description: m.providerLabel } : {}),
      })),
    });
  }
  const levels = settings.thoughtLevel?.enabled ? (settings.thoughtLevel.available ?? []) : [];
  if (levels.length > 0) {
    options.push({
      id: "thought_level",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: settings.thoughtLevel.current ?? levels[0].value,
      options: levels.map((l) => ({ value: l.value, name: l.label ?? l.value })),
    });
  }
  options.push({
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: settings.mode?.current ?? DEFAULT_MODE,
    options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })),
  });
  return options;
}

function modesState(session) {
  return {
    currentModeId: session.settings?.mode?.current ?? DEFAULT_MODE,
    availableModes: MODES,
  };
}

async function refreshSettings(session) {
  const read = await zcRequest("session/read", { sessionId: session.id });
  session.settings = read.settings ?? session.settings;
}

function currentModelSelection(session) {
  const current = session.settings?.model?.current;
  if (!current) return undefined;
  const level = session.settings?.thoughtLevel?.enabled
    ? session.settings.thoughtLevel.current
    : undefined;
  return {
    providerId: current.providerId,
    modelId: current.modelId,
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}

function toZcodeMcpServers(servers) {
  return (servers ?? []).flatMap((s) => {
    if (s.type === "http" || s.type === "sse") {
      return [
        {
          name: s.name,
          type: s.type,
          url: s.url,
          headers: (s.headers ?? []).map((h) => ({ name: h.name, value: h.value })),
        },
      ];
    }
    if (s.command) {
      return [
        {
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: (s.env ?? []).map((e) => ({ name: e.name, value: e.value })),
        },
      ];
    }
    return [];
  });
}

function toolKind(name) {
  const n = name.toLowerCase();
  if (n === "read" || n === "notebookread") return "read";
  if (["write", "edit", "multiedit", "notebookedit", "applypatch", "apply_patch"].includes(n))
    return "edit";
  if (n === "bash" || n === "shell" || n.includes("terminal")) return "execute";
  if (["grep", "glob", "ls", "search", "toolsearch"].includes(n)) return "search";
  if (n === "webfetch" || n === "websearch") return "fetch";
  if (n === "todowrite" || n === "todoread") return "think";
  return "other";
}

function toolTitle(name, input) {
  if (!input || typeof input !== "object") return name;
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (name === "Bash")
    return input.description || `\`${String(input.command ?? "").slice(0, 120)}\``;
  if (file) return `${name} ${file}`;
  if (input.pattern) return `${name} ${input.pattern}`;
  if (input.url) return `${name} ${input.url}`;
  if (input.query) return `${name} ${input.query}`;
  if (input.description) return `${name}: ${input.description}`;
  return name;
}

function toolLocations(input) {
  const file = input?.file_path ?? input?.path ?? input?.notebook_path;
  return typeof file === "string" && file.startsWith("/") ? [{ path: file }] : undefined;
}

function toolDiffContent(name, input) {
  if (!input || typeof input.file_path !== "string") return undefined;
  if (name === "Write" && typeof input.content === "string") {
    return [{ type: "diff", path: input.file_path, oldText: null, newText: input.content }];
  }
  if (name === "Edit" && typeof input.new_string === "string") {
    return [
      {
        type: "diff",
        path: input.file_path,
        oldText: input.old_string ?? "",
        newText: input.new_string,
      },
    ];
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.map((e) => ({
      type: "diff",
      path: input.file_path,
      oldText: e.old_string ?? "",
      newText: e.new_string ?? "",
    }));
  }
  return undefined;
}

function planFromTodos(input) {
  const todos = Array.isArray(input?.todos) ? input.todos : null;
  if (!todos) return null;
  return todos.map((t) => ({
    content: String(t.content ?? t.title ?? t.activeForm ?? ""),
    priority: t.priority === "high" || t.priority === "low" ? t.priority : "medium",
    status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
  }));
}

function resultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    return result.content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("\n");
  }
  if (typeof result.error === "string") return result.error;
  if (typeof result.error?.message === "string") return result.error.message;
  return JSON.stringify(result).slice(0, 4000);
}

function onSessionEvent(params) {
  const session = sessions.get(params.sessionId);
  if (!session) return;
  const p = params.payload ?? {};
  const sid = session.id;
  switch (params.type) {
    case "model.streaming": {
      if (p.kind === "text_delta" && p.delta) {
        sessionUpdate(sid, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: p.delta },
        });
      } else if (p.kind === "reasoning_delta" && p.delta) {
        sessionUpdate(sid, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: p.delta },
        });
      } else if (p.kind === "tool_input_start" && p.toolCallId) {
        if (!session.tools.has(p.toolCallId)) {
          session.tools.set(p.toolCallId, { name: p.toolName, input: undefined });
          sessionUpdate(sid, {
            sessionUpdate: "tool_call",
            toolCallId: p.toolCallId,
            title: p.toolName ?? "Tool",
            kind: toolKind(p.toolName ?? ""),
            status: "pending",
          });
        }
      } else if (p.kind === "tool_call" && p.toolCallId) {
        const known = session.tools.get(p.toolCallId);
        const name = p.toolName ?? known?.name ?? "Tool";
        session.tools.set(p.toolCallId, { name, input: p.input });
        const update = {
          toolCallId: p.toolCallId,
          title: toolTitle(name, p.input),
          kind: toolKind(name),
          status: "pending",
          rawInput: p.input,
          ...(toolLocations(p.input) ? { locations: toolLocations(p.input) } : {}),
          ...(toolDiffContent(name, p.input) ? { content: toolDiffContent(name, p.input) } : {}),
        };
        sessionUpdate(
          sid,
          known
            ? { sessionUpdate: "tool_call_update", ...update }
            : { sessionUpdate: "tool_call", ...update },
        );
        if (name === "TodoWrite") {
          const entries = planFromTodos(p.input);
          if (entries) sessionUpdate(sid, { sessionUpdate: "plan", entries });
        }
      }
      break;
    }
    case "tool.updated": {
      if (!p.toolCallId) break;
      const known = session.tools.get(p.toolCallId);
      if (p.kind === "started") {
        sessionUpdate(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: p.toolCallId,
          status: "in_progress",
        });
      } else if (
        p.kind === "result" ||
        p.kind === "completed" ||
        p.kind === "failed" ||
        p.kind === "error"
      ) {
        const failed = p.kind === "failed" || p.kind === "error" || p.result?.success === false;
        const text = resultText(p.result ?? p.error);
        const diff = known ? toolDiffContent(known.name, known.input) : undefined;
        sessionUpdate(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: p.toolCallId,
          status: failed ? "failed" : "completed",
          rawOutput: { output: text, success: !failed },
          content: [
            ...(diff ?? []),
            ...(text ? [{ type: "content", content: { type: "text", text } }] : []),
          ],
        });
      }
      break;
    }
    case "session.updated": {
      if (p.modelSelection || p.supportedThoughtLevels) {
        // Model or reasoning changed natively; resync on next turn boundary.
        session.settingsDirty = true;
      }
      break;
    }
    case "turn.completed": {
      const cancelled =
        session.cancelRequested || p.resultType === "cancelled" || p.resultType === "aborted";
      session.turn?.resolve({ stopReason: cancelled ? "cancelled" : "end_turn" });
      break;
    }
    case "turn.failed": {
      if (session.cancelRequested) {
        session.turn?.resolve({ stopReason: "cancelled" });
      } else {
        const base = p.error?.message || "ZCode turn failed";
        const underlying = p.error?.underlyingErrorMessage;
        const message = underlying && underlying !== base ? `${base} ${underlying}` : base;
        session.turn?.reject(new RpcError(-32603, message, { code: p.error?.code }));
      }
      break;
    }
    default:
      break;
  }
}

function onZcodeMessage(msg) {
  if (msg.id !== undefined && msg.method === undefined) {
    const pending = zcPending.get(msg.id);
    if (!pending) return;
    zcPending.delete(msg.id);
    if (msg.error) {
      log("zc error", pending.method, msg.error.message);
      pending.reject(
        new RpcError(msg.error.code ?? -32603, msg.error.message ?? "ZCode error", msg.error.data),
      );
    } else pending.resolve(msg.result);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    handleZcodeRequest(msg).then(
      (result) => zcWrite({ id: msg.id, result }),
      (error) =>
        zcWrite({
          id: msg.id,
          error: { code: error.code ?? -32603, message: error.message ?? String(error) },
        }),
    );
    return;
  }
  if (msg.method === "session/event") onSessionEvent(msg.params);
}

async function handleZcodeRequest(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "session/requestRuntimePreferences":
      return { nativeSearchEnhancementsEnabled: false };
    case "session/readReplyLanguage":
      return { language: null };
    case "interaction/requestPermission":
      return requestPermission(p);
    case "interaction/requestUserInput":
      return {
        action: "decline",
        reason:
          "Interactive questions are not supported over ACP; continue with your best judgment.",
      };
    default:
      log("unhandled zcode request", msg.method);
      throw new RpcError(-32601, `T3 bridge does not handle ${msg.method}`);
  }
}

async function requestPermission(p) {
  const session = sessions.get(p.sessionId);
  const deny =
    p.options.find((o) => o.response?.decision === "deny") ?? p.options[p.options.length - 1];
  if (!session) return deny.response;
  const known = session.tools.get(p.toolCallId);
  const name = p.toolName ?? known?.name ?? "Tool";
  const input = p.input ?? known?.input;
  const acpOptions = p.options.map((o) => ({
    optionId: o.optionId,
    name: o.name,
    kind:
      o.kind === "allow_always"
        ? "allow_always"
        : o.kind === "allow_once"
          ? "allow_once"
          : o.kind === "deny_always" || o.kind === "reject_always"
            ? "reject_always"
            : o.response?.decision === "deny"
              ? "reject_once"
              : "allow_once",
  }));
  try {
    const result = await acpRequest("session/request_permission", {
      sessionId: session.id,
      toolCall: {
        toolCallId: p.toolCallId,
        title: toolTitle(name, input),
        kind: toolKind(name),
        status: "pending",
        rawInput: input,
        ...(toolLocations(input) ? { locations: toolLocations(input) } : {}),
        ...(toolDiffContent(name, input) ? { content: toolDiffContent(name, input) } : {}),
      },
      options: acpOptions,
    });
    if (result?.outcome?.outcome === "selected") {
      const chosen = p.options.find((o) => o.optionId === result.outcome.optionId);
      if (chosen) return chosen.response;
    }
    return deny.response;
  } catch (error) {
    log("permission request failed", error.message);
    return deny.response;
  }
}

async function openSession(sessionId, cwd, mcpServers, resume) {
  const session = {
    id: sessionId,
    cwd,
    settings: null,
    tools: new Map(),
    turn: null,
    cancelRequested: false,
  };
  sessions.set(sessionId, session);
  const servers = toZcodeMcpServers(mcpServers);
  try {
    if (resume) {
      await zcRequest("session/resume", {
        sessionId,
        workspace: workspaceFor(cwd),
        ...(servers.length ? { mcpServers: servers } : {}),
      });
    } else {
      await zcRequest("session/create", {
        sessionId,
        workspace: workspaceFor(cwd),
        mode: DEFAULT_MODE,
        // Persisted on first send, so T3's status probes leave no empty ZCode sessions.
        persistence: "deferred",
        titleGenerationEnabled: false,
        ...(servers.length ? { mcpServers: servers } : {}),
      });
    }
    await zcRequest("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" });
    await refreshSettings(session);
  } catch (error) {
    sessions.delete(sessionId);
    throw error;
  }
  return { sessionId, configOptions: configOptions(session), modes: modesState(session) };
}

function requireSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new RpcError(-32602, `Unknown session ${sessionId}`);
  return session;
}

function promptText(blocks) {
  const parts = [];
  for (const b of blocks ?? []) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link")
      parts.push(`@${b.uri?.startsWith("file://") ? decodeURIComponent(b.uri.slice(7)) : b.uri}`);
    else if (b.type === "resource" && b.resource) {
      const uri = b.resource.uri ?? "";
      if (typeof b.resource.text === "string")
        parts.push(`<context uri="${uri}">\n${b.resource.text}\n</context>`);
      else parts.push(`@${uri}`);
    }
  }
  return parts.join("\n\n");
}

async function prompt(params) {
  const session = requireSession(params.sessionId);
  if (session.turn) throw new RpcError(-32010, "A prompt is already running for this session");
  if (session.settingsDirty) {
    session.settingsDirty = false;
    await refreshSettings(session).catch(() => {});
  }
  session.cancelRequested = false;
  session.tools.clear();
  const done = new Promise((resolve, reject) => {
    session.turn = { resolve, reject };
  });
  try {
    const modelSelection = currentModelSelection(session);
    if (!modelSelection) {
      throw new RpcError(
        -32603,
        "ZCode has no model configured. Set ZCODE_ACP_API_KEY (and ZCODE_ACP_TEMPLATE) on this provider, or add an API-key provider in ZCode settings.",
      );
    }
    await zcRequest("session/send", {
      sessionId: session.id,
      modelSelection,
      content: promptText(params.prompt),
    });
    return await done;
  } finally {
    session.turn = null;
  }
}

async function setConfigOption(params) {
  const session = requireSession(params.sessionId);
  const value = String(params.value);
  if (params.configId === "model") {
    const ref = parseModelValue(value);
    if (!ref) throw new RpcError(-32602, `Invalid model value ${value}`);
    await zcRequest("session/setModel", { sessionId: session.id, model: ref });
  } else if (params.configId === "thought_level") {
    await zcRequest("session/setThoughtLevel", { sessionId: session.id, thoughtLevel: value });
  } else if (params.configId === "mode") {
    await zcRequest("session/setMode", { sessionId: session.id, mode: value });
  } else {
    throw new RpcError(-32602, `Unknown config option ${params.configId}`);
  }
  await refreshSettings(session);
  return { configOptions: configOptions(session) };
}

async function handleAcpRequest(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
        },
        agentInfo: { name: "zcode-acp", title: "ZCode", version: VERSION },
        authMethods: [],
      };
    case "authenticate":
      return {};
    case "session/new":
      return openSession(
        `sess_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        p.cwd,
        p.mcpServers,
        false,
      );
    case "session/load": {
      const result = await openSession(p.sessionId, p.cwd, p.mcpServers, true);
      const { sessionId: _sessionId, ...rest } = result;
      return rest;
    }
    case "session/prompt":
      return prompt(p);
    case "session/set_config_option":
      return setConfigOption(p);
    case "session/set_mode":
      await setConfigOption({ sessionId: p.sessionId, configId: "mode", value: p.modeId });
      return {};
    case "session/set_model":
      await setConfigOption({ sessionId: p.sessionId, configId: "model", value: p.modelId });
      return {};
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

async function handleAcpNotification(msg) {
  if (msg.method === "session/cancel") {
    const session = sessions.get(msg.params?.sessionId);
    if (!session) return;
    session.cancelRequested = true;
    await zcRequest("session/stop", { sessionId: session.id }).catch((e) =>
      log("stop failed", e.message),
    );
  }
}

lineReader(process.stdin, (msg) => {
  if (msg.id !== undefined && msg.method === undefined) {
    const pending = acpPending.get(msg.id);
    if (!pending) return;
    acpPending.delete(msg.id);
    if (msg.error) pending.reject(new RpcError(msg.error.code, msg.error.message));
    else pending.resolve(msg.result);
    return;
  }
  log("acp <<", msg.method);
  if (msg.id === undefined) {
    handleAcpNotification(msg).catch((e) => log("notification failed", e.message));
    return;
  }
  handleAcpRequest(msg).then(
    (result) => acpWrite({ id: msg.id, result: result ?? {} }),
    (error) => {
      log("acp error", msg.method, error.message);
      acpWrite({
        id: msg.id,
        error: {
          code: typeof error.code === "number" ? error.code : -32603,
          message: error.message ?? String(error),
          ...(error.data ? { data: error.data } : {}),
        },
      });
    },
  );
});

function shutdown() {
  try {
    zc?.kill();
  } catch {}
  if (tempConfigFile) NodeFS.rmSync(tempConfigFile, { force: true });
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
