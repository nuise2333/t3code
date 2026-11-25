// Pure mapping between Qoder's model catalog and ACP config options, used by ../qoder-acp.mjs.
import * as NodeFS from "node:fs";

// Labels, order and defaults follow the Qoder app.
export const PERMISSION_MODES = [
  { value: "acceptEdits", name: "Ask every time" },
  { value: "auto", name: "Auto approve" },
  { value: "yolo", name: "Full access" },
  // Not in the app: the stricter runtime mode, for T3's Supervised.
  { value: "default", name: "Supervised" },
];
const EFFORTS = [
  ["none", "Thinking off"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"],
];

const formatTokens = (tokens) =>
  tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1_000)}K`;

/** Models by id, in the app's order, with the app's saved settings as their defaults. */
export function catalogFromModels(models, preferences) {
  const saved = new Map(preferences.models.map((row) => [row.model_key, row]));
  const providers = new Map(
    preferences.providers.map((row) => [row.profile_id, row.provider_display_name]),
  );
  const catalog = new Map();
  for (const model of models) {
    if (model.isEnabled === false) continue;
    const custom = model.source === "user";
    const own = saved.get(custom ? `byok:${model.value}` : model.value);
    if (own?.visible === 0) continue;
    const offered = new Set(model.efforts ?? []);
    if (offered.size > 0 && model.supportsDisabled) offered.add("none");
    const efforts = EFFORTS.filter(([value]) => offered.has(value)).map(([value]) => value);
    const contextWindows = model.availableContextWindows ?? [];
    const pick = (choices, ...candidates) => candidates.find((value) => choices.includes(value));
    catalog.set(model.value, {
      id: model.value,
      name: model.displayName,
      description: [
        model.priceFactor === undefined ? undefined : `${model.priceFactor.toFixed(2)}x Credit`,
        ...(model.tags ?? []),
      ]
        .filter(Boolean)
        .join(" · "),
      ...(custom ? { subProvider: providers.get(model.value) ?? "Custom" } : {}),
      efforts,
      effort: pick(efforts, own?.reasoning_effort, model.defaultEffort),
      contextWindows,
      nativeContextWindow: model.defaultContextWindow,
      contextWindow: pick(contextWindows, own?.context_window, model.defaultContextWindow),
    });
  }
  return catalog;
}

/** What a model runs with until the user picks otherwise; undefined leaves it to the runtime. */
export function defaultSelection(session, modelId) {
  const model = session.catalog?.get(modelId);
  return { effort: model?.effort, contextWindow: model?.contextWindow };
}

/** The --context-window to launch with; undefined when it is what the model gets anyway. */
export function launchContextWindow(session, modelId, contextWindow) {
  return contextWindow === session.catalog?.get(modelId)?.nativeContextWindow
    ? undefined
    : contextWindow;
}

function modelOptions(model, selected = {}) {
  const options = [];
  if (model.efforts.length > 0) {
    options.push({
      type: "select",
      id: "reasoning_effort",
      name: "Thinking",
      category: "thought_level",
      currentValue: selected.effort ?? model.effort ?? model.efforts.at(-1),
      options: EFFORTS.filter(([value]) => model.efforts.includes(value)).map(([value, name]) => ({
        value,
        name,
      })),
    });
  }
  if (model.contextWindows.length > 1) {
    options.push({
      type: "select",
      id: "context_window",
      name: "Context window",
      category: "model_config",
      currentValue: String(
        selected.contextWindow ?? model.contextWindow ?? model.contextWindows[0],
      ),
      options: model.contextWindows.map((tokens) => ({
        value: String(tokens),
        name: formatTokens(tokens),
      })),
    });
  }
  return options;
}

export function configOptionsFor(session) {
  const model = session.catalog?.get(session.model);
  const passthrough = session.nativeOptions.filter(
    (option) => option.id === "model" || option.id === "reasoning_effort",
  );
  return [
    ...(session.catalog
      ? [
          {
            type: "select",
            id: "model",
            name: "Model",
            category: "model",
            currentValue: session.model,
            options: [...session.catalog.values()].map(({ id, name, description }) => ({
              value: id,
              name,
              description,
            })),
          },
          ...(model ? modelOptions(model, session.selections.get(session.model)) : []),
        ]
      : passthrough.map((option) => ({
          ...option,
          currentValue:
            option.id === "model"
              ? session.model
              : (session.selections.get(session.model)?.effort ?? option.currentValue),
        }))),
    // collaboration_mode keeps both out of the model options: T3's permission and plan controls
    // set them.
    {
      type: "select",
      id: "permission_mode",
      name: "Access permissions",
      category: "collaboration_mode",
      currentValue: session.permissionMode,
      options: PERMISSION_MODES,
    },
    {
      type: "select",
      id: "plan_mode",
      name: "Plan mode",
      category: "collaboration_mode",
      currentValue: session.plan ? "plan" : "build",
      options: [
        { value: "build", name: "Build" },
        { value: "plan", name: "Plan" },
      ],
    },
  ];
}

export function modelState(session) {
  if (!session.catalog) return session.nativeModels;
  return {
    currentModelId: session.model,
    availableModels: [...session.catalog.values()].map((model) => ({
      modelId: model.id,
      name: model.name,
      description: model.description,
      _meta: {
        configOptions: modelOptions(model, session.selections.get(model.id)),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
      },
    })),
  };
}

export function launchArgs({ model, effort, contextWindow, plan }) {
  return [
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--reasoning-effort", effort] : []),
    ...(contextWindow ? ["--context-window", String(contextWindow)] : []),
    // A --permission-mode flag would override the plan default.
    ...(plan ? ["--settings", JSON.stringify({ general: { defaultPermissionMode: "plan" } })] : []),
  ];
}

/**
 * The plan approval as the app asks it: approve or keep planning, under the access mode already
 * chosen. The runtime's own options would each pick another access mode.
 */
export function planPermission(params, permissionMode) {
  const ids = new Set(params.options.map((option) => option.optionId));
  const approve = ids.has(permissionMode) ? permissionMode : "default";
  const text = params.toolCall.content?.find((item) => item.type === "content")?.content?.text;
  const file = /^Plan file: (.+\.md)$/m.exec(text ?? "")?.[1];
  let plan;
  try {
    plan = file === undefined ? undefined : NodeFS.readFileSync(file, "utf8").trim() || undefined;
  } catch {}
  return {
    plan,
    request: {
      ...params,
      options: [
        { optionId: approve, name: "Approve plan", kind: "allow_once" },
        ...params.options.filter((option) => option.kind.startsWith("reject")),
      ],
    },
  };
}
