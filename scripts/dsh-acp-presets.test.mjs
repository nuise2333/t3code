import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  PRESET_OPTION_ID,
  presetAgents,
  presetOption,
  presetStream,
} from "./lib/dsh-acp-presets.mjs";

const presetRows = [
  {
    id: "deepseek-stack",
    name: "DeepSeek Stack",
    description: "ds-mode and the ds-* loops",
    order: 0,
  },
  { id: "standard", order: 1 },
  { id: "ptc", order: 2 },
  { id: "minimal", order: 3 },
  { id: "cordis", order: 4 },
];

function fixture() {
  let selected = "standard";
  let started = false;
  const agent = { session: { id: "session-1" } };
  const ctx = {
    agents: {
      get: (id) => (id === agent.session.id ? agent : undefined),
      turnBoundaryOf: () => ({ openTurnStartSeq: null, lastTurn: started ? 1 : 0 }),
    },
    agentPresets: {
      list: async () => presetRows,
      presetForSession: () => selected,
      select: vi.fn(async (_agent, value) => {
        if (started) throw new Error("This session has already started");
        selected = value;
      }),
    },
    sessions: { flush: vi.fn(async () => {}) },
  };
  return {
    ctx,
    agent,
    start: () => {
      started = true;
    },
  };
}

describe("DSH ACP presets", () => {
  it("mounts the persisted selection before publishing a resumed agent", async () => {
    const calls = [];
    const agentCtx = {};
    const ctx = {
      sessionQuery: {
        observeSession: async () => ({ projections: { values: { agentPreset: "minimal" } } }),
      },
      agentPresets: {
        resolve: async (id) => ({ id }),
        mount: async (scope, id) => {
          calls.push([scope, id]);
        },
      },
      agents: {
        resume: async (options) => {
          await options.setup(agentCtx);
          return "handle";
        },
      },
    };
    const result = await presetAgents(ctx).resume({
      resumeSessionId: "saved",
      setup: async () => {
        calls.push("original setup");
      },
    });
    expect(result).toBe("handle");
    expect(calls).toEqual(["original setup", [agentCtx, "minimal"]]);
    ctx.sessionQuery.observeSession = async () => ({
      projections: { values: { agentPreset: null } },
    });
    await expect(presetAgents(ctx).resume({ resumeSessionId: "legacy" })).rejects.toThrow(
      "no saved agent preset",
    );
  });

  it("lists registry presets, persists changes, and rejects switching after a turn", async () => {
    const { ctx, start } = fixture();
    let input;
    const output = [];
    const bridge = presetStream(
      ctx,
      {
        readable: new ReadableStream({
          start(controller) {
            input = controller;
          },
        }),
        writable: new WritableStream({
          write(message) {
            output.push(message);
          },
        }),
      },
      presetRows,
    );
    const reader = bridge.readable.getReader();
    const writer = bridge.writable.getWriter();
    const model = { id: "model", currentValue: "deepseek", type: "select", options: [] };
    input.enqueue({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await reader.read();
    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "session-1", configOptions: [model] },
    });
    expect(output[0].result.configOptions).toEqual([
      model,
      presetOption(ctx, "session-1", presetRows),
    ]);
    expect(output[0].result.configOptions.at(-1).options.map((choice) => choice.name)).toEqual([
      "DeepSeek Stack",
      "Standard",
      "PTC",
      "Minimal",
      "Creator",
    ]);
    const switchTo = async (id, value) => {
      input.enqueue({
        jsonrpc: "2.0",
        id,
        method: "session/set_config_option",
        params: { sessionId: "session-1", configId: PRESET_OPTION_ID, value },
      });
      input.enqueue({ method: "marker" });
      expect((await reader.read()).value).toEqual({ method: "marker" });
      return output.at(-1);
    };
    for (const value of ["ptc", "minimal", "cordis", "deepseek-stack"]) {
      const response = await switchTo(value, value);
      expect(response.result.configOptions).toEqual([
        model,
        presetOption(ctx, "session-1", presetRows),
      ]);
      expect(response.result.configOptions.at(-1).currentValue).toBe(value);
    }
    expect(ctx.sessions.flush).toHaveBeenCalledTimes(4);
    input.enqueue({
      jsonrpc: "2.0",
      id: 8,
      method: "session/prompt",
      params: { sessionId: "session-1" },
    });
    await reader.read();
    await writer.write({ jsonrpc: "2.0", id: 8, method: "session/request_permission", params: {} });
    start();
    await writer.write({ jsonrpc: "2.0", id: 8, result: { stopReason: "end_turn" } });
    expect(output.at(-2).params.update.configOptions.at(-1).options).toEqual([
      {
        value: "deepseek-stack",
        name: "DeepSeek Stack",
        description: "ds-mode and the ds-* loops",
      },
    ]);
    expect(presetOption(ctx, "session-1", presetRows).options).toEqual([
      {
        value: "deepseek-stack",
        name: "DeepSeek Stack",
        description: "ds-mode and the ds-* loops",
      },
    ]);
    expect((await switchTo(5, "standard")).error.message).toContain("already started");
    expect((await switchTo(6, "deepseek-stack")).result.configOptions.at(-1).currentValue).toBe(
      "deepseek-stack",
    );
    expect((await switchTo(7, "unknown")).error.code).toBe(-32602);
    input.close();
    await reader.read();
    await writer.close();
  });

  it("routes the stack persona to every vendored skill and to nothing else", () => {
    const stack = new URL("./dsh-stack/", import.meta.url);
    const persona = NodeFS.readFileSync(new URL("preset.patch.yml", stack), "utf8");
    const routed = new Set(persona.match(/\bds-[a-z]+(?:-[a-z]+)*\b/g));
    routed.delete("ds-mode");
    // ds-mode is inlined in the persona; ds-principles is reached through ds-help.
    const vendored = NodeFS.readdirSync(new URL("skills/", stack)).filter(
      (name) => !["ds-mode", "ds-principles"].includes(name),
    );
    expect([...routed].toSorted()).toEqual(vendored.toSorted());
  });
});
