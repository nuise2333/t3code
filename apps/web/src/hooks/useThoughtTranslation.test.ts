import { describe, expect, it } from "vite-plus/test";
import {
  classifyTargetLanguage,
  isAlreadyTargetLanguage,
  shouldTranslateThought,
} from "@t3tools/shared/thoughtTranslation";

describe("thought translation language heuristic", () => {
  it("classifies common target language names and locale tags", () => {
    expect(classifyTargetLanguage("简体中文")).toBe("chinese");
    expect(classifyTargetLanguage("zh-CN")).toBe("chinese");
    expect(classifyTargetLanguage("Chinese")).toBe("chinese");
    expect(classifyTargetLanguage("日本語")).toBe("japanese");
    expect(classifyTargetLanguage("한국어")).toBe("korean");
    expect(classifyTargetLanguage("English")).toBe("english");
    expect(classifyTargetLanguage("Русский")).toBe("cyrillic");
    expect(classifyTargetLanguage("Français")).toBe("other");
  });

  it("skips when target language or text is empty or trivial", () => {
    expect(shouldTranslateThought("Let me check the settings file.", "")).toBe(false);
    expect(shouldTranslateThought("Let me check the settings file.", "   ")).toBe(false);
    expect(shouldTranslateThought("   ", "简体中文")).toBe(false);
    expect(isAlreadyTargetLanguage("ok", "简体中文")).toBe(true);
  });

  it("detects Chinese reasoning even with inline code and file paths", () => {
    const chineseThought =
      "先检查 `apps/server/src/ws.ts` 里的 RPC 注册逻辑，再确认 Effect Semaphore 并发限制为 3。";
    expect(isAlreadyTargetLanguage(chineseThought, "简体中文")).toBe(true);
    expect(shouldTranslateThought(chineseThought, "简体中文")).toBe(false);
  });

  it("translates English reasoning into Chinese even when mentioning Chinese strings", () => {
    const englishThought =
      'I need to check how responseLanguage (e.g. "简体中文") flows from settings to the server before wiring the RPC.';
    expect(isAlreadyTargetLanguage(englishThought, "简体中文")).toBe(false);
    expect(shouldTranslateThought(englishThought, "简体中文")).toBe(true);
  });

  it("ignores fenced code blocks and URLs when judging script dominance", () => {
    const codeOnly = "```ts\nconst greeting = 'hello world';\n```\nhttps://example.com/foo/bar";
    expect(isAlreadyTargetLanguage(codeOnly, "简体中文")).toBe(true);

    const chineseWithCode = [
      "我们需要更新一下路由定义，保持接口最小化：",
      "```ts",
      "export const serverTranslateThought = 'server.translateThought';",
      "```",
    ].join("\n");
    expect(isAlreadyTargetLanguage(chineseWithCode, "简体中文")).toBe(true);
  });

  it("handles Japanese, Korean, English, and Latin-script targets", () => {
    expect(isAlreadyTargetLanguage("まず設定ファイルを確認してから実装します。", "日本語")).toBe(
      true,
    );
    expect(isAlreadyTargetLanguage("まず設定ファイルを確認してから実装します。", "简体中文")).toBe(
      false,
    );
    expect(isAlreadyTargetLanguage("먼저 설정 파일을 확인하고 수정하겠습니다.", "한국어")).toBe(
      true,
    );
    expect(isAlreadyTargetLanguage("Checking the server handler first.", "English")).toBe(true);
    expect(isAlreadyTargetLanguage("先检查服务端处理器。", "English")).toBe(false);
    // Cannot distinguish Latin-script languages cheaply, so always translate into French.
    expect(isAlreadyTargetLanguage("Checking the server handler first.", "Français")).toBe(false);
  });
});
