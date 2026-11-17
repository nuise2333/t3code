import * as NodeModule from "node:module";
import * as NodeStream from "node:stream";

export const name = "t3-dsh-acp-presets";
export const inject = [
  "agents",
  "agentPresets",
  "sessionQuery",
  "sessions",
  "llm",
  "sessionPersistence",
  "loader",
];
export const PRESET_OPTION_ID = "t3_agent_preset";
// The shipped DSH presets declare no display name; the stack preset does.
const shippedLabels = { standard: "Standard", ptc: "PTC", minimal: "Minimal", cordis: "Creator" };

export function presetOption(ctx, sessionId, presets) {
  const agent = ctx.agents.get(sessionId);
  if (!agent) throw new Error(`Unknown session: ${sessionId}`);
  const currentValue = ctx.agentPresets.presetForSession(agent.session);
  const boundary = ctx.agents.turnBoundaryOf(agent.session);
  const locked = boundary.openTurnStartSeq !== null || boundary.lastTurn > 0;
  return {
    id: PRESET_OPTION_ID,
    name: "Agent preset",
    category: "mode",
    type: "select",
    currentValue,
    options: presets
      .filter((preset) => preset.broken === undefined)
      .map((preset) => ({
        value: preset.id,
        name: preset.name ?? shippedLabels[preset.id] ?? preset.id,
        ...(preset.description === undefined ? {} : { description: preset.description }),
      }))
      .filter((choice) => !locked || choice.value === currentValue),
  };
}

export function presetAgents(ctx) {
  return new Proxy(ctx.agents, {
    get(target, key) {
      if (key !== "create" && key !== "resume") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (options) => {
        const restored =
          key === "resume"
            ? (await ctx.sessionQuery.observeSession(options.resumeSessionId)).projections.values
                .agentPreset
            : undefined;
        if (key === "resume" && !restored)
          throw new Error(
            "This session has no saved agent preset. Start a new thread with the preset launcher.",
          );
        const selected = await ctx.agentPresets.resolve(restored ?? undefined);
        if (selected.broken) throw new Error(selected.broken);
        return target[key]({
          ...options,
          ...(key === "create" ? { meta: { ...options.meta, agentPreset: selected.id } } : {}),
          setup: async (agentCtx, ...args) => {
            await options.setup?.(agentCtx, ...args);
            await ctx.agentPresets.mount(agentCtx, selected.id);
          },
        });
      };
    },
  });
}

export function presetStream(ctx, stream, presets) {
  const writer = stream.writable.getWriter();
  const pending = new Map();
  const configurations = new Map();
  const send = (message) => writer.write(message);
  const addOption = (options, sessionId) => {
    const result = [
      ...(options ?? []).filter((option) => option.id !== PRESET_OPTION_ID),
      presetOption(ctx, sessionId, presets),
    ];
    configurations.set(sessionId, result);
    return result;
  };
  const readable = stream.readable.pipeThrough(
    new TransformStream({
      async transform(message, controller) {
        if (
          message.method === "session/set_config_option" &&
          message.params?.configId === PRESET_OPTION_ID
        ) {
          try {
            const agent = ctx.agents.get(message.params.sessionId);
            if (!agent) throw new Error("Unknown session");
            const value = message.params.value;
            const preset = presets.find((candidate) => candidate.id === value);
            if (!preset) throw new Error(`Unknown preset: ${value}`);
            if (preset.broken !== undefined) throw new Error(preset.broken);
            if (ctx.agentPresets.presetForSession(agent.session) !== value) {
              await ctx.agentPresets.select(agent, value);
              await ctx.sessions.flush(agent.session);
            }
            const configOptions = addOption(configurations.get(agent.session.id), agent.session.id);
            await send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: agent.session.id,
                update: { sessionUpdate: "config_option_update", configOptions },
              },
            });
            await send({ jsonrpc: "2.0", id: message.id, result: { configOptions } });
          } catch (error) {
            await send({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32602, message: error.message },
            });
          }
          return;
        }
        if (
          message.id !== undefined &&
          [
            "session/new",
            "session/resume",
            "session/set_config_option",
            "session/prompt",
            "session/close",
          ].includes(message.method)
        ) {
          pending.set(message.id, message);
        }
        controller.enqueue(message);
      },
    }),
  );
  const writable = new WritableStream({
    async write(message) {
      const request = message.method === undefined ? pending.get(message.id) : undefined;
      if (request) {
        pending.delete(message.id);
        if (request.method === "session/close" && message.result) {
          configurations.delete(request.params.sessionId);
        } else if (request.method === "session/prompt") {
          const sessionId = request.params.sessionId;
          await send({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "config_option_update",
                configOptions: addOption(configurations.get(sessionId), sessionId),
              },
            },
          });
        } else if (message.result) {
          const sessionId = message.result.sessionId ?? request.params.sessionId;
          message = {
            ...message,
            result: {
              ...message.result,
              configOptions: addOption(message.result.configOptions, sessionId),
            },
          };
        }
      }
      if (
        message.method === "session/update" &&
        message.params.update.sessionUpdate === "config_option_update"
      ) {
        message = {
          ...message,
          params: {
            ...message.params,
            update: {
              ...message.params.update,
              configOptions: addOption(
                message.params.update.configOptions,
                message.params.sessionId,
              ),
            },
          },
        };
      }
      await send(message);
    },
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  });
  return { readable, writable };
}

export async function apply(ctx, config) {
  const require = NodeModule.createRequire(config.runtimeAnchor);
  const bridge = await import(require.resolve("@deepseek-ai/dsh-acp"));
  const { ndJsonStream } = await import(
    require.resolve("@agentclientprotocol/sdk", {
      paths: [require.resolve("@deepseek-ai/dsh-acp")],
    })
  );
  const presets = await ctx.agentPresets.list();
  const agents = presetAgents(ctx);
  const scoped = new Proxy(ctx, {
    get(target, key) {
      if (key === "agents") return agents;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const original = [...ctx.loader.entries()].find((entry) => entry.options.id === "acp");
  if (!original) throw new Error("The profile must contain the original acp configuration row.");
  bridge.apply(scoped, {
    ...original.options.config,
    ...config,
    stream: presetStream(
      ctx,
      ndJsonStream(
        NodeStream.Writable.toWeb(process.stdout),
        NodeStream.Readable.toWeb(process.stdin),
      ),
      presets,
    ),
  });
}
