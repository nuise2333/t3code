// @effect-diagnostics nodeBuiltinImport:off - the round-trip corpus is the repo's Markdown on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Nodes, RootContent } from "mdast";
import { describe, expect, it } from "vite-plus/test";

import {
  analyzeLeafInline,
  editableLeafKind,
  inlineAnalysisFor,
  inlineBlocker,
  leafParseInput,
} from "./markdownFileInline";
import { buildMarkdownFileDoc, parseMarkdownFile } from "./markdownFileParse";
import {
  leafText,
  posAtSourceOffset,
  serializeMarkdownFile,
  sourceOffsetAt,
} from "./markdownFileSerialize";
import { parseMarkdownSyntax } from "./markdownFileSyntax";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../../..",
);

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".repos", ".t3", "dist", ".plans"]);

function markdownFiles(directory: string, include: (name: string) => boolean): string[] {
  if (!NodeFS.existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...markdownFiles(path, include));
    } else if (include(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

// The fixtures directory is git-excluded: CI covers docs and the cases below, local runs add it.
const CORPUS = [
  ...new Set([
    ...markdownFiles(NodePath.join(repoRoot, "docs"), (name) => name.endsWith(".md")),
    ...markdownFiles(NodePath.join(repoRoot, "apps/server/reader-fixtures"), (name) =>
      name.endsWith(".md"),
    ),
    ...["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"]
      .map((name) => NodePath.join(repoRoot, name))
      .filter((path) => NodeFS.existsSync(path)),
    ...markdownFiles(repoRoot, (name) => name === "AGENTS.md"),
  ]),
].map((path) => NodePath.relative(repoRoot, path));

const CASES: ReadonlyArray<readonly [name: string, source: string]> = [
  ["CRLF", "# Title\r\n\r\nOne\r\ntwo\r\n\r\n- a\r\n- b\r\n"],
  ["lone CR", "a\rb\r\rc"],
  ["BOM", "\uFEFF# Title\n\ntext\n"],
  ["BOM and front matter", "\uFEFF---\ntitle: x\n---\nbody\n"],
  ["tabs and partial tabs", "-\tfoo\n\n\tbar\n\n>\tquoted\n\n  -\ttab\n   \tpartial\n"],
  ["trailing spaces", "a   \nb \n\nc  "],
  ["both hard breaks", "a  \nb\\\nc\n"],
  ["no trailing newline", "para"],
  ["empty file", ""],
  ["whitespace-only file", "  \n\t\n \n"],
  ["lazy continuation", "> a\nlazy\n\n- b\nlazy too\n"],
  ["setext with an over-long underline", "Title\n=============\n\nSub\n---\n"],
  [
    "setext kept as source after a definition",
    "[a]: /x\nA&amp;b\n===\n\n> [b]: /y\n> B<i>x</i>\n> ---\n",
  ],
  ["closing ATX hashes", "# A #\n## B ##   \n### C \\#\n#\n## \n"],
  [
    "nested quotes and lists to depth 4",
    "> - a\n>   > 1. b\n>   >    - [ ] c\n>   >      more\n>   >\n>   >      para\n",
  ],
  ["loose and tight lists", "- a\n- b\n\n1. c\n\n2. d\n"],
  ["plus and paren markers", "+ a\n+ b\n\n1) c\n2) d\n"],
  ["task boxes", "- [ ] a\n- [x] b\n- [X] c\n"],
  ["unclosed fence", "text\n\n```js\nconst a = 1;\n\nmore\n"],
  ["tilde fences", "~~~py\nprint(1)\n~~~\n\n~~~~\n~~~\n~~~~\n"],
  ["fences in lists and quotes", "- a\n\n  ```ts\n  x\n\n  y\n  ```\n\n> ```\n> q\n> ```\n"],
  ["indented fence", "  ```\n  a\n b\nc\n  ```\n"],
  ["empty fences", "```\n```\n\n```\n\n```\n"],
  ["indented code", "    code\n    more\n\nend\n"],
  ["HTML blocks and comments", "<div>\nx\n</div>\n\n<!-- c -->\nfoo <b>bold</b>\n"],
  ["tables in lists", "- | a | b |\n  |---|---|\n  | 1 | 2 |\n"],
  ["math", "$$\nx^2\n$$\n\nInline $a$ math.\n"],
  ["mermaid", "```mermaid\ngraph TD\nA-->B\n```\n"],
  ["footnotes", "Text[^1].\n\n[^1]: Note\n    more\n"],
  ["reference definitions", '[a][ref] and [ref] and [b][]\n\n[ref]: https://e.com "T"\n[b]: /b\n'],
  ["YAML front matter", "---\ntitle: x\nlist:\n  - a\n---\n# Body\n"],
  ["TOML front matter", "+++\ntitle = 'x'\n+++\n\nBody\n"],
  ["entities", "a &amp; b &copy; &notanentity; \\&amp;\n"],
  ["escapes", "\\*not em\\* \\\\ \\# \\[x\\]\n"],
  ["underscore emphasis", "__strong__ and _em_ and ***both***\n"],
  ["autolinks", "<https://a.b> www.c.com https://d.e/f and a@b.co\n"],
  ["alerts", "> [!NOTE]\n> Hi\n\n> [!warning] same line\n"],
  ["codex directives", "::artifact-template{x=1}\n\ntext\n"],
  ["reader inline syntax", "==mark== x^2^ H~2~O ~~del~~ `code` **b** *i* [l](u)\n"],
  ["empty containers", "-\n- x\n-\n\n>\n\n> \n"],
  ["thematic breaks", "a\n\n---\n***\n- ---\n"],
  ["images", "![alt](a.png)\n\ntext ![i](b.png) more\n"],
  ["inline code spans lines", "a `b\nc` d\n"],
  ["list item starting blank", "-\n  foo\n\n1.\n   bar\n"],
  ["over-indented list content", "-     code\n\n- a\n"],
];

interface Row {
  readonly name: string;
  readonly source: string;
}

const rows: Row[] = [
  ...CASES.map(([name, source]) => ({ name, source })),
  ...CORPUS.map((path) => ({
    name: path,
    source: NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8"),
  })),
];

function plainText(node: Nodes): string {
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map((child) => plainText(child)).join("") : "";
}

/** The full parse's editable paragraphs and headings, in the order the model keeps them. */
function editableBlocks(nodes: ReadonlyArray<RootContent>, source: string): Nodes[] {
  const found: Nodes[] = [];
  for (const node of nodes) {
    if (node.type === "paragraph" || node.type === "heading") {
      if (inlineBlocker(node.children, source) === null) found.push(node);
    } else if (node.type === "list" || node.type === "listItem") {
      found.push(...editableBlocks(node.children, source));
    } else if (node.type === "blockquote") {
      const first = node.children[0];
      const text = first?.type === "paragraph" ? first.children[0] : undefined;
      if (
        text?.type === "text" &&
        /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i.test(text.value)
      ) {
        continue;
      }
      found.push(...editableBlocks(node.children, source));
    }
  }
  return found;
}

function editableLeaves(doc: ProseMirrorNode) {
  const leaves: ProseMirrorNode[] = [];
  doc.descendants((node) => {
    if (editableLeafKind(node)) leaves.push(node);
    return !node.isTextblock;
  });
  return leaves;
}

describe("markdown file round trip", () => {
  it("covers the repo's Markdown", () => {
    expect(CORPUS.length).toBeGreaterThan(100);
  });

  it.each(rows)("$name", ({ source }) => {
    for (const math of [false, true]) {
      const parse = parseMarkdownFile(source, { math });
      const doc = buildMarkdownFileDoc(parse);
      expect(serializeMarkdownFile(doc)).toBe(source);
      if (!math) continue;

      // Each leaf parsed alone sees what the full parse saw: same text, same ranges.
      const body = source.replace(/^\uFEFF/, "");
      const tree = parseMarkdownSyntax(maskMarkdownFrontmatter(body), { math });
      const blocks = editableBlocks(tree.children, body);
      // Empty containers get a paragraph the syntax tree does not have.
      const leaves = editableLeaves(doc).filter(
        (leaf) => leaf.content.size > 0 || leaf.type.name === "heading",
      );
      expect(leaves.length).toBe(blocks.length);
      leaves.forEach((leaf, index) => {
        const kind = editableLeafKind(leaf)!;
        const text = leafText(leaf);
        const input = leafParseInput(text, kind, parse.definitions);
        const alone = parseMarkdownSyntax(input.source, { math }).children[0]!;
        const aloneBlock =
          kind === "task" && alone.type === "list" ? alone.children[0]!.children[0]! : alone;
        expect(plainText(aloneBlock)).toBe(plainText(blocks[index]!));
        const { kindMismatch, ...isolated } = analyzeLeafInline(text, kind, parse.definitions, {
          math,
        });
        expect(kindMismatch).toBe(false);
        const { kindMismatch: _, ...full } = inlineAnalysisFor(leaf, [], { math })!;
        expect(isolated).toEqual(full);
      });
    }
  });

  it.each([
    [0, 2, "in a heading's marker: its content start"],
    [3, 3, "a heading's content end"],
    [4, 3, "a blank line after: the content end above"],
    [6, 9, "in a quote and list marker"],
    [13, 13, "a line prefix's start: the end of the line above"],
    [15, 17, "inside a line prefix: its line's text"],
    [18, 18, "text after a prefix"],
    [24, 26, "a fence line: the code"],
    [31, 27, "the end of the file: the last content end"],
  ])("source offset %i maps back to %i (%s)", (offset, expected) => {
    const source = "# A\n\n> - one\n>   two\n\n```\nx\n```\n";
    const doc = buildMarkdownFileDoc(parseMarkdownFile(source, { math: false }));
    expect(sourceOffsetAt(doc, posAtSourceOffset(doc, offset))).toBe(expected);
  });
});
