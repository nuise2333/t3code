import { getSchema, Node } from "@tiptap/core";

export type RawBlockKind =
  | "table"
  | "html"
  | "math"
  | "mermaid"
  | "footnote"
  | "definition"
  | "frontmatter"
  | "indentedCode"
  | "alert"
  | "directive"
  | "other";

// Attributes are never written to the DOM: the reader's markup is drawn from the node type, and
// `before`/`after` are source bytes, not display data.
const attr = <T>(fallback: T) => ({ default: fallback, rendered: false });
const leafBytes = { before: attr(""), after: attr("") };

const MarkdownDoc = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",
  addAttributes: () => ({ bom: attr(false), lead: attr(""), lineEnding: attr("\n") }),
});

const MarkdownText = Node.create({ name: "text", group: "inline" });

const MarkdownLinePrefix = Node.create({
  name: "linePrefix",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ text: attr("") }),
  parseHTML: () => [{ tag: "span[data-md-prefix]" }],
  renderHTML: () => ["span", { "data-md-prefix": "", contenteditable: "false" }],
});

const MarkdownParagraph = Node.create({
  name: "paragraph",
  group: "block",
  content: "(text | linePrefix)*",
  marks: "",
  // The text is the source: typing re-reads the DOM, which must keep its line ends.
  whitespace: "pre",
  addAttributes: () => ({
    ...leafBytes,
    flow: attr(false),
    // The continuation prefix of an empty paragraph Enter made, which owns no bytes yet.
    transient: attr<string | null>(null),
  }),
  parseHTML: () => [{ tag: "p" }],
  renderHTML: ({ node }) => (node.attrs.flow ? ["span", { class: "reader-flow" }, 0] : ["p", 0]),
});

const MarkdownHeading = Node.create({
  name: "heading",
  group: "block",
  content: "(text | linePrefix)*",
  marks: "",
  whitespace: "pre",
  defining: true,
  addAttributes: () => ({ ...leafBytes, level: attr(1), setext: attr(false) }),
  parseHTML: () => [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
  renderHTML: ({ node }) => [`h${node.attrs.level}`, 0],
});

const MarkdownCodeBlock = Node.create({
  name: "codeBlock",
  group: "block",
  content: "(text | linePrefix)*",
  marks: "",
  code: true,
  defining: true,
  addAttributes: () => ({
    ...leafBytes,
    info: attr(""),
    // A fence with no content line: the line ending (and container prefix) its first typed
    // text needs before or after it, written only while the content is not empty.
    fillBefore: attr(""),
    fillAfter: attr(""),
  }),
  parseHTML: () => [{ tag: "pre", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", ["code", 0]],
});

const MarkdownRawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  content: "(text | linePrefix)*",
  marks: "",
  code: true,
  defining: true,
  addAttributes: () => ({ ...leafBytes, kind: attr<RawBlockKind>("other") }),
  parseHTML: () => [{ tag: "div.reader-raw", preserveWhitespace: "full" }],
  renderHTML: () => ["div", { class: "reader-raw" }, ["pre", { "data-md-raw-source": "" }, 0]],
});

const MarkdownHorizontalRule = Node.create({
  name: "horizontalRule",
  group: "block",
  atom: true,
  addAttributes: () => leafBytes,
  parseHTML: () => [{ tag: "hr" }],
  renderHTML: () => ["hr"],
});

const MarkdownBlockquote = Node.create({
  name: "blockquote",
  group: "block",
  content: "block+",
  defining: true,
  parseHTML: () => [{ tag: "blockquote" }],
  renderHTML: () => ["blockquote", 0],
});

const MarkdownBulletList = Node.create({
  name: "bulletList",
  group: "block",
  content: "listItem+",
  addAttributes: () => ({ tight: attr(true), task: attr(false) }),
  parseHTML: () => [{ tag: "ul" }],
  renderHTML: ({ node }) => ["ul", node.attrs.task ? { class: "contains-task-list" } : {}, 0],
});

const MarkdownOrderedList = Node.create({
  name: "orderedList",
  group: "block",
  content: "listItem+",
  addAttributes: () => ({ tight: attr(true), task: attr(false), start: attr(1) }),
  parseHTML: () => [{ tag: "ol" }],
  renderHTML: ({ node }) => [
    "ol",
    {
      ...(node.attrs.start === 1 ? {} : { start: node.attrs.start }),
      ...(node.attrs.task ? { class: "contains-task-list" } : {}),
    },
    0,
  ],
});

const MarkdownListItem = Node.create({
  name: "listItem",
  content: "block+",
  defining: true,
  addAttributes: () => ({ checked: attr<boolean | null>(null), label: attr("") }),
  parseHTML: () => [{ tag: "li" }],
  renderHTML: ({ node }) => [
    "li",
    node.attrs.checked === null ? {} : { class: "task-list-item" },
    0,
  ],
});

/** Pure nodes, without node views; the editor extends them. */
const markdownFileNodes = [
  MarkdownDoc,
  MarkdownText,
  MarkdownLinePrefix,
  MarkdownParagraph,
  MarkdownHeading,
  MarkdownCodeBlock,
  MarkdownRawBlock,
  MarkdownHorizontalRule,
  MarkdownBlockquote,
  MarkdownBulletList,
  MarkdownOrderedList,
  MarkdownListItem,
];

export const markdownFileSchema = getSchema(markdownFileNodes);
