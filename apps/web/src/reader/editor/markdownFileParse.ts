import {
  markdownFrontmatterEnd,
  maskMarkdownFrontmatter,
} from "@t3tools/shared/markdownFrontmatter";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Blockquote, List, ListItem, PhrasingContent, RootContent } from "mdast";

import {
  analyzeInlineTree,
  collectDefinitions,
  definitionLookup,
  type DefinitionLookup,
  definitionsSuffix,
  editableLeafKind,
  InlinePacker,
  inlineBlocker,
  type MarkdownDefinition,
  rememberInlineAnalysis,
  unpackInlineAnalyses,
} from "./markdownFileInline";
import { markdownFileSchema, type RawBlockKind } from "./markdownFileSchema";
import { type MarkdownSyntaxOptions, parseMarkdownSyntax } from "./markdownFileSyntax";

export interface MarkdownFileJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: MarkdownFileJSON[];
  text?: string;
}

export interface MarkdownFileParseOptions extends MarkdownSyntaxOptions {
  /** False for a region that does not start the file: front matter only leads a file. */
  readonly frontmatter?: boolean;
  /** False for a region, which starts past the file's byte order mark: a U+FEFF there is text. */
  readonly bom?: boolean;
  /** Definitions from outside the parsed source, so its references resolve as in the file. */
  readonly definitions?: ReadonlyArray<MarkdownDefinition>;
}

export interface MarkdownFileParse {
  readonly doc: MarkdownFileJSON;
  /** Inline analyses of the paragraphs and headings, in document order (markdownFileInline). */
  readonly inline: Int32Array;
  readonly strings: ReadonlyArray<string>;
  /** Definitions the source itself holds. */
  readonly definitions: ReadonlyArray<MarkdownDefinition>;
  /** An unclosed block at the end left `options.definitions` out, so references may not resolve. */
  readonly definitionsDropped: boolean;
}

type Container =
  | { readonly kind: "quote" }
  | {
      readonly kind: "item";
      /** Columns of indentation a later line needs to stay in the item. */
      readonly width: number;
      /** The item's first line, where its marker stands in for the indentation. */
      readonly lineStart: number;
      readonly contentStart: number;
    }
  | { readonly kind: "fence"; readonly indent: number };

interface Leaf {
  readonly attrs: Record<string, unknown>;
  readonly lineStart: number;
  readonly contentStart: number;
  readonly contentEnd: number;
}

