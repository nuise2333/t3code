// @effect-diagnostics nodeBuiltinImport:off - a plain test that scans the source tree once.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

// The hash gt-react itself looks translations up by, from the copy it ships with.
const { hashSource } = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("gt-react"),
)("generaltranslation/id") as {
  readonly hashSource: (input: {
    readonly source: string;
    readonly dataFormat: "ICU";
    readonly context?: string;
  }) => string;
};

const sourceDirectory = NodePath.join(import.meta.dirname, "..");
const GT_CALL = /\bgt\(\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*\{([^}]*)\})?\s*\)/g;

it("has a Chinese entry for every literal gt() string", () => {
  const zh = JSON.parse(
    NodeFS.readFileSync(NodePath.join(import.meta.dirname, "translations/zh.json"), "utf8"),
  ) as Record<string, unknown>;
  const missing = NodeFS.readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
    .flatMap((file) => {
      const text = NodeFS.readFileSync(NodePath.join(sourceDirectory, file), "utf8");
      if (!text.includes("gt-react")) return [];
      return [...text.matchAll(GT_CALL)].flatMap((match) => {
        const source = JSON.parse(`"${match[1]}"`) as string;
        const context = /\$context:\s*"([^"]*)"/.exec(match[2] ?? "")?.[1];
        const hash = hashSource({
          source,
          dataFormat: "ICU",
          ...(context === undefined ? {} : { context }),
        });
        return hash in zh ? [] : [`${file}: ${source}`];
      });
    });
  expect(missing).toEqual([]);
});
