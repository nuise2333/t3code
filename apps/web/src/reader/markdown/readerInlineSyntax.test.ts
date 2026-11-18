import { toHtml } from "hast-util-to-html";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { READER_REMARK_PLUGINS } from "./readerRemarkPlugins";

const processor = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(READER_REMARK_PLUGINS)
  .use(remarkRehype)
  .freeze();

const render = (markdown: string) =>
  toHtml(processor.runSync(processor.parse(markdown), markdown)).replace(/^<p>|<\/p>$/g, "");

// Expectations are what the reference reader draws for the same source, except the rows marked
// "ours", where this pipeline's parser decides first.
const CASES: ReadonlyArray<readonly [name: string, markdown: string, html: string]> = [
  [
    "mark, spaced and inside a word",
    "a ==b== c and a==b==c",
    "a <mark>b</mark> c and a<mark>b</mark>c",
  ],
  [
    "mark needs text against both delimiters",
    "a == b == c and == a== and ==a ==",
    "a == b == c and == a== and ==a ==",
  ],
  ["comparisons pair up like marks", "if a==b and c==d then", "if a<mark>b and c</mark>d then"],
  ["only runs of exactly two equals signs", "a===b===c and ====b====", "a===b===c and ====b===="],
  ["a longer run inside a mark is text", "==a====b==", "<mark>a====b</mark>"],
  ["marks nest", "==a ==b== c==", "<mark>a <mark>b</mark> c</mark>"],
  ["mark around CJK quotes", "他说==“好”==。", "他说<mark>“好”</mark>。"],
  ["mark across a soft break", "==a\nb== c", "<mark>a\nb</mark> c"],
  [
    "mark with emphasis",
    "*==a==* and ==*a*==",
    "<em><mark>a</mark></em> and <mark><em>a</em></mark>",
  ],
  ["strong closing first leaves the mark open", "**==a**==", "<strong>==a</strong>=="],
  ["mark around code", "==`c`==", "<mark><code>c</code></mark>"],
  [
    "mark in a link label, not its target",
    "[==a==](https://e.com/==x==)",
    '<a href="https://e.com/==x=="><mark>a</mark></a>',
  ],
  ["superscript", "x^2^ and a^2^b", "x<sup>2</sup> and a<sup>2</sup>b"],
  ["superscript spans spaces", "x^2 + y^2 = z^2", "x<sup>2 + y</sup>2 = z^2"],
  [
    "superscript opens before punctuation",
    "x^-1^ and x^(a)^",
    "x<sup>-1</sup> and x<sup>(a)</sup>",
  ],
  ["superscript needs text against both carets", "x^ 2^ and x^2 ^", "x^ 2^ and x^2 ^"],
  ["double caret is one superscript", "^^a^^", "<sup>a</sup>"],
  [
    "superscript around emphasis and code",
    "a^*b*^ and a^`c`^",
    "a<sup><em>b</em></sup> and a<sup><code>c</code></sup>",
  ],
  [
    "subscript",
    "H~2~O and ~a b~ and a~b c~d",
    "H<sub>2</sub>O and <sub>a b</sub> and a<sub>b c</sub>d",
  ],
  [
    "home paths are not subscripts",
    "cd ~/Projects and ~/Documents",
    "cd ~/Projects and ~/Documents",
  ],
  ["subscript does not open inside a word before punctuation", "H~.2~O", "H~.2~O"],
  ["subscript does not open inside a word before emphasis", "a~*b*~", "a~<em>b</em>~"],
  [
    "subscript opens before punctuation after a space",
    "~/a~ and ~(a)~",
    "<sub>/a</sub> and <sub>(a)</sub>",
  ],
  ["the nearest opener wins", "price ~10 and ~100~200", "price ~10 and <sub>100</sub>200"],
  ["double tilde still strikes", "~~strike~~ and ~~~a~~~", "<del>strike</del> and ~~~a~~~"],
  ["subscript inside strikethrough (ours)", "~~a~b~c~~", "<del>a<sub>b</sub>c</del>"],
  ["a failed closer blocks earlier openers", "a^2^^3^ and a~1~~2~", "a^2^^3^ and a~1~~2~"],
  ["escaped delimiters", "\\==a== and a\\^2^ and a\\~2~", "==a== and a^2^ and a~2~"],
  ["an escaped backslash does not escape", "a\\\\^2^", "a\\<sup>2</sup>"],
  [
    "inline code",
    "`==c==` and `x^2^` and `H~2~O`",
    "<code>==c==</code> and <code>x^2^</code> and <code>H~2~O</code>",
  ],
  ["inline math", "$x^2^ ~a~$", '<code class="language-math math-inline">x^2^ ~a~</code>'],
  [
    "autolinked URL (ours)",
    "https://example.com/?a==b==c",
    '<a href="https://example.com/?a==b==c">https://example.com/?a==b==c</a>',
  ],
  [
    "angle-bracket autolink",
    "<https://example.com/?a==b==c>",
    '<a href="https://example.com/?a==b==c">https://example.com/?a==b==c</a>',
  ],
];

describe("reader inline syntax", () => {
  it.each(CASES)("%s", (_, markdown, html) => {
    expect(render(markdown)).toBe(html);
  });

  it("leaves fenced code alone", () => {
    expect(render("```\n==a== x^2^ H~2~O\n```")).toBe("<pre><code>==a== x^2^ H~2~O\n</code></pre>");
  });

  it("gives created nodes source positions when their text is the source", () => {
    type Positioned = {
      type: string;
      children?: Positioned[];
      position?: { start: { offset?: number }; end: { offset?: number } };
    };
    const spans = (node: Positioned): unknown[] => [
      `${node.type}${node.position ? ` ${node.position.start.offset}-${node.position.end.offset}` : ""}`,
      ...(node.children ?? []).map(spans),
    ];
    const source = "a ==b== ~c~\n\n\\==d== ==e==";
    const syntax = unified().use(remarkParse).use(READER_REMARK_PLUGINS).freeze();
    const tree = syntax.runSync(syntax.parse(source), source) as Positioned;
    // An escape makes the value differ from the source, so the second paragraph gets none.
    expect(tree.children?.map(spans)).toEqual([
      [
        "paragraph 0-11",
        ["text 0-2"],
        ["mark 2-7", ["text 4-5"]],
        ["text 7-8"],
        ["subscript 8-11", ["text 9-10"]],
      ],
      ["paragraph 13-25", ["text"], ["mark", ["text"]]],
    ]);
  });

  it("reads escapes after a byte order mark", () => {
    expect(render("\ufeff\\==a== ==b==")).toBe("==a== <mark>b</mark>");
  });
});
