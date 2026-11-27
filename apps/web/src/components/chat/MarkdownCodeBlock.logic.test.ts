import { describe, expect, it } from "vite-plus/test";

import { MAX_HIGHLIGHTED_CODE_LENGTH } from "../../lib/syntaxHighlighting";
import { codeBlockHighlightLanguage, isSingleShellCommand } from "./MarkdownCodeBlock.logic";

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

describe("isSingleShellCommand", () => {
  it.each([
    ["a single line is one command", "echo hello", true, true],
    ["a single line stays one command without continuations", "echo hello", false, true],
    [
      "odd backslash runs continue the command across lines",
      'PATH="$PATH:$HOME/bin" \\\nT3CODE_PROJECT_ROOT="$HOME/project" \\\nnode scripts/setup-worktree.ts',
      true,
      true,
    ],
    [
      "three backslashes are a literal backslash plus a continuation",
      "echo a\\\\\\\necho b",
      true,
      true,
    ],
    [
      "two backslashes are a literal backslash, so the newline ends the command",
      "echo a\\\\\necho b",
      true,
      false,
    ],
    ["an unescaped newline starts a second command", "echo one\necho two", true, false],
    ["continuations are refused when the language has none", "echo one \\\necho two", false, false],
    [
      "a backslash before a space does not continue the line",
      "echo one \\ \necho two",
      true,
      false,
    ],
    ["a trailing blank line is not a continuation", "echo hello\n", true, false],
    ["a leading blank line is not a continuation", "\necho hello", true, false],
    ["a tab is a rejected control character", "echo\thello", true, false],
    ["a carriage return is a rejected control character", "echo hello\r", true, false],
    ["a bidi override is a rejected format character", "echo safe \u202e#", true, false],
    ["a zero-width space is a rejected format character", "echo\u200b hello", true, false],
    [
      "a format character on a continued line still rejects",
      "echo one \\\necho\u200b two",
      true,
      false,
    ],
  ] as const)("%s", (_name, body, allowLineContinuation, expected) => {
    expect(isSingleShellCommand(body, allowLineContinuation)).toBe(expected);
  });
});
