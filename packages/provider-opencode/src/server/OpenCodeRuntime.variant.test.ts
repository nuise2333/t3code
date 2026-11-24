// @effect-diagnostics nodeBuiltinImport:off - scans this package's source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { OPENCODE_DEFAULT_VARIANT, selectedOpenCodeVariant } from "./OpenCodeRuntime.ts";

const selection = (variant?: string) =>
  createModelSelection(
    ProviderInstanceId.make("opencode"),
    "anthropic/claude-sonnet",
    variant === undefined ? null : [{ id: "variant", value: variant }],
  );

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir).flatMap((name) => {
    const path = NodePath.join(dir, name);
    if (NodeFS.statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("selectedOpenCodeVariant", () => {
  it("asks for no variant when the user picked OpenCode's Default entry", () => {
    expect(selectedOpenCodeVariant(selection(OPENCODE_DEFAULT_VARIANT))).toBeUndefined();
    expect(selectedOpenCodeVariant(selection())).toBeUndefined();
    expect(selectedOpenCodeVariant(selection("high"))).toBe("high");
  });

  it("is the only place a dispatch path reads the variant option", () => {
    const readers = sourceFiles(import.meta.dirname).filter(
      (path) =>
        !path.endsWith("OpenCodeRuntime.ts") &&
        /getModelSelectionStringOptionValue\([^)]*"variant"\)/.test(
          NodeFS.readFileSync(path, "utf8"),
        ),
    );
    expect(readers).toEqual([]);
  });
});
