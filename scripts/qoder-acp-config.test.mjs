import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  catalogFromModels,
  configOptionsFor,
  launchArgs,
  launchContextWindow,
  planPermission,
} from "./lib/qoder-acp-config.mjs";

const models = [
  { value: "auto", displayName: "Auto", priceFactor: 0.3, availableContextWindows: [200000] },
  {
    value: "flash",
    displayName: "Flash",
    efforts: ["high", "max", "low"],
    defaultEffort: "high",
    supportsDisabled: true,
    availableContextWindows: [200000, 1000000],
    defaultContextWindow: 200000,
  },
  { value: "hidden", displayName: "Hidden" },
  { value: "own", displayName: "Own", source: "user", efforts: ["low"], defaultEffort: "low" },
];

describe("qoder catalog", () => {
  const catalog = catalogFromModels(models, {
    models: [
      // A saved effort the model no longer offers falls back to the model's default.
      { model_key: "flash", visible: 1, context_window: 1000000, reasoning_effort: "xhigh" },
      { model_key: "hidden", visible: 0, context_window: null, reasoning_effort: null },
      { model_key: "byok:own", visible: 1, context_window: null, reasoning_effort: "low" },
    ],
    providers: [{ profile_id: "own", provider_display_name: "Model Studio" }],
  });
  const session = {
    catalog,
    model: "flash",
    selections: new Map(),
    nativeOptions: [],
    permissionMode: "acceptEdits",
    plan: false,
  };

  it("follows the app's settings, order and labels", () => {
    expect([...catalog.keys()]).toEqual(["auto", "flash", "own"]);
    expect(catalog.get("own").subProvider).toBe("Model Studio");
    const options = configOptionsFor(session);
    expect(options.map((option) => [option.id, option.currentValue])).toEqual([
      ["model", "flash"],
      ["reasoning_effort", "high"],
      ["context_window", "1000000"],
      ["permission_mode", "acceptEdits"],
      ["plan_mode", "build"],
    ]);
    expect(options[1].options.map((option) => option.name)).toEqual([
      "Thinking off",
      "Low",
      "High",
      "Maximum",
    ]);
  });

  it("launches with flags only where the runtime would differ", () => {
    expect(launchContextWindow(session, "flash", 200000)).toBeUndefined();
    expect(launchContextWindow(session, "flash", 1000000)).toBe(1000000);
    expect(launchArgs({ model: "flash", effort: "low", plan: true })).toEqual([
      "--model",
      "flash",
      "--reasoning-effort",
      "low",
      "--settings",
      '{"general":{"defaultPermissionMode":"plan"}}',
    ]);
  });
});

describe("qoder plan approval", () => {
  it("offers one approval under the chosen access mode, with the plan text", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "qoder-plan-"));
    const file = NodePath.join(dir, "plan.md");
    NodeFS.writeFileSync(file, "# Plan\n");
    const params = {
      options: [
        { optionId: "default", name: "Yes", kind: "allow_once" },
        { optionId: "yolo", name: "Yes, bypass", kind: "allow_always" },
        { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
      ],
      toolCall: {
        content: [{ type: "content", content: { type: "text", text: `Plan file: ${file}` } }],
      },
    };
    const ids = (mode) =>
      planPermission(params, mode).request.options.map((option) => option.optionId);
    expect(planPermission(params, "auto").plan).toBe("# Plan");
    expect(ids("auto")).toEqual(["default", "plan"]);
    expect(ids("yolo")).toEqual(["yolo", "plan"]);
    NodeFS.rmSync(dir, { recursive: true });
  });
});
