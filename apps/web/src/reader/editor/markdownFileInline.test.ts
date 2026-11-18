import { describe, expect, it } from "vite-plus/test";

import {
  analyzeLeafInline,
  type EditableLeafKind,
  type MarkdownDefinition,
} from "./markdownFileInline";

const options = { math: true };

/** Each range as the text it covers, so rows read as the source they describe. */
function show(
  text: string,
  kind: EditableLeafKind = "paragraph",
  definitions: ReadonlyArray<MarkdownDefinition> = DEFINITIONS,
) {
  const analysis = analyzeLeafInline(text, kind, definitions, options);
  const slice = (range: { from: number; to: number }) => text.slice(range.from, range.to);
  return {
    styles: analysis.styles.map(
      (style) =>
        `${style.kind} ${slice(style)} > ${text.slice(style.innerFrom, style.innerTo)}${style.href === null ? "" : ` ${style.href}`}`,
    ),
    markers: analysis.markers.map(
      (marker) => `${slice(marker)}${marker.style === -1 ? "" : ` ${marker.style}`}`,
    ),
    collapsed: analysis.collapsed.map((range) => JSON.stringify(slice(range))),
    breaks: analysis.breaks.map((lineBreak) => `${lineBreak.at}${lineBreak.hard ? " hard" : ""}`),
    kindMismatch: analysis.kindMismatch,
  };
}

const DEFINITIONS = [
  { identifier: "ref", label: "Ref", url: "https://e.com", title: "T", footnote: false },
];

describe("analyzeLeafInline", () => {
  it("finds styles with their markers", () => {
    expect(show("**b** _i_ `c` ~~d~~ ==m== x^2^ H~2~O")).toMatchObject({
      styles: [
        "strong **b** > b",
        "em _i_ > i",
        "code `c` > c",
        "del ~~d~~ > d",
        "mark ==m== > m",
        "sup ^2^ > 2",
        "sub ~2~ > 2",
      ],
      markers: [
        "** 0",
        "** 0",
        "_ 1",
        "_ 1",
        "` 2",
        "` 2",
        "~~ 3",
        "~~ 3",
        "== 4",
        "== 4",
        "^ 5",
        "^ 5",
        "~ 6",
        "~ 6",
      ],
    });
  });

  it("finds links of every kind, resolving references", () => {
    expect(show("[a](u) <https://b.c> www.d.e [x][ref] [Ref]").styles).toEqual([
      "a [a](u) > a u",
      "a <https://b.c> > https://b.c https://b.c",
      "a www.d.e > www.d.e http://www.d.e",
      "a [x][ref] > x https://e.com",
      "a [Ref] > Ref https://e.com",
    ]);
    expect(show("[x][ref]", "paragraph", []).styles).toEqual([]);
    const footnote = { identifier: "1", label: "1", url: "", title: null, footnote: true };
    expect(show("1 [Ref]", "paragraph", [footnote, ...DEFINITIONS]).styles).toEqual([
      "a [Ref] > Ref https://e.com",
    ]);
  });

  it("marks escapes, backslash breaks and code padding", () => {
    expect(show("\\* a\\\nb `` `x` ``")).toMatchObject({
      // The padding space a code span strips belongs to its marker.
      markers: ["\\", "\\", "``  0", " `` 0"],
      breaks: ["5 hard"],
    });
    expect(show("`` `x` ``").styles).toEqual(["code `` `x` `` > `x`"]);
  });

  it("collapses whitespace the reader does not show", () => {
    expect(show("a  b\tc \n  d  \ne")).toMatchObject({
      collapsed: ['"  "', '"\\t"', '" \\n  "', '"  "'],
      breaks: ["7", "13 hard"],
    });
    expect(show("a  \n  b").collapsed).toEqual(['"  "', '"  "']);
    expect(show("`a\nb`").collapsed).toEqual(['"\\n"']);
  });

  it.each([
    ["paragraph", "# not a paragraph", true],
    ["paragraph", "- a list", true],
    ["paragraph", "text ![img](a.png)", true],
    ["paragraph", "a &amp; b", true],
    ["paragraph", "a \\&amp; b", false],
    ["paragraph", "#hashtag", false],
    ["heading", "1. Intro", false],
    ["setext", "Title", false],
    ["setext", "", true],
    ["task", "### stays text", false],
  ] as const)("kindMismatch for a %s %j is %s", (kind, text, mismatch) => {
    expect(show(text, kind).kindMismatch).toBe(mismatch);
  });
});