// The pattern remarkGithubAlerts reads, which turns the quote into an alert box.
const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])/;
const FENCE = /^(`{3,}|~{3,})/;

const advance = (column: number, char: string | undefined) =>
  char === "\t" ? column + 4 - (column % 4) : column + 1;

function isAlert(node: Blockquote) {
  const paragraph = node.children[0];
  const first = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
  if (first?.type !== "text") return false;
  const match = GITHUB_ALERT_MARKER.exec(first.value);
  if (!match) return false;
  return (
    first.value.length > match[0].length ||
    match[0].endsWith("\n") ||
    paragraph!.type !== "paragraph" ||
    paragraph.children.length === 1
  );
}

function listLoose(list: List) {
  return (
    list.spread === true || list.children.some((item) => item.spread ?? item.children.length > 1)
  );
}

/** What a new line takes to stay in the containers. */
function newLinePrefix(stack: ReadonlyArray<Container>) {
  let prefix = "";
  for (const container of stack) {
    if (container.kind === "quote") prefix += "> ";
    else prefix += " ".repeat(container.kind === "item" ? container.width : container.indent);
  }
  return prefix;
}

class FileParser {
  readonly leaves: Leaf[] = [];
  readonly packer = new InlinePacker();
  straddles = false;

  constructor(
    /** The source, without a byte order mark. */
    private readonly text: string,
    /** Offsets at or past this belong to appended definitions. */
    private readonly limit: number,
    private readonly definitions: DefinitionLookup,
  ) {}

  private lineStartOf(offset: number) {
    const text = this.text;
    let at = offset;
    while (at > 0 && text[at - 1] !== "\n" && text[at - 1] !== "\r") at--;
    return at;
  }

  private lineEndOf(offset: number) {
    const text = this.text;
    let at = offset;
    while (at < text.length && text[at] !== "\n" && text[at] !== "\r") at++;
    return at;
  }

  private columnOf(lineStart: number, offset: number) {
    let column = 0;
    for (let at = lineStart; at < offset; at++) column = advance(column, this.text[at]);
    return column;
  }

  /** End of the container prefix on the line starting at `lineStart`. */
  private stripPrefix(lineStart: number, stack: ReadonlyArray<Container>) {
    const text = this.text;
    const lineEnd = this.lineEndOf(lineStart);
    let at = lineStart;
    let column = 0;
    for (const container of stack) {
      if (container.kind === "quote") {
        let spaces = 0;
        while (spaces < 3 && text[at + spaces] === " ") spaces++;
        if (text[at + spaces] !== ">") return at;
        at += spaces + 1;
        column += spaces + 1;
        if (text[at] === " ") {
          at++;
          column++;
        }
      } else if (container.kind === "item") {
        if (lineStart === container.lineStart) {
          while (at < container.contentStart) column = advance(column, text[at++]);
          continue;
        }
        const from = column;
        while (at < lineEnd && (text[at] === " " || text[at] === "\t")) {
          const next = advance(column, text[at]);
          // A tab that crosses the content column stays in the content.
          if (next - from > container.width) break;
          at++;
          column = next;
        }
        // A lazy continuation line has no further prefixes.
        if (column - from < container.width && at < lineEnd) return at;
      } else {
        for (let spaces = 0; spaces < container.indent && text[at] === " "; spaces++) at++;
      }
    }
    return at;
  }

  private itemContainer(item: ListItem, stack: ReadonlyArray<Container>): Container {
    const text = this.text;
    const start = item.position!.start.offset!;
    const lineStart = this.lineStartOf(start);
    const outerColumn = this.columnOf(lineStart, this.stripPrefix(lineStart, stack));
    const markerEnd = start + (LIST_MARKER.exec(text.slice(start, start + 11))?.[0].length ?? 1);
    const markerColumn = this.columnOf(lineStart, markerEnd);
    let at = markerEnd;
    let column = markerColumn;
    while (text[at] === " " || text[at] === "\t") column = advance(column, text[at++]);
    // CommonMark: one to four columns of padding, otherwise the content sits one column past
    // the marker (a blank first line, or indented code).
    const padded = at < this.lineEndOf(markerEnd) && column - markerColumn <= 4;
    return {
      kind: "item",
      width: (padded ? column : markerColumn + 1) - outerColumn,
      lineStart,
      contentStart: padded ? at : markerEnd + (text[markerEnd] === " " ? 1 : 0),
    };
  }

  /** A leaf over `[contentStart, contentEnd)`, with a prefix atom at each later line's start. */
  private leaf(
    type: string,
    attrs: Record<string, unknown>,
    nodeStart: number,
    contentStart: number,
    contentEnd: number,
    stack: ReadonlyArray<Container>,
  ): { json: MarkdownFileJSON; textOf: (offset: number) => number; leafText: string } {
    const text = this.text;
    const end = Math.min(contentEnd, this.limit);
    if (contentEnd > this.limit) this.straddles = true;
    const content: MarkdownFileJSON[] = [];
    const prefixes: Array<readonly [number, number]> = [];
    let leafText = "";
    let at = contentStart;
    const pushText = (to: number) => {
      if (to <= at) return;
      const value = text.slice(at, to);
      content.push({ type: "text", text: value });
      leafText += value;
    };
    for (let index = contentStart; index < end; index++) {
      const char = text[index];
      if (char !== "\n" && !(char === "\r" && text[index + 1] !== "\n")) continue;
      const lineStart = index + 1;
      if (lineStart >= end) break;
      const prefixEnd = Math.min(this.stripPrefix(lineStart, stack), end);
      if (prefixEnd === lineStart) continue;
      pushText(lineStart);
      content.push({ type: "linePrefix", attrs: { text: text.slice(lineStart, prefixEnd) } });
      prefixes.push([lineStart, prefixEnd]);
      at = prefixEnd;
      index = prefixEnd - 1;
    }
    pushText(end);
    const fullAttrs = { before: "", after: "", ...attrs };
    this.leaves.push({
      attrs: fullAttrs,
      lineStart: this.lineStartOf(nodeStart),
      contentStart,
      contentEnd: end,
    });
    const textOf = (offset: number) => {
      let removed = 0;
      for (const [from, to] of prefixes) {
        if (to <= offset) removed += to - from;
        else if (from < offset) removed += offset - from;
        else break;
      }
      return offset - contentStart - removed;
    };
    return { json: { type, attrs: fullAttrs, content }, textOf, leafText };
  }

  private raw(
    kind: RawBlockKind,
    node: RootContent,
    stack: ReadonlyArray<Container>,
    start = node.position!.start.offset!,
  ) {
    let end = node.position!.end.offset!;
    // A footnote definition can end past a line ending, inside the next line's container prefix.
    const lineStart = this.lineStartOf(end);
    if (lineStart > start && end <= this.stripPrefix(lineStart, stack)) {
      end =
        lineStart -
        (this.text[lineStart - 1] === "\n" && this.text[lineStart - 2] === "\r" ? 2 : 1);
    }
    return this.leaf("rawBlock", { kind }, start, start, Math.max(start, end), stack).json;
  }

  private inlineLeaf(
    type: "paragraph" | "heading",
    attrs: Record<string, unknown>,
    nodeStart: number,
    contentStart: number,
    contentEnd: number,
    children: ReadonlyArray<PhrasingContent>,
    stack: ReadonlyArray<Container>,
  ) {
    const { json, textOf, leafText } = this.leaf(
      type,
      attrs,
      nodeStart,
      contentStart,
      contentEnd,
      stack,
    );
    this.packer.push(
      analyzeInlineTree(children, {
        text: leafText,
        toLeaf: textOf,
        definitions: this.definitions,
      }),
    );
    return json;
  }

  frontmatter(end: number) {
    return this.leaf("rawBlock", { kind: "frontmatter" }, 0, 0, end, []).json;
  }

  private emptyParagraph(at: number, stack: ReadonlyArray<Container>, flow: boolean) {
    return this.inlineLeaf("paragraph", { flow }, at, at, at, [], stack);
  }

  blocks(
    nodes: ReadonlyArray<RootContent>,
    stack: ReadonlyArray<Container>,
    flow: boolean,
  ): MarkdownFileJSON[] {
    const out: MarkdownFileJSON[] = [];
    for (const node of nodes) {
      if (node.position!.start.offset! >= this.limit) break;
      out.push(this.block(node, stack, flow));
    }
    return out;
  }

  private block(
    node: RootContent,
    stack: ReadonlyArray<Container>,
    flow: boolean,
  ): MarkdownFileJSON {
    const text = this.text;
    const start = node.position!.start.offset!;
    const end = node.position!.end.offset!;
    switch (node.type) {
      case "paragraph":
      case "heading": {
        const first = node.children[0];
        const last = node.children.at(-1);
        const setext = node.type === "heading" && /[\r\n]/.test(text.slice(start, end));
        // A setext heading after a definition starts, in micromark's positions, at the definition.
        const textStart = setext ? first?.position?.start.offset : undefined;
        const blocker = inlineBlocker(node.children, text);
        if (blocker) {
          return this.raw(blocker, node, stack, Math.max(start, textStart ?? start));
        }
        const headingStart =
          textStart === undefined ? start : Math.max(start, this.lineStartOf(textStart));
        if (node.type === "paragraph") {
          return this.inlineLeaf(
            "paragraph",
            { flow },
            start,
            first!.position!.start.offset!,
            last!.position!.end.offset!,
            node.children,
            stack,
          );
        }
        const empty =
          start + (/^#{1,6}[ \t]*/.exec(text.slice(start, start + 64))?.[0].length ?? 0);
        return this.inlineLeaf(
          "heading",
          { level: node.depth, setext },
          headingStart,
          first ? first.position!.start.offset! : empty,
          last ? last.position!.end.offset! : empty,
          node.children,
          stack,
        );
      }
      case "code": {
        const fence = FENCE.exec(text.slice(start, start + 3));
        if (!fence) return this.raw("indentedCode", node, stack);
        if (node.lang?.toLowerCase() === "mermaid") return this.raw("mermaid", node, stack);
        return this.codeBlock(start, end, stack);
      }
      case "thematicBreak":
        return this.leaf("horizontalRule", {}, start, end, end, stack).json;
      case "blockquote": {
        if (isAlert(node)) return this.raw("alert", node, stack);
        const inner = [...stack, { kind: "quote" } as const];
        const content = this.blocks(node.children, inner, false);
        return {
          type: "blockquote",
          content: content.length > 0 ? content : [this.emptyParagraph(end, inner, false)],
        };
      }
      case "list": {
        const tight = !listLoose(node);
        const content = node.children.map((item) => {
          const inner = [...stack, this.itemContainer(item, stack)];
          const itemEnd = item.position!.end.offset!;
          const children = this.blocks(item.children, inner, tight);
          return {
            type: "listItem",
            attrs: {
              checked: item.checked ?? null,
              label:
                LIST_MARKER.exec(
                  text.slice(item.position!.start.offset!, item.position!.start.offset! + 11),
                )?.[0] ?? "",
            },
            content: children.length > 0 ? children : [this.emptyParagraph(itemEnd, inner, tight)],
          };
        });
        const task = node.children.some((item) => typeof item.checked === "boolean");
        return {
          type: node.ordered ? "orderedList" : "bulletList",
          attrs: node.ordered ? { tight, task, start: node.start ?? 1 } : { tight, task },
          content,
        };
      }
      case "table":
        return this.raw("table", node, stack);
      case "html":
        return this.raw("html", node, stack);
      case "math":
        return this.raw("math", node, stack);
      case "footnoteDefinition":
        return this.raw("footnote", node, stack);
      case "definition":
        return this.raw("definition", node, stack);
      default:
        return this.raw(
          node.type === "leafDirective" || node.type === "containerDirective"
            ? "directive"
            : "other",
          node,
          stack,
        );
    }
  }

  /**
   * A fence's bytes: the opening line in `before`, the closing line in `after`, and the lines
   * between as content, with the fence indent stripped as part of each line's prefix.
   */
  private codeBlock(start: number, nodeEnd: number, stack: ReadonlyArray<Container>) {
    const text = this.text;
    const end = Math.min(nodeEnd, this.limit);
    if (nodeEnd > this.limit) this.straddles = true;
    const fence = FENCE.exec(text.slice(start, this.lineEndOf(start)))![1]!;
    const openingEnd = this.lineEndOf(start);
    const info = text.slice(start + fence.length, openingEnd);
    const indent = start - this.stripPrefix(this.lineStartOf(start), stack);
    const inner = [...stack, { kind: "fence", indent: Math.max(0, indent) } as const];
    const lineStarts: number[] = [];
    for (let at = openingEnd; at < end;) {
      at += text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1;
      if (at >= end) break;
      lineStarts.push(at);
      at = this.lineEndOf(at);
    }
    const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    const last = lineStarts.at(-1);
    const closed =
      last !== undefined &&
      closing.test(text.slice(this.stripPrefix(last, stack), this.lineEndOf(last)));
    const contentLines = closed ? lineStarts.slice(0, -1) : lineStarts;
    const firstLine = contentLines[0];
    const lastLine = contentLines.at(-1);
    const contentStart =
      firstLine === undefined
        ? closed
          ? this.stripPrefix(last!, inner)
          : end
        : Math.min(this.stripPrefix(firstLine, inner), this.lineEndOf(firstLine));
    const contentEnd = lastLine === undefined ? contentStart : this.lineEndOf(lastLine);
    // A fence with no content line has nowhere to type: text would join a fence line.
    const ending = /^(?:\r\n|\r|\n)/.exec(text.slice(openingEnd, openingEnd + 2))?.[0] ?? "\n";
    let fillBefore = "";
    let fillAfter = "";
    if (firstLine === undefined && closed) {
      fillAfter = ending + text.slice(last!, contentStart);
    } else if (firstLine === undefined && contentStart === openingEnd) {
      fillBefore = ending + newLinePrefix(inner);
    }
    return this.leaf(
      "codeBlock",
      { info, fillBefore, fillAfter },
      start,
      contentStart,
      Math.max(contentStart, contentEnd),
      inner,
    ).json;
  }
}

function parseText(
  text: string,
  input: string,
  options: MarkdownFileParseOptions,
  frontmatterEnd: number,
) {
  const tree = parseMarkdownSyntax(input, options);
  const own = collectDefinitions(tree, text.length);
  const parser = new FileParser(
    text,
    text.length,
    definitionLookup([...own, ...(options.definitions ?? [])]),
  );
  const content: MarkdownFileJSON[] = [];
  if (frontmatterEnd > 0) {
    content.push(parser.frontmatter(frontmatterEnd));
  }
  content.push(...parser.blocks(tree.children, [], false));
  return { parser, content, definitions: own };
}

export function parseMarkdownFile(
  source: string,
  options: MarkdownFileParseOptions,
): MarkdownFileParse {
  const bom = options.bom !== false && source.charCodeAt(0) === 0xfeff;
  const text = bom ? source.slice(1) : source;
  const lineEnding = /\r\n|\r|\n/.exec(text)?.[0] === "\r\n" ? "\r\n" : "\n";
  const frontmatterEnd = options.frontmatter === false ? 0 : markdownFrontmatterEnd(text);
  const masked = frontmatterEnd > 0 ? maskMarkdownFrontmatter(text) : text;
  const suffix = definitionsSuffix(masked, options.definitions ?? []);
  let parsed = parseText(text, masked + suffix, options, frontmatterEnd);
  // An unclosed block at the end swallowed the appended definitions; parse without them.
  const definitionsDropped = parsed.parser.straddles;
  if (definitionsDropped) parsed = parseText(text, masked, options, frontmatterEnd);
  const { parser, content } = parsed;
  const leaves = parser.leaves;

  let lead = text;
  if (leaves.length === 0) {
    parser.packer.push({ styles: [], markers: [], collapsed: [], breaks: [] });
    content.push({ type: "paragraph", attrs: { before: "", after: "", flow: false }, content: [] });
  } else {
    lead = text.slice(0, leaves[0]!.lineStart);
    leaves.forEach((leaf, index) => {
      const next = leaves[index + 1];
      const nextStart = next ? next.lineStart : text.length;
      if (
        leaf.lineStart > leaf.contentStart ||
        leaf.contentStart > leaf.contentEnd ||
        leaf.contentEnd > nextStart
      ) {
        // The round-trip guard shows the read-only view instead.
        throw new Error(`Markdown leaves overlap near offset ${leaf.contentStart}`);
      }
      leaf.attrs.before = text.slice(leaf.lineStart, leaf.contentStart);
      leaf.attrs.after = text.slice(leaf.contentEnd, nextStart);
    });
  }
  return {
    doc: { type: "doc", attrs: { bom, lead, lineEnding }, content },
    inline: parser.packer.finish(),
    strings: parser.packer.strings,
    definitions: parsed.definitions,
    definitionsDropped,
  };
}

const parsedDefinitionLeaves = new WeakSet<ProseMirrorNode>();

/**
 * Whether this definition or footnote leaf came from a parse: one edited as source since is a
 * new node, whose definitions the rest of the document has not seen yet.
 */
export const isParsedDefinitionLeaf = (node: ProseMirrorNode) => parsedDefinitionLeaves.has(node);

const isDefinitionLeaf = (node: ProseMirrorNode) =>
  node.type.name === "rawBlock" &&
  (node.attrs.kind === "definition" || node.attrs.kind === "footnote");

/** Marks the definition leaves in `node` as matching a parse, as a kept equal node does. */
export function rememberParsedDefinitions(node: ProseMirrorNode) {
  if (isDefinitionLeaf(node)) parsedDefinitionLeaves.add(node);
  node.descendants((child) => {
    if (isDefinitionLeaf(child)) parsedDefinitionLeaves.add(child);
    return !child.isTextblock;
  });
}

/** The document node, with each paragraph's and heading's inline analysis remembered. */
export function buildMarkdownFileDoc(parse: MarkdownFileParse): ProseMirrorNode {
  const doc = markdownFileSchema.nodeFromJSON(parse.doc);
  const analyses = unpackInlineAnalyses(parse.inline, parse.strings);
  let index = 0;
  doc.descendants((node) => {
    if (isDefinitionLeaf(node)) parsedDefinitionLeaves.add(node);
    if (editableLeafKind(node)) {
      const analysis = analyses[index++];
      if (analysis) rememberInlineAnalysis(node, analysis);
      return false;
    }
    return !node.isTextblock;
  });
  return doc;
}
