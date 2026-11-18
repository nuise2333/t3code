import { assert, describe, it } from "vite-plus/test";

import { paperForLocale, readerPrintPageRule, readerPrintTitle } from "./readerPrint";

describe("paperForLocale", () => {
  it("picks US Letter where it is the usual paper and A4 elsewhere", () => {
    assert.strictEqual(paperForLocale("en-US"), "letter");
    assert.strictEqual(paperForLocale("en"), "letter");
    assert.strictEqual(paperForLocale("fr-CA"), "letter");
    assert.strictEqual(paperForLocale("es-MX"), "letter");
    assert.strictEqual(paperForLocale("en-GB"), "A4");
    assert.strictEqual(paperForLocale("zh-CN"), "A4");
    assert.strictEqual(paperForLocale("not a locale!"), "A4");
    assert.strictEqual(readerPrintPageRule("A4"), "@page { size: A4; margin: 72pt; }");
  });
});

describe("readerPrintTitle", () => {
  it("names the export after the file, without its folder or Markdown extension", () => {
    assert.strictEqual(readerPrintTitle("docs/guide/intro.md"), "intro");
    assert.strictEqual(readerPrintTitle("C:\\notes\\Plan.markdown"), "Plan");
    assert.strictEqual(readerPrintTitle("release.v2.mdx"), "release.v2");
    assert.strictEqual(readerPrintTitle(""), "Document");
  });
});
