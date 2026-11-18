import { describe, expect, it } from "vite-plus/test";

import { readerSyntaxClass } from "./readerSyntaxTheme";

describe("readerSyntaxClass", () => {
  it.each([
    ["keyword.control", "keyword"],
    ["preproc", "keyword"],
    ["string.escape", "string"],
    ["string.regex", "string"],
    ["property.json_key", "string"],
    ["comment.doc", "comment"],
    ["number", "literal"],
    ["boolean", "literal"],
    ["constant.builtin", "literal"],
    ["type.builtin", "type"],
    ["enum", "type"],
    ["constant", null],
    ["property", null],
    ["function.method", null],
    ["operator", null],
    ["punctuation.bracket", null],
    ["tag", null],
    ["attribute", null],
    ["variable.special", null],
  ])("%s is %s", (tokenType, syntaxClass) => {
    expect(readerSyntaxClass(tokenType)).toBe(syntaxClass);
  });
});
