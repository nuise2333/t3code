import type { DiffsTheme } from "@pierre/diffs";

export type ReaderSyntaxClass = "keyword" | "string" | "comment" | "literal" | "type";

// Highlighter token types, each standing for itself and its dotted subtypes. Everything absent
// (functions, variables, operators, punctuation, tags, attributes) keeps the text colour.
const SYNTAX_CLASSES: Readonly<Record<string, ReaderSyntaxClass>> = {
  keyword: "keyword",
  preproc: "keyword",
  string: "string",
  "property.json_key": "string",
  comment: "comment",
  number: "literal",
  boolean: "literal",
  "constant.builtin": "literal",
  type: "type",
  enum: "type",
};

/** The reader colour class of a highlighter token type, or null for plain text. */
export function readerSyntaxClass(tokenType: string): ReaderSyntaxClass | null {
  for (
    let name = tokenType;
    name !== "";
    name = name.slice(0, Math.max(0, name.lastIndexOf(".")))
  ) {
    const syntaxClass = SYNTAX_CLASSES[name];
    if (syntaxClass) return syntaxClass;
  }
  return null;
}

export const READER_SYNTAX_THEME_NAME = "t3-reader";

/**
 * One theme for every reader palette, light and dark: its colours are names of `--reader-*`
 * variables, so highlighted HTML follows the reader theme without being rendered again.
 */
export const READER_SYNTAX_THEME = {
  name: READER_SYNTAX_THEME_NAME,
  appearance: "light",
  // Token types without a class resolve to the suffix `foreground`, which has no variable.
  cssVariables: { prefix: "--reader-", defaults: { foreground: "var(--reader-text)" } },
  style: {
    "editor.foreground": "text",
    "editor.background": "code-bg",
    syntax: Object.fromEntries(
      Object.entries(SYNTAX_CLASSES).map(([tokenType, syntaxClass]) => [
        tokenType,
        `syntax-${syntaxClass}`,
      ]),
    ),
  },
} satisfies NonNullable<DiffsTheme["zed"]>;
