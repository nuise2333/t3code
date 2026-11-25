// ACP proxy for the Qoder app's bundled runtime (launched by bin/qoder), adding the app's catalog,
// context windows, plan mode and access modes. Context window and plan mode are launch flags, so a
// change resumes the session in a fresh runtime before the next prompt.
// Env: QODER_APP, QODER_HOME_DIR (default ~/.qoder-cn), QODER_ACP_LOG.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  catalogFromModels,
  configOptionsFor,
  defaultSelection,
  launchArgs,
  launchContextWindow,
  modelState,
  planningPermission,
  planPermission,
} from "./lib/qoder-acp-config.mjs";

const APP = process.env.QODER_APP || "/Applications/Qoder CN.app";
const RESOURCES = NodePath.join(APP, "Contents/Resources");
const RUNTIME = NodePath.join(
  RESOURCES,
  "app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs",
);
const QUERY_TIMEOUT_MS = 10_000;
const SDK_PROTOCOL = { version: 2, capability: "multi_session_v2" };

function log(...args) {
  if (!process.env.QODER_ACP_LOG) return;
  try {
    NodeFS.appendFileSync(
      process.env.QODER_ACP_LOG,
      `${new Date().toISOString()} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
    );
  } catch {}
}

function readJson(file) {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const product = readJson(NodePath.join(RESOURCES, "product.json"));
const appVersion = readJson(NodePath.join(RESOURCES, "build-manifest.json"))?.productVersion ?? "";
// The account service answers with the app's catalog only for the app's product scope.
const runtimeEnv = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  QODERCN_CLIENT_TYPE: "10",
  QODERCN_BUSINESS_PRODUCT: "app",
  QODERCN_SESSION_TYPE: "app",
  QODERCN_SCENE: "app",
  QODERCN_CLIENT_VERSION: appVersion,
  QODER_BUSINESS_PRODUCT: "app",
  QODER_PRODUCT_ID: product?.productId ?? "qoder-cn",
  ...(process.env.QODER_HOME_DIR
    ? {
        QODER_CONFIG_DIR: process.env.QODER_HOME_DIR,
        QODERCN_CONFIG_DIR: process.env.QODER_HOME_DIR,
      }
    : {}),
};

function readLines(stream, onMessage) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log("non-JSON line", line.slice(0, 200));
        continue;
      }
      onMessage(message);
    }
  });
}

class RpcError extends Error {
  constructor(error) {
    super(error.message);
    this.error = error;
  }
}

function writeClient(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const clientPending = new Map();
let nextClientId = 1;
function requestClient(method, params, runtime) {
  const id = `qoder-${nextClientId++}`;
  return new Promise((resolve, reject) => {
    clientPending.set(id, { resolve, reject, runtime });
    writeClient({ id, method, params });
  });
}

const runtimes = new Set();

/** One `--acp` process of the Qoder runtime. */
class Runtime {
  constructor(args) {
    this.pending = new Map();
    this.nextId = 1;
    this.exited = false;
    this.process = NodeChildProcess.spawn(process.execPath, [RUNTIME, "--acp", ...args], {
      stdio: ["pipe", "pipe", "ignore"],
      env: runtimeEnv,
    });
    runtimes.add(this);
    this.process.stdin.on("error", () => {});
    const onExit = (reason) => {
      if (this.exited) return;
      this.exited = true;
      runtimes.delete(this);
      for (const { reject } of this.pending.values())
        reject(new RpcError({ code: -32603, message: reason }));
      this.pending.clear();
      for (const [id, entry] of clientPending) {
        if (entry.runtime !== this) continue;
        clientPending.delete(id);
        entry.reject(new RpcError({ code: -32603, message: reason }));
        writeClient({ method: "$/cancel_request", params: { requestId: id } });
      }
    };
    this.process.on("error", (error) => onExit(`Qoder runtime failed to start: ${error.message}`));
    this.process.on("exit", (code) => onExit(`Qoder runtime exited (code ${code ?? "signal"}).`));
    readLines(this.process.stdout, (message) => this.receive(message));
  }

  write(message) {
    if (!this.exited)
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(method, params) {
    if (this.exited) {
      return Promise.reject(new RpcError({ code: -32603, message: "Qoder runtime has exited." }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  receive(message) {
    if (message.method === undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new RpcError(message.error));
      else pending?.resolve(message.result);
      return;
    }
    // A runtime being replaced must not speak for its session any more.
    if (this.retired) return;
    if (message.id === undefined) {
      handleRuntimeNotification(this, message);
      return;
    }
    handleRuntimeRequest(this, message).then(
      (result) => this.write({ id: message.id, result }),
      (error) =>
        this.write({
          id: message.id,
          error: error.error ?? { code: -32603, message: String(error.message ?? error) },
        }),
    );
  }

  stop() {
    this.retired = true;
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const force = setTimeout(() => this.process.kill("SIGKILL"), 5_000);
      this.process.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      this.process.kill("SIGTERM");
    });
  }
}

/** One of the app's own account queries, such as the model catalog or credit usage. */
function queryAccount(type, body) {
  return new Promise((resolve, reject) => {
    const daemon = NodeChildProcess.spawn(process.execPath, [RUNTIME, "--sdk"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...runtimeEnv, QODER_AGENT_SDK_DAEMON: "1", QODER_AGENT_SDK_ENTRYPOINT: "sdk-ts" },
    });
    const finish = (settle, value) => {
      clearTimeout(timer);
      daemon.kill("SIGTERM");
      const force = setTimeout(() => daemon.kill("SIGKILL"), 2_000);
      daemon.once("exit", () => clearTimeout(force));
      settle(value);
    };
    // Whatever ends this process, the query's own process goes with it.
    const killWithParent = () => daemon.kill("SIGKILL");
    process.once("exit", killWithParent);
    daemon.once("exit", () => process.off("exit", killWithParent));
    const timer = setTimeout(
      () => finish(reject, new Error("Qoder account query timed out")),
      QUERY_TIMEOUT_MS,
    );
    daemon.on("error", (error) => finish(reject, error));
    daemon.on("exit", () => finish(reject, new Error("Qoder account query exited")));
    daemon.stdin.on("error", () => {});
    const send = (id, request, fields) =>
      daemon.stdin.write(
        `${JSON.stringify({ type: "control_request", request_id: id, request: { type: `daemon.${request}`, ...fields } })}\n`,
      );
    readLines(daemon.stdout, ({ type: kind, response }) => {
      if (kind !== "control_response") return;
      if (response.subtype !== "success") finish(reject, new Error(response.error));
      else if (response.request_id === "init") send("query", type, body);
      else if (response.request_id === "query") finish(resolve, response.response);
    });
    send("init", "initialize", {
      business: { product: "app" },
      daemon_protocol_version: SDK_PROTOCOL.version,
      auth: { type: "qodercli" },
      sdk_version: appVersion,
      capabilities: [SDK_PROTOCOL.capability],
    });
  });
}

/** Model settings saved in the app: hidden models, and chosen context windows and efforts. */
function readAppPreferences() {
  const file = NodePath.join(
    NodeOS.homedir(),
    "Library/Application Support",
    product?.dataDirectoryName ?? "com.qodercn.app.stable",
    "main.sqlite",
  );
  if (!NodeFS.existsSync(file)) return { models: [], providers: [] };
  let database;
  try {
    const { DatabaseSync } = NodeModule.createRequire(import.meta.url)("node:sqlite");
    database = new DatabaseSync(file, { readOnly: true });
    const rows = (sql) => {
      try {
        return database.prepare(sql).all();
      } catch (error) {
        log("app preferences", error.message);
        return [];
      }
    };
    return {
      models: rows(
        "SELECT model_key, visible, context_window, reasoning_effort FROM chat_model_preferences",
      ),
      providers: rows("SELECT profile_id, provider_display_name FROM byok_model_profiles"),
    };
  } catch (error) {
    log("app preferences", error.message);
    return { models: [], providers: [] };
  } finally {
    database?.close();
  }
}

let catalogQuery;
function loadCatalog() {
  catalogQuery ??= queryAccount("get_models", { fetchStrategy: "live" }).then(
    ({ models }) => (models.length === 0 ? null : catalogFromModels(models, readAppPreferences())),
    (error) => {
      log("model catalog", error.message);
      return null;
    },
  );
  return catalogQuery;
}

let initializeParams;
let control;
const sessions = new Map();

async function startRuntime(args) {
  const runtime = new Runtime(args);
  if (initializeParams !== undefined) {
    try {
      runtime.initializeResult = await runtime.request("initialize", initializeParams);
    } catch (error) {
      void runtime.stop();
      throw error;
    }
  }
  return runtime;
}

/** The sign-in and listing process; the first session takes it over. */
function controlRuntime() {
  if (control === undefined || control.runtime?.exited) {
    const entry = { runtime: undefined };
    entry.started = startRuntime([]).then((runtime) => (entry.runtime = runtime));
    entry.started.catch(() => {
      if (control === entry) control = undefined;
    });
    control = entry;
  }
  return control.started;
}

async function runtimeForNewSession() {
  const runtime = await controlRuntime();
  if (runtime.claimed) return startRuntime([]);
  runtime.claimed = true;
  return runtime;
}

function sessionSetup(session, extra = {}) {
  return {
    ...extra,
    models: modelState(session),
    configOptions: configOptionsFor(session),
  };
}

function publishConfig(session) {
  writeClient({
    method: "session/update",
    params: {
      sessionId: session.id,
      update: { sessionUpdate: "config_option_update", configOptions: configOptionsFor(session) },
    },
  });
}

const currentOption = (result, id) =>
  result?.configOptions?.find((option) => option.id === id)?.currentValue;

// One open at a time per session, after the process that had it is gone.
const opening = new Map();
function openSession(method, params) {
  const key = method === "session/load" || method === "session/resume" ? params.sessionId : null;
  if (key === null) return startSession(method, params);
  const opened = (opening.get(key) ?? Promise.resolve()).then(async () => {
    const existing = sessions.get(key);
    if (existing !== undefined) {
      // A prompt owns the session's process, including while it relaunches it.
      if (existing.prompting) {
        throw new RpcError({ code: -32602, message: "This Qoder session is running a prompt." });
      }
      sessions.delete(key);
      if (existing.runtime === control?.runtime) control = undefined;
      await existing.runtime.stop();
    }
    return startSession(method, params);
  });
  const settled = opened.catch(() => {});
  opening.set(key, settled);
  void settled.then(() => {
    if (opening.get(key) === settled) opening.delete(key);
  });
  return opened;
}

async function startSession(method, params) {
  const runtime = await runtimeForNewSession();
  let result;
  let catalog;
  try {
    [result, catalog] = await Promise.all([runtime.request(method, params), loadCatalog()]);
  } catch (error) {
    runtime.claimed = false;
    if (runtime !== control?.runtime) void runtime.stop();
    throw error;
  }
  const id = result.sessionId ?? params.sessionId;
  const session = {
    id,
    runtime,
    catalog,
    cwd: params.cwd,
    mcpServers: params.mcpServers ?? [],
    additionalDirectories: params.additionalDirectories,
    nativeModels: result.models,
    nativeOptions: result.configOptions ?? [],
    selections: new Map(),
    permissionMode: "acceptEdits",
    plan: false,
    launched: {
      model: currentOption(result, "model"),
      effort: currentOption(result, "reasoning_effort"),
      permissionMode: currentOption(result, "mode"),
      plan: false,
    },
  };
  session.model =
    catalog === null || catalog.has(session.launched.model)
      ? session.launched.model
      : [...catalog.keys()][0];
  sessions.set(id, session);
  return sessionSetup(session, { sessionId: id });
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (session === undefined) return;
  sessions.delete(id);
  session.runtime.claimed = false;
  if (session.runtime !== control?.runtime) await session.runtime.stop();
}

function requireSession(id) {
  const session = sessions.get(id);
  if (session === undefined) {
    throw new RpcError({ code: -32602, message: `Unknown Qoder session: ${id}` });
  }
  return session;
}

async function relaunch(session, wanted) {
  log("relaunch", session.id, wanted);
  const previous = session.runtime;
  if (previous === control?.runtime) control = undefined;
  await previous.stop();
  const runtime = await startRuntime(launchArgs(wanted));
  // Until the resume succeeds the session keeps its exited runtime, so the next prompt retries.
  const resumed = runtime.request("session/resume", {
    sessionId: session.id,
    cwd: session.cwd,
    mcpServers: session.mcpServers,
    ...(session.additionalDirectories
      ? { additionalDirectories: session.additionalDirectories }
      : {}),
  });
  let result;
  try {
    result = await resumed;
  } catch (error) {
    void runtime.stop();
    throw error;
  }
  runtime.claimed = true;
  session.runtime = runtime;
  session.launched = {
    ...wanted,
    model: currentOption(result, "model") ?? wanted.model,
    effort: currentOption(result, "reasoning_effort"),
    permissionMode: currentOption(result, "mode"),
  };
}

/** Bring the session's runtime to the selected model, effort, context window and modes. */
async function applySelections(session) {
  const selected = {
    ...defaultSelection(session, session.model),
    ...session.selections.get(session.model),
  };
  const wanted = {
    ...selected,
    contextWindow: launchContextWindow(session, session.model, selected.contextWindow),
    model: session.model,
    plan: session.plan,
  };
  const launched = session.launched;
  if (
    session.runtime.exited ||
    wanted.plan !== launched.plan ||
    wanted.contextWindow !== launched.contextWindow ||
    // A context window given at launch does not follow a live model switch.
    (wanted.model !== launched.model && launched.contextWindow !== undefined)
  ) {
    await relaunch(session, wanted);
  }
  const set = (configId, value) =>
    session.runtime.request("session/set_config_option", {
      sessionId: session.id,
      configId,
      value,
    });
  if (session.launched.model !== wanted.model) {
    const result = await set("model", wanted.model);
    session.launched.model = wanted.model;
    session.launched.effort = currentOption(result, "reasoning_effort");
  }
  if (wanted.effort !== undefined && session.launched.effort !== wanted.effort) {
    await set("reasoning_effort", wanted.effort);
    session.launched.effort = wanted.effort;
  }
  await applyPermissionMode(session);
}

// Setting a mode ends plan mode in the runtime, so it waits for the plan to be approved. Changes run
// one after another, so the last choice is the one in force however the answers interleave.
function applyPermissionMode(session) {
  const applied = (session.modeChange ?? Promise.resolve()).then(async () => {
    const mode = session.permissionMode;
    if (session.launched.plan || session.launched.permissionMode === mode) return;
    session.launched.permissionMode = undefined;
    await session.runtime.request("session/set_mode", { sessionId: session.id, modeId: mode });
    session.launched.permissionMode = mode;
  });
  session.modeChange = applied.catch(() => {});
  return applied;
}

async function setConfigOption({ sessionId, configId, value }) {
  const session = requireSession(sessionId);
  const option = configOptionsFor(session).find((candidate) => candidate.id === configId);
  if (option === undefined || !option.options.some((choice) => choice.value === value)) {
    throw new RpcError({ code: -32602, message: `Invalid value for ${configId}: ${value}` });
  }
  if (configId === "model") session.model = value;
  else if (configId === "plan_mode") session.plan = value === "plan";
  else if (configId === "permission_mode") {
    session.permissionMode = value;
    if (session.prompting) await applyPermissionMode(session);
  } else {
    session.selections.set(session.model, {
      ...session.selections.get(session.model),
      ...(configId === "context_window" ? { contextWindow: Number(value) } : { effort: value }),
    });
  }
  return { configOptions: configOptionsFor(session) };
}

async function prompt(params) {
  const session = requireSession(params.sessionId);
  const cancels = session.cancels ?? 0;
  // Prompts can queue; only the first one finds an idle runtime to reconfigure.
  if (!session.prompting) {
    session.applying = applySelections(session);
  }
  session.prompting = (session.prompting ?? 0) + 1;
  try {
    await session.applying;
    if ((session.cancels ?? 0) !== cancels) return { stopReason: "cancelled" };
    return await session.runtime.request("session/prompt", params);
  } finally {
    session.prompting -= 1;
  }
}

async function handleClientRequest({ method, params = {} }) {
  switch (method) {
    case "initialize": {
      initializeParams = params;
      void loadCatalog();
      return (await controlRuntime()).initializeResult;
    }
    case "session/new":
    case "session/load":
    case "session/resume":
    case "session/fork":
      return openSession(method, params);
    case "session/set_config_option":
      return setConfigOption(params);
    case "session/set_mode":
      await setConfigOption({
        sessionId: params.sessionId,
        configId: "permission_mode",
        value: params.modeId,
      });
      return {};
    case "session/set_model":
      await setConfigOption({
        sessionId: params.sessionId,
        configId: "model",
        value: params.modelId,
      });
      return {};
    case "session/prompt":
      return prompt(params);
    case "session/close":
    case "session/delete": {
      const runtime = sessions.get(params.sessionId)?.runtime ?? (await controlRuntime());
      const result = await runtime.request(method, params);
      await closeSession(params.sessionId);
      return result;
    }
    case "authenticate": {
      const result = await (await controlRuntime()).request(method, params);
      catalogQuery = undefined;
      return result;
    }
    default: {
      const runtime = sessions.get(params.sessionId)?.runtime ?? (await controlRuntime());
      return runtime.request(method, params);
    }
  }
}

function handleClientNotification({ method, params = {} }) {
  const session = sessions.get(params.sessionId);
  if (method === "session/cancel" && session !== undefined)
    session.cancels = (session.cancels ?? 0) + 1;
  (session?.runtime ?? control?.runtime)?.write({ method, params });
}

const sessionFor = (runtime, id) => {
  const session = sessions.get(id);
  return session?.runtime === runtime ? session : undefined;
};

function handleRuntimeNotification(runtime, { method, params }) {
  const session = sessionFor(runtime, params?.sessionId);
  const update = params?.update;
  // The proxy owns both; the runtime's versions lack the app's options.
  if (update?.sessionUpdate === "config_option_update") return;
  if (update?.sessionUpdate === "current_mode_update") return;
  writeClient({ method, params });
  if (session === undefined || update === undefined) return;
  if (update.sessionUpdate === "tool_call") {
    const name = update._meta?.qoder?.toolName;
    if (name === "EnterPlanMode" || name === "ExitPlanMode") {
      session.planTool = { id: update.toolCallId, plan: name === "EnterPlanMode" };
    }
  } else if (
    update.sessionUpdate === "tool_call_update" &&
    update.toolCallId === session.planTool?.id &&
    (update.status === "completed" || update.status === "failed")
  ) {
    const { plan } = session.planTool;
    session.planTool = undefined;
    if (update.status === "failed") return;
    session.plan = plan;
    session.launched.plan = plan;
    if (!plan) {
      session.launched.permissionMode = undefined;
      applyPermissionMode(session).catch((error) => log("set mode", error.message));
    }
    publishConfig(session);
  }
}

async function handleRuntimeRequest(runtime, { method, params }) {
  const session = sessionFor(runtime, params?.sessionId);
  const isPlanExit =
    method === "session/request_permission" &&
    params.toolCall?._meta?.qoder?.toolName === "ExitPlanMode";
  if (session === undefined) return requestClient(method, params, runtime);
  if (!isPlanExit) {
    if (method !== "session/request_permission" || !session.launched.plan) {
      return requestClient(method, params, runtime);
    }
    // While planning, an edit is refused and nothing else is approved without the user.
    const guarded = planningPermission(params);
    return guarded.outcome ?? requestClient(method, guarded.request, runtime);
  }
  const { request, plan } = planPermission(params, session.permissionMode);
  if (plan !== undefined) {
    writeClient({
      method: "session/update",
      params: {
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `\n\n${plan}\n\n` },
        },
      },
    });
  }
  return requestClient(method, request, runtime);
}

function serve() {
  readLines(process.stdin, (message) => {
    if (message.method === undefined) {
      const pending = clientPending.get(message.id);
      clientPending.delete(message.id);
      if (message.error) pending?.reject(new RpcError(message.error));
      else pending?.resolve(message.result);
      return;
    }
    if (message.id === undefined) {
      handleClientNotification(message);
      return;
    }
    handleClientRequest(message).then(
      (result) => writeClient({ id: message.id, result: result ?? {} }),
      (error) =>
        writeClient({
          id: message.id,
          error: error.error ?? { code: -32603, message: String(error.message ?? error) },
        }),
    );
  });

  async function shutdown() {
    await Promise.all([...runtimes].map((runtime) => runtime.stop()));
    process.exit(0);
  }
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log("started", APP);
}

// `qoder [args] --t3-qoder-usage` prints the account's credit usage for T3's limits and exits.
if (process.argv.at(-1) === "--t3-qoder-usage") {
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  queryAccount("get_usage_info", {}).then(
    ({ usage }) => process.stdout.write(`${JSON.stringify(usage)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
} else serve();
