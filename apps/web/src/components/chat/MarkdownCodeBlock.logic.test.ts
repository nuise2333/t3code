import { describe, expect, it } from "vite-plus/test";

import { MAX_HIGHLIGHTED_CODE_LENGTH } from "../../lib/syntaxHighlighting";
import { codeBlockHighlightLanguage } from "./MarkdownCodeBlock.logic";

describe("codeBlockHighlightLanguage", () => {
  const long = "x".repeat(MAX_HIGHLIGHTED_CODE_LENGTH + 1);
  it.each([
    ["a finished short block keeps its grammar", "ts", "x", false, "ts"],
    ["a finished long block renders as text", "ts", long, false, "text"],
    ["a streamed long block keeps its grammar, so the selection survives", "ts", long, true, "ts"],
    ["a long ANSI block stays parsed, so escapes never show", "ansi", long, false, "ansi"],
  ] as const)("%s", (_name, fenceLanguage, code, hasStreamed, expected) => {
    expect(codeBlockHighlightLanguage({ fenceLanguage, code, hasStreamed })).toBe(expected);
  });
});
