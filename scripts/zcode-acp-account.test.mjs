import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const BRIDGE = NodePath.join(import.meta.dirname, "zcode-acp.mjs");
const ACCOUNT = "account:bigmodel-individual-coding-plan::GLM-5.4";
const API = "t3-bigmodel-api::GLM-5.4";

// Stands in for ZCode's binary: argv is [zcode.cjs, "app-server" | "--prompt=…", …].
const FAKE_ZCODE = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[1] === "app-server") {
  const settings = { mode: { current: "build" }, model: { current: { providerId: "t3-bigmodel-api", modelId: "GLM-5.4" } } };
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === "session/setMode") settings.mode.current = params.mode;
    const reply = () => out({ id, result: method === "session/read" ? { settings } : {} });
    if (method === "session/setModel" || method === "session/setMode") setTimeout(reply, 200);
    else reply();
  });
} else {
  const text = args[1].slice("--prompt=".length);
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: args.slice(1), key: process.env.ZCODE_ACP_API_KEY ?? null }) + "\\n");
  const run = () => {
    out({ type: "model.streaming", sessionId: "cli_1", payload: { kind: "text_delta", delta: "hi" } });
    if (text === "fail") {
      out({ type: "turn.failed", sessionId: "cli_1", payload: { error: { message: "boom" } } });
      out({ type: "result", sessionId: "sub_1" });
    } else if (text === "subagent only") {
      out({ type: "result", sessionId: "sub_1" });
    } else {
      out({ type: "turn.completed", sessionId: "cli_1", payload: {} });
      out({ type: "result", sessionId: "cli_1" });
    }
  };
  if (text === "slow") setTimeout(run, 400);
  else if (text === "hang") {
    out({ type: "model.streaming", sessionId: "cli_1", payload: { kind: "text_delta", delta: "hi" } });
    setTimeout(() => {}, 60000);
  }
  else run();
}
`;

const builtin = {
  revision: 1e9,
  config: {
    providerConfigRules: {
      templateRules: [
        {
          templateId: "bigmodel-api",
          config: {
            access: { type: "zhipu-coding-plan-api-key" },
            api: { type: "anthropic-messages", baseUrl: "https://example.invalid" },
            builtinModelIds: ["GLM-5.4"],
          },
        },
      ],
      providerRules: [
        {
          providerId: "account:bigmodel-individual-coding-plan",
          config: { api: { type: "anthropic-messages" }, builtinModelIds: ["GLM-5.4"] },
        },
      ],
    },
    modelConfigRules: {
      templateModelRules: [],
      builtinProviderModelRules: [],
      modelRules: [],
      modelApiRules: [],
    },
  },
};

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup({ signedIn = true } = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zcode-acp-test-"));
  cleanups.push(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const account = NodePath.join(root, "account");
  const bin = NodePath.join(root, "app/Contents/MacOS");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(account, ".zcode/v2"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(bin, "ZCode"), FAKE_ZCODE, { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(root, "builtin.json"), JSON.stringify(builtin));
  NodeFS.writeFileSync(NodePath.join(account, "credential-secret"), "x".repeat(32));
  const entry = "account-provider:account:bigmodel-individual-coding-plan:identity";
  NodeFS.writeFileSync(
    NodePath.join(account, ".zcode/v2/credentials.json"),
    JSON.stringify(signedIn ? { [entry]: "enc" } : {}),
  );
  const log = NodePath.join(root, "log");
  NodeFS.writeFileSync(log, "");
  return {
    root,
    sessions: NodePath.join(account, "t3-sessions"),
    runs: () =>
      NodeFS.readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    start: () => start(root, account, log),
  };
}

function start(root, account, log) {
  const child = NodeChildProcess.spawn(process.execPath, [BRIDGE], {
    cwd: root,
    env: {
      ...process.env,
      ZCODE_APP: NodePath.join(root, "app"),
      ZCODE_ACP_API_KEY: "not-a-key",
      ZCODE_ACP_ACCOUNT_DIR: account,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: NodePath.join(root, "builtin.json"),
      FAKE_LOG: log,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  cleanups.push(() => child.kill("SIGKILL"));
  const pending = new Map();
  const firstUpdate = Promise.withResolvers();
  const asked = [];
  let answer = "deny";
  let onAsk = () => {};
  let nextId = 0;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const message = JSON.parse(line);
      if (message.method === "session/request_permission") {
        asked.push(message.params);
        onAsk(message);
        const optionId = answer;
        if (optionId !== "wait") {
          write({ id: message.id, result: { outcome: { outcome: "selected", optionId } } });
        }
      } else if (message.method === "session/update") firstUpdate.resolve();
      else pending.get(message.id)?.(message);
    }
  });
  const write = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      write({ id, method, params });
    });
  const set = (sessionId, configId, value) =>
    call("session/set_config_option", { sessionId, configId, value });
  return {
    call,
    set,
    firstUpdate: firstUpdate.promise,
    asked,
    reply: (id, optionId) => write({ id, result: { outcome: { outcome: "selected", optionId } } }),
    answerWith: (optionId, listener = () => {}) => {
      answer = optionId;
      onAsk = listener;
    },
    cancel: (sessionId) => write({ method: "session/cancel", params: { sessionId } }),
    create: async () => (await call("session/new", { cwd: root, mcpServers: [] })).result.sessionId,
    load: (sessionId) => call("session/load", { sessionId, cwd: root, mcpServers: [] }),
    prompt: (sessionId, text) =>
      call("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
    stop: () =>
      new Promise((resolve) => {
        child.on("exit", resolve);
        child.stdin.end();
      }),
  };
}

const modeOf = (run) => run.args[run.args.indexOf("--mode") + 1];

describe("ZCode account login", () => {
  it("lists account models only when signed in", async () => {
    for (const signedIn of [true, false]) {
      const bridge = setup({ signedIn }).start();
      const { result } = await bridge.call("session/new", { cwd: "/", mcpServers: [] });
      const model = result.configOptions.find((option) => option.id === "model");
      expect(model.options.some((option) => option.value === ACCOUNT)).toBe(signedIn);
      expect(model.currentValue).toBe(API);
    }
  });

  it("resumes the CLI session, keeps the API key out and never runs a slash command", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    expect((await bridge.prompt(id, "one")).result.stopReason).toBe("end_turn");
    await bridge.prompt(id, " /logout");
    const [first, second] = env.runs();
    expect(first.args).not.toContain("--resume");
    expect(first.key).toBe(null);
    expect(second.args.slice(-2)).toEqual(["--resume", "cli_1"]);
    expect(second.args[0]).toBe("--prompt=Message:  /logout");
  });

  it("refuses to change route during the first turn and after it", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    const turn = bridge.prompt(id, "slow");
    expect((await bridge.set(id, "model", API)).error).toBeDefined();
    expect((await turn).result.stopReason).toBe("end_turn");
    expect((await bridge.set(id, "model", API)).error.message).toContain("new thread");
  });

  it("restores the permission mode and history on load", async () => {
    const env = setup();
    let bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    await bridge.set(id, "mode", "yolo");
    bridge.answerWith("allow");
    await bridge.prompt(id, "one");
    await bridge.set(id, "mode", "plan");
    await bridge.stop();
    bridge = env.start();
    expect((await bridge.load(id)).error).toBeUndefined();
    await bridge.prompt(id, "two");
    expect(env.runs().map(modeOf)).toEqual(["yolo", "plan"]);
    expect(env.runs()[1].args.slice(-2)).toEqual(["--resume", "cli_1"]);
  });

  it("falls back to plan for a record without a mode and to build for auto", async () => {
    const env = setup();
    const bridge = env.start();
    NodeFS.mkdirSync(env.sessions);
    const [providerId, modelId] = ACCOUNT.split("::");
    NodeFS.writeFileSync(
      NodePath.join(env.sessions, "old.json"),
      JSON.stringify({ cliSessionId: "cli_1", providerId, modelId }),
    );
    await bridge.load("old");
    await bridge.prompt("old", "one");
    await bridge.set("old", "mode", "auto");
    await bridge.prompt("old", "two");
    expect(env.runs().map(modeOf)).toEqual(["plan", "build"]);
  });

  it("fails the turn, not the bridge, when the session cannot be saved", async () => {
    const env = setup();
    NodeFS.writeFileSync(env.sessions, "not a directory");
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    expect((await bridge.prompt(id, "one")).error.message).toContain("Could not save");
    expect(env.runs()).toEqual([]);
    expect(await bridge.create()).toBeDefined();
  });

  it("asks once per turn, runs unasked only when allowed and asks again next turn", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    bridge.answerWith("allow");
    await bridge.prompt(id, "one");
    bridge.answerWith("deny");
    await bridge.prompt(id, "two");
    bridge.answerWith("unknown");
    await bridge.prompt(id, "three");
    expect(env.runs().map(modeOf)).toEqual(["yolo", "build", "build"]);
    expect(bridge.asked.map((request) => request.toolCall.kind)).toEqual(Array(3).fill("execute"));
    expect(bridge.asked[0].options.map((option) => option.kind)).toEqual([
      "allow_once",
      "reject_once",
    ]);
  });

  it("denies side effects in every mode when T3 says no", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    for (const mode of ["edit", "guarded", "auto", "yolo", "build"]) {
      await bridge.set(id, "mode", mode);
      await bridge.prompt(id, mode);
    }
    expect(env.runs().map(modeOf)).toEqual(Array(5).fill("build"));
  });

  it("lets a mode change in flight outrank a late approval, on disk too", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    const asked = Promise.withResolvers();
    bridge.answerWith("wait", asked.resolve);
    const turn = bridge.prompt(id, "one");
    const request = await asked.promise;
    const change = bridge.set(id, "mode", "plan");
    bridge.reply(request.id, "allow");
    await Promise.all([turn, change]);
    expect(env.runs().map(modeOf)).toEqual(["plan"]);
    const [file] = NodeFS.readdirSync(env.sessions);
    const saved = JSON.parse(NodeFS.readFileSync(NodePath.join(env.sessions, file), "utf8"));
    expect(saved.mode).toBe("plan");
  });

  it("voids an approval when several mode changes queue up around it", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    for (const last of ["plan", "build"]) {
      await bridge.set(id, "mode", "auto");
      const asked = Promise.withResolvers();
      bridge.answerWith("wait", asked.resolve);
      const turn = bridge.prompt(id, "one");
      const request = await asked.promise;
      const first = bridge.set(id, "mode", "build");
      bridge.reply(request.id, "allow");
      await bridge.call("authenticate", {}); // The bridge has handled the approval by now.
      await Promise.all([first, bridge.set(id, "mode", last), turn]);
    }
    expect(env.runs().map(modeOf)).toEqual(["plan", "build"]);
  });

  it("saves a mode change made while the first turn runs", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    const turn = bridge.prompt(id, "slow");
    await Promise.all([turn, bridge.set(id, "mode", "plan")]);
    const [file] = NodeFS.readdirSync(env.sessions);
    const saved = JSON.parse(NodeFS.readFileSync(NodePath.join(env.sessions, file), "utf8"));
    expect(saved).toMatchObject({ mode: "plan", cliSessionId: "cli_1" });
  });

  it("never asks in plan mode and keeps plan chosen while the user decides", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    const asked = Promise.withResolvers();
    bridge.answerWith("wait", asked.resolve);
    const turn = bridge.prompt(id, "one");
    const request = await asked.promise;
    await bridge.set(id, "mode", "plan");
    bridge.reply(request.id, "allow");
    await turn;
    await bridge.prompt(id, "two");
    expect(bridge.asked.length).toBe(1);
    expect(env.runs().map(modeOf)).toEqual(["plan", "plan"]);
  });

  it("cancels while waiting for the answer without starting ZCode", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    bridge.answerWith("wait", () => bridge.cancel(id));
    expect((await bridge.prompt(id, "one")).result.stopReason).toBe("cancelled");
    expect(env.runs()).toEqual([]);
  });

  it("lets a model switch in flight finish before the first message", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    const change = bridge.set(id, "model", API);
    const turn = bridge.prompt(id, "one");
    const switched = (await change).error === undefined;
    // Whichever wins, the message follows the route the session ended on.
    if (!switched) expect((await turn).result.stopReason).toBe("end_turn");
    expect(env.runs().length).toBe(switched ? 0 : 1);
    if (!switched) {
      await bridge.prompt(id, "two");
      expect(env.runs()[1].args.slice(-2)).toEqual(["--resume", "cli_1"]);
    }
  });

  it("keeps the mode it saved when a change cannot be saved", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    await bridge.set(id, "mode", "yolo");
    await bridge.prompt(id, "one");
    NodeFS.renameSync(env.sessions, `${env.sessions}.away`);
    NodeFS.writeFileSync(env.sessions, "not a directory");
    expect((await bridge.set(id, "mode", "plan")).error.message).toContain("Could not save");
    expect((await bridge.prompt(id, "two")).error.message).toContain("Could not save");
    expect(env.runs().length).toBe(1);
  });

  it("refuses a record that lost its history id", async () => {
    const env = setup();
    const [providerId, modelId] = ACCOUNT.split("::");
    NodeFS.mkdirSync(env.sessions);
    const bridge = env.start();
    for (const [name, cliSessionId] of [
      ["empty", ""],
      ["missing", undefined],
      ["list", ["cli_1"]],
    ]) {
      NodeFS.writeFileSync(
        NodePath.join(env.sessions, `${name}.json`),
        JSON.stringify({ cliSessionId, providerId, modelId, mode: "plan" }),
      );
      expect((await bridge.load(name)).error.message).toContain("unreadable");
    }
  });

  it("does not take a subagent's result for the turn's", async () => {
    const bridge = setup().start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    expect((await bridge.prompt(id, "subagent only")).error).toBeDefined();
  });

  it("refuses a damaged record instead of resuming another history", async () => {
    const env = setup();
    NodeFS.mkdirSync(env.sessions);
    NodeFS.writeFileSync(NodePath.join(env.sessions, "bad.json"), "{");
    expect((await env.start().load("bad")).error.message).toContain("unreadable");
  });

  it("reports a failed turn even when another session's result follows", async () => {
    const bridge = setup().start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    expect((await bridge.prompt(id, "fail")).error.message).toBe("boom");
  });

  it("cancels a running turn", async () => {
    const env = setup();
    const bridge = env.start();
    const id = await bridge.create();
    await bridge.set(id, "model", ACCOUNT);
    const turn = bridge.prompt(id, "hang");
    await bridge.firstUpdate;
    bridge.cancel(id);
    expect((await turn).result.stopReason).toBe("cancelled");
  });
});
