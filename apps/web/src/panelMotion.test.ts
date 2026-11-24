// @effect-diagnostics nodeBuiltinImport:off - scans real source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SRC = import.meta.dirname;

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir).flatMap((name) => {
    const path = NodePath.join(dir, name);
    if (NodeFS.statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("panel motion", () => {
  it("animates panels on the shared ease-panel curve", () => {
    const offenders = sourceFiles(SRC).filter((path) =>
      NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .some(
          (line) =>
            /panel-animation|panelAnimations|preview-duration/.test(line) &&
            /\bease-out\b/.test(line),
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the macOS topbar height in step across CSS, web and desktop", () => {
    const css = NodeFS.readFileSync(NodePath.join(SRC, "index.css"), "utf8");
    const cssHeight = Number(/--workspace-topbar-height: (\d+)px;/.exec(css)?.[1]);
    const web = NodeFS.readFileSync(NodePath.join(SRC, "lib/windowControlsOverlay.ts"), "utf8");
    const webHeight = Number(/MACOS_TITLEBAR_HEIGHT = (\d+);/.exec(web)?.[1]);
    const desktop = NodeFS.readFileSync(
      NodePath.join(SRC, "../../desktop/src/window/DesktopWindow.ts"),
      "utf8",
    );
    const desktopHeight = Number(/MACOS_WORKSPACE_TOPBAR_HEIGHT = (\d+);/.exec(desktop)?.[1]);
    expect(webHeight).toBe(cssHeight);
    expect(desktopHeight).toBe(cssHeight);
  });
});
