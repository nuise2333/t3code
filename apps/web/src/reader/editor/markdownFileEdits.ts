import { markdownFrontmatterEnd } from "@t3tools/shared/markdownFrontmatter";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos } from "@tiptap/pm/model";
import { type EditorState, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";

import { withInfoStringLanguage } from "~/composer-code-languages";
import {
  type ComposerListEdit,
  listContinuationForEnter,
  listIndentForTab,
  listOutdentForTab,
} from "~/composer-list-continuation";

import {
  adoptInlineAnalyses,
  collectDefinitions,
  inlineAnalysisFor,
  type InlineStyleKind,
  type MarkdownDefinition,
  rememberInlineAnalysis,
} from "./markdownFileInline";
import {
  buildMarkdownFileDoc,
  isParsedDefinitionLeaf,
  parseMarkdownFile,
  rememberParsedDefinitions,
} from "./markdownFileParse";
import { markdownFileSchema } from "./markdownFileSchema";
import {
  blockStarts,
  forEachLeaf,
  type LeafPlacement,
  leafContentSource,
  leafText,
  posAtSourceOffset,
  serializeMarkdownFile,
  sourceOffsetAt,
} from "./markdownFileSerialize";
import { type MarkdownSyntaxOptions, parseMarkdownSyntax } from "./markdownFileSyntax";

/** A change to the file's source, in offsets of the serialized file. */
export interface SourceEdit {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  /** Anchor and head in the new source. By default the current selection is mapped. */
  readonly selection?: readonly [anchor: number, head: number];
}

export interface MarkdownEditOptions extends MarkdownSyntaxOptions {
  readonly addToHistory?: boolean;
}

type Command = (state: EditorState, options: MarkdownEditOptions) => Transaction | null;

const LINE_ENDING = /\r\n|\r|\n/;
const LINE_ENDINGS = /\r\n|\r|\n/g;
// The first line ending never matches the CR of a CRLF, which would make "a\r\n" look blank.
const BLANK_LINE_BEFORE = /(?:\r\n|\r(?!\n)|\n)[ \t>]*(?:\r\n|\n|\r)$/;

const blockDefinitions = new WeakMap<ProseMirrorNode, ReadonlyArray<MarkdownDefinition>>();

// Per top-level block, so a keystroke re-reads only the block it changed.
function definitionsIn(block: ProseMirrorNode, options: MarkdownSyntaxOptions) {
  let found = blockDefinitions.get(block);
  if (!found) {
    const list: MarkdownDefinition[] = [];
    const visit = (node: ProseMirrorNode) => {
      const kind = node.type.name === "rawBlock" ? node.attrs.kind : null;
      if (kind === "definition" || kind === "footnote") {
        list.push(...collectDefinitions(parseMarkdownSyntax(leafText(node), options)));
      }
      if (!node.isTextblock) node.forEach(visit);
    };
    visit(block);
    blockDefinitions.set(block, (found = list));
  }
  return found;
}

const mathOpeners = new WeakMap<ProseMirrorNode, boolean>();

// With math on, a top-level `$$` line that never closes (left as text of a paragraph, a setext
// heading, or a paragraph kept as source) turns every later quote and list into paragraph text,
// so a region after one parses from it.
function opensMath(block: ProseMirrorNode) {
  let opens = mathOpeners.get(block);
  if (opens === undefined) {
    const name = block.type.name;
    opens =
      (name === "paragraph" ||
        name === "heading" ||
        (name === "rawBlock" &&
          (block.attrs.kind === "other" || block.attrs.kind === "directive"))) &&
      /(?:^|[\r\n])[ \t]*\$\$/.test(`${block.attrs.before}${leafContentSource(block)}`);
    mathOpeners.set(block, opens);
  }
  return opens;
}

/** The link reference and footnote definitions anywhere in the document. */
export function documentDefinitions(
  doc: ProseMirrorNode,
  options: MarkdownSyntaxOptions,
): MarkdownDefinition[] {
  const all: MarkdownDefinition[] = [];
  doc.forEach((block) => {
    all.push(...definitionsIn(block, options));
  });
  return all;
}

/** Whether a definition in top-level blocks `[from, to)` was edited as source since its parse. */
function editedDefinition(doc: ProseMirrorNode, from: number, to: number) {
  const state = { edited: false };
  const visit = (node: ProseMirrorNode) => {
    const kind = node.type.name === "rawBlock" ? node.attrs.kind : null;
    if ((kind === "definition" || kind === "footnote") && !isParsedDefinitionLeaf(node)) {
      state.edited = true;
    }
    return !state.edited && !node.isTextblock;
  };
  for (let index = from; index < to && !state.edited; index++) {
    const block = doc.child(index);
    if (visit(block)) block.descendants(visit);
  }
  return state.edited;
}

const definitionsKey = (definitions: ReadonlyArray<MarkdownDefinition>) =>
  JSON.stringify(definitions);

/**
 * Reuses old nodes, at any depth, wherever the new parse produced an equal node with the same
 * inline analysis, which a changed definition can change.
 */
function shareNodes(
  oldNodes: ReadonlyArray<ProseMirrorNode>,
  newNodes: ReadonlyArray<ProseMirrorNode>,
): ProseMirrorNode[] {
  const keep = (old: ProseMirrorNode, fresh: ProseMirrorNode) => {
    if (!old.eq(fresh) || !adoptInlineAnalyses(old, fresh)) return false;
    rememberParsedDefinitions(old);
    return true;
  };
  let head = 0;
  while (
    head < oldNodes.length &&
    head < newNodes.length &&
    keep(oldNodes[head]!, newNodes[head]!)
  ) {
    head++;
  }
  let tail = 0;
  while (
    tail < oldNodes.length - head &&
    tail < newNodes.length - head &&
    keep(oldNodes[oldNodes.length - 1 - tail]!, newNodes[newNodes.length - 1 - tail]!)
  ) {
    tail++;
  }
  const oldMiddle = oldNodes.slice(head, oldNodes.length - tail);
  const newMiddle = newNodes.slice(head, newNodes.length - tail);
  const middle = newMiddle.map((node, index) => {
    const old = oldMiddle.length === newMiddle.length ? oldMiddle[index] : undefined;
    if (!old || node.isTextblock || node.isAtom || !old.sameMarkup(node)) return node;
    return node.copy(Fragment.from(shareNodes(children(old), children(node))));
  });
  return [...oldNodes.slice(0, head), ...middle, ...oldNodes.slice(oldNodes.length - tail)];
}

function children(node: ProseMirrorNode) {
  const list: ProseMirrorNode[] = [];
  node.forEach((child) => list.push(child));
  return list;
}

function selectionAt(doc: ProseMirrorNode, anchor: number, head: number): Selection {
  const anchorPos = posAtSourceOffset(doc, anchor);
  const headPos = posAtSourceOffset(doc, head);
  const $head = doc.resolve(headPos);
  if (!$head.parent.isTextblock) return Selection.near($head);
  const $anchor = doc.resolve(anchorPos);
  return TextSelection.between($anchor.parent.isTextblock ? $anchor : $head, $head);
}

function mapOffset(offset: number, edit: SourceEdit) {
  if (offset <= edit.from) return offset;
  if (offset >= edit.to) return offset + edit.insert.length - (edit.to - edit.from);
  return edit.from + edit.insert.length;
}

const BLANK_LINES = /^(?:[ \t]*(?:\r\n|\r|\n))*$/;

/**
 * Whether the block's syntax can take in the line at `offset` after it: as a lazy continuation or
 * table row when no blank line separates them, or as more of a list, footnote or indented code.
 */
function continuesInto(block: ProseMirrorNode, source: string, offset: number) {
  const name = block.type.name;
  if (name === "bulletList" || name === "orderedList") return true;
  if (
    name === "rawBlock" &&
    (block.attrs.kind === "footnote" || block.attrs.kind === "indentedCode")
  ) {
    return true;
  }
  return !blankLineBefore(source, offset);
}

const blankLineBefore = (source: string, offset: number) =>
  BLANK_LINE_BEFORE.test(source.slice(Math.max(0, offset - 64), offset));

/** The start of the line after the last content line of top-level block `index`. */
function lineAfterContent(doc: ProseMirrorNode, index: number, source: string, fallback: number) {
  let contentEnd = fallback;
  forEachLeaf(
    doc,
    (leaf) => {
      contentEnd = leaf.contentEnd;
    },
    index,
    index + 1,
  );
  const ending = LINE_ENDING.exec(source.slice(contentEnd, fallback));
  return ending ? contentEnd + ending.index + ending[0].length : fallback;
}

const topIndexAt = (starts: ReadonlyArray<number>, count: number, offset: number) => {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
};

/**
 * Applies a source edit and parses the affected top-level blocks again, so the structure is always
 * what Markdown makes of the bytes. The region grows until the block after it parses unchanged;
 * only nodes that changed are replaced.
 */
export function replaceRegionSource(
  state: EditorState,
  edit: SourceEdit,
  options: MarkdownEditOptions,
): Transaction {
  const doc = state.doc;
  const old = serializeMarkdownFile(doc);
  const next = old.slice(0, edit.from) + edit.insert + old.slice(edit.to);
  const delta = next.length - old.length;
  const starts = blockStarts(doc);
  const count = doc.childCount;
  const bom = doc.attrs.bom ? 1 : 0;
  const [anchor, head] = edit.selection ?? [
    mapOffset(sourceOffsetAt(doc, state.selection.anchor), edit),
    mapOffset(sourceOffsetAt(doc, state.selection.head), edit),
  ];
  const definitions = documentDefinitions(doc, options);
  const regionDefinitions = (from: number, to: number) => {
    const list: MarkdownDefinition[] = [];
    for (let index = from; index < to; index++)
      list.push(...definitionsIn(doc.child(index), options));
    return list;
  };

  let first = topIndexAt(starts, count, edit.from);
  if (first > 0 && starts[first] === edit.from) first--;
  // A block right after another, with no blank line between, can parse differently alone: an
  // empty item or a list starting past 1 cannot interrupt a paragraph.
  const joinedStart = (index: number) => {
    let start = index;
    if (start > 0 && continuesInto(doc.child(start - 1), old, starts[start]!)) start--;
    while (start > 0 && !blankLineBefore(old, starts[start]!)) start--;
    return start;
  };
  first = joinedStart(first);
  if (options.math) {
    for (let index = first - 1; index >= 0; index--) {
      if (opensMath(doc.child(index))) {
        first = index;
        break;
      }
    }
  }
  const frontmatterEnd = next.startsWith("---", bom) ? markdownFrontmatterEnd(next.slice(bom)) : 0;
  // A closing fence typed under an unclosed `---` first line makes front matter of all above it.
  if (edit.from <= bom + frontmatterEnd) first = 0;
  let end = topIndexAt(starts, count, edit.to) + 1;
  let nodes: ProseMirrorNode[] = [];
  let lead = doc.attrs.lead as string;
  let full = edit.from < bom || (next.charCodeAt(0) === 0xfeff ? 1 : 0) !== bom;

  while (!full) {
    // Front matter ends at the first closing fence, wherever that now is.
    if (first === 0) {
      while (end < count && starts[end]! + delta <= bom + frontmatterEnd) end++;
    }
    const checked = end < count;
    // The region starts on the line after the previous block's last content line: a list item
    // or quote can start on a line its first leaf does not, which then sits in that block's
    // `after`. Blank lines there are accepted below as the parse's lead.
    const regionStart = first === 0 ? bom : lineAfterContent(doc, first - 1, old, starts[first]!);
    const parseEnd = (checked ? starts[end + 1]! : starts[count]!) + delta;
    const text = next.slice(regionStart, parseEnd);
    // micromark drops a U+FEFF that starts its input, which would shift every offset after it.
    if (text.charCodeAt(0) === 0xfeff) {
      if (first === 0) full = true;
      else first = joinedStart(first - 1);
      continue;
    }
    const parse = parseMarkdownFile(text, {
      math: options.math,
      frontmatter: first === 0,
      bom: false,
      definitions,
    });
    if (parse.definitionsDropped) {
      full = true;
      break;
    }
    const built = buildMarkdownFileDoc(parse);
    const parsedLead = built.attrs.lead as string;
    if (
      first > 0 &&
      (parsedLead !== old.slice(regionStart, starts[first]) || !BLANK_LINES.test(parsedLead))
    ) {
      first = joinedStart(first - 1);
      continue;
    }
    nodes = text.trim() === "" && parsedLead === text ? [] : children(built);
    // A `$$` the region leaves unclosed can close past it, which turns what follows into math.
    if (checked && options.math && nodes.some(opensMath)) {
      end = count;
      continue;
    }
    if (checked) {
      if (!nodes.at(-1)?.eq(doc.child(end))) {
        end = Math.min(count, end + Math.max(1, end - first));
        continue;
      }
      nodes.pop();
    }
    // A changed definition changes how references parse everywhere else.
    if (
      editedDefinition(doc, first, checked ? end + 1 : end) ||
      definitionsKey(parse.definitions) !==
        definitionsKey(regionDefinitions(first, checked ? end + 1 : end))
    ) {
      full = true;
      break;
    }
    if (first === 0) lead = parsedLead;
    break;
  }

  const tr = state.tr;
  if (full) {
    const built = buildMarkdownFileDoc(parseMarkdownFile(next, { math: options.math }));
    const shared = shareNodes(children(doc), children(built));
    tr.replaceWith(0, doc.content.size, shared);
    for (const name of ["bom", "lead", "lineEnding"]) {
      if (built.attrs[name] !== doc.attrs[name]) tr.setDocAttribute(name, built.attrs[name]);
    }
  } else {
    const oldNodes = children(doc).slice(first, end);
    let shared = shareNodes(oldNodes, nodes);
    if (count - oldNodes.length + shared.length === 0) {
      const empty = markdownFileSchema.nodes.paragraph!.create();
      rememberInlineAnalysis(empty, {
        styles: [],
        markers: [],
        collapsed: [],
        breaks: [],
        kindMismatch: false,
      });
      shared = [empty];
    }
    let same = 0;
    while (same < shared.length && same < oldNodes.length && shared[same] === oldNodes[same]) {
      same++;
    }
    let sameTail = 0;
    while (
      sameTail < shared.length - same &&
      sameTail < oldNodes.length - same &&
      shared[shared.length - 1 - sameTail] === oldNodes[oldNodes.length - 1 - sameTail]
    ) {
      sameTail++;
    }
    let from = 0;
    for (let index = 0; index < first + same; index++) from += doc.child(index).nodeSize;
    let to = from;
    for (let index = first + same; index < end - sameTail; index++) to += doc.child(index).nodeSize;
    const replacement = shared.slice(same, shared.length - sameTail);
    if (from !== to || replacement.length > 0) tr.replaceWith(from, to, replacement);
    if (lead !== doc.attrs.lead) tr.setDocAttribute("lead", lead);
    const lineEnding = LINE_ENDING.exec(next)?.[0] === "\r\n" ? "\r\n" : "\n";
    if (lineEnding !== doc.attrs.lineEnding) tr.setDocAttribute("lineEnding", lineEnding);
  }
  tr.setSelection(selectionAt(tr.doc, anchor, head));
  if (options.addToHistory === false) tr.setMeta("addToHistory", false);
  return tr;
}

/** Parses the top-level block holding `pos` (and its neighbour) again; null when nothing changes. */
export function reparseBlockAt(
  state: EditorState,
  pos: number,
  options: MarkdownEditOptions,
): Transaction | null {
  const offset = sourceOffsetAt(state.doc, pos);
  const tr = replaceRegionSource(state, { from: offset, to: offset, insert: "" }, options);
  return tr.docChanged ? tr : null;
}

const BLOCK_TRIGGER = /^ {0,3}(?:#{1,6}|>|[-+*]|\d{1,9}[.)]|\[[ xX]\])$/;

/** Whether a space typed after `lineBeforeCaret` can start or change a block. */
export function isStructuralSpace(lineBeforeCaret: string): boolean {
  return BLOCK_TRIGGER.test(lineBeforeCaret) || lineBeforeCaret.startsWith("    ");
}

type TokenKind = "quote" | "list" | "task" | "heading" | "space";

interface PrefixToken {
  readonly kind: TokenKind;
  readonly from: number;
  readonly to: number;
}

const TOKEN_PATTERNS: ReadonlyArray<readonly [TokenKind, RegExp]> = [
  ["quote", /^ {0,3}>[ \t]?/],
  ["list", /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/],
  ["task", /^\[[ xX]\](?:[ \t]+|$)/],
  ["heading", /^#{1,6}(?:[ \t]+|$)/],
  ["space", /^[ \t]+/],
];

const lastLineStart = (text: string) =>
  Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;

/** The container and block markers on a leaf's first line, outermost first. */
function prefixTokens(before: string): PrefixToken[] {
  const tokens: PrefixToken[] = [];
  let at = lastLineStart(before);
  while (at < before.length) {
    const rest = before.slice(at);
    const match = TOKEN_PATTERNS.map(([kind, pattern]) => [kind, pattern.exec(rest)] as const).find(
      ([, result]) => result,
    );
    if (!match) break;
    tokens.push({ kind: match[0], from: at, to: at + match[1]![0].length });
    at += match[1]![0].length;
  }
  return tokens;
}

/**
 * The prefix a new line in the same container takes: list markers become spaces of their width,
 * quote markers stay, and heading markers and task boxes (item content, not containers) drop out.
 */
export function continuationPrefix(before: string): string {
  const start = lastLineStart(before);
  let out = "";
  let column = 0;
  for (const token of prefixTokens(before)) {
    const text = before.slice(token.from, token.to);
    let next = column;
    for (const char of text) next = char === "\t" ? next + 4 - (next % 4) : next + 1;
    if (token.kind === "list") out += " ".repeat(next - column);
    else if (token.kind === "quote" || token.kind === "space") out += text;
    column = next;
  }
  return start === 0 && out === "" ? "" : out;
}

const TRAILING_LINE_ENDS = /(?:\r\n|\r|\n)(?:[ \t>]*(?:\r\n|\r|\n))*[ \t>]*$/;

const blankPrefix = (continuation: string) => continuation.trimEnd();

/** The quote markers of a leaf's first line, up to the innermost one. */
function quotePrefix(before: string) {
  const tokens = prefixTokens(before);
  const last = tokens.findLastIndex((token) => token.kind === "quote");
  return last < 0 ? "" : before.slice(tokens[0]!.from, tokens[last]!.to);
}

interface CaretLeaf {
  readonly node: ProseMirrorNode;
  readonly pos: number;
  readonly placement: LeafPlacement;
}

function placementOf(doc: ProseMirrorNode, pos: number): LeafPlacement | null {
  let found: LeafPlacement | null = null;
  const index = doc.resolve(pos).index(0);
  forEachLeaf(
    doc,
    (leaf) => {
      if (leaf.pos !== pos) return true;
      found = leaf;
      return false;
    },
    index,
    index + 1,
  );
  return found;
}

/** The textblock holding the whole selection. */
function selectedLeaf(state: EditorState): CaretLeaf | null {
  const { $from, $to } = state.selection;
  if (!$from.parent.isTextblock || $from.parent !== $to.parent) return null;
  const pos = $from.before();
  const placement = placementOf(state.doc, pos);
  return placement ? { node: $from.parent, pos, placement } : null;
}

function adjacentLeaf(doc: ProseMirrorNode, pos: number, direction: -1 | 1) {
  let previous: LeafPlacement | null = null;
  let found: LeafPlacement | null = null;
  const index = doc.resolve(pos).index(0);
  forEachLeaf(
    doc,
    (leaf) => {
      if (direction === 1 && previous?.pos === pos) {
        found = leaf;
        return false;
      }
      if (direction === -1 && leaf.pos === pos) {
        found = previous;
        return false;
      }
      previous = leaf;
      return true;
    },
    Math.max(0, index - (direction === -1 ? 1 : 0)),
  );
  return found as LeafPlacement | null;
}

const isRawLeaf = (node: ProseMirrorNode) =>
  node.type.name === "codeBlock" || node.type.name === "rawBlock";

/** The text of the caret's line in a leaf, from the line's content start up to the caret. */
export function lineBeforeCaret(state: EditorState): string | null {
  const { $head } = state.selection;
  if (!$head.parent.isTextblock) return null;
  let line = "";
  let at = 0;
  $head.parent.forEach((child) => {
    if (at >= $head.parentOffset) return;
    if (child.isText) {
      const text = child.text!.slice(0, $head.parentOffset - at);
      const lineStart = lastLineStart(text);
      line = lineStart > 0 ? text.slice(lineStart) : line + text;
      at += child.text!.length;
    } else {
      line = "";
      at += 1;
    }
  });
  return line;
}

/** The continuation prefix of the caret's line: the line's prefix atom, or the leaf's first line. */
function caretLinePrefix(leaf: ProseMirrorNode, parentOffset: number) {
  let prefix = continuationPrefix(leaf.attrs.before as string);
  let at = 0;
  leaf.forEach((child) => {
    if (at >= parentOffset) return;
    if (!child.isText) prefix = child.attrs.text as string;
    at += child.nodeSize;
  });
  return prefix;
}

const LIST_MARKER_LINE = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

/** The prefix of a new sibling of the list item holding the caret's leaf, if it is in one. */
function siblingItemPrefix($pos: ResolvedPos): string | null {
  if ($pos.depth < 2 || $pos.node($pos.depth - 1).type.name !== "listItem") return null;
  let first = $pos.node($pos.depth - 1).firstChild!;
  while (!first.isTextblock && !first.isAtom) first = first.firstChild!;
  const before = first.attrs.before as string;
  const marker = prefixTokens(before).findLast((token) => token.kind === "list");
  return marker ? continuationPrefix(before.slice(0, marker.from)) : null;
}

/**
 * Pasted text with its later lines continuing the caret line's containers. A line starting with
 * a list marker becomes a sibling of the caret's list item, and the lines after it follow it.
 */
export function pastedSource(state: EditorState, text: string): string {
  const lineEnding = state.doc.attrs.lineEnding as string;
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return text.split(LINE_ENDINGS).join(lineEnding);
  let prefix = caretLinePrefix($from.parent, $from.parentOffset);
  const sibling = siblingItemPrefix($from);
  return text
    .split(LINE_ENDINGS)
    .map((line, index) => {
      if (index === 0) return line;
      if (sibling !== null && LIST_MARKER_LINE.test(line)) prefix = sibling;
      return prefix + line;
    })
    .join(lineEnding);
}

function textOffsetIn(leaf: ProseMirrorNode, parentOffset: number) {
  let text = 0;
  let at = 0;
  leaf.forEach((child) => {
    if (at >= parentOffset) return;
    if (child.isText) text += Math.min(child.text!.length, parentOffset - at);
    at += child.nodeSize;
  });
  return text;
}

/** The document position of a leaf text offset; a line start goes after that line's prefix. */
function posOfTextOffset(leaf: ProseMirrorNode, leafPos: number, offset: number) {
  let remaining = offset;
  let at = leafPos + 1;
  for (let index = 0; index < leaf.childCount; index++) {
    const child = leaf.child(index);
    if (!child.isText) {
      at += 1;
      continue;
    }
    const length = child.text!.length;
    if (remaining < length || (remaining === length && index === leaf.childCount - 1)) {
      return at + remaining;
    }
    remaining -= length;
    at += length;
  }
  return at;
}

/**
 * Runs a composer list edit on the source of the list around the caret, with the quote prefixes
 * of its lines taken off and put back. Lists inside a quote inside a list item are not handled.
 */
const ORDERED_ITEM = /^([ \t]*)(\d{1,9})([.)].*)$/;

/**
 * Whether `line` of `bodies` only renumbers `old`, and stays a later item of the same list, where
 * CommonMark ignores its number. A list's first number is its start, which the renumbering sets.
 */
function onlyRenumbered(bodies: ReadonlyArray<string>, line: number, old: string) {
  const now = ORDERED_ITEM.exec(bodies[line]!);
  const was = ORDERED_ITEM.exec(old);
  if (!now || !was || now[1] !== was[1] || now[3] !== was[3] || now[2] === was[2]) return false;
  for (let index = line - 1; index >= 0; index--) {
    const body = bodies[index]!;
    if (body.trim() === "") continue;
    const indent = /^[ \t]*/.exec(body)![0];
    if (indent.length > now[1]!.length) continue;
    const sibling = ORDERED_ITEM.exec(body);
    return indent === now[1] && sibling?.[3]![0] === now[3]![0];
  }
  return false;
}

function editListSource(
  state: EditorState,
  options: MarkdownEditOptions,
  compute: (value: string, cursor: number) => ComposerListEdit | null,
  /** Keeps the written numbers of later items, which the composer's edit renumbers. */
  keepLaterNumbers = false,
): Transaction | null {
  const { selection, doc } = state;
  if (!selection.empty) return null;
  const { $head } = selection;
  let listDepth = -1;
  let quotes = 0;
  for (let depth = $head.depth - 1; depth >= 1; depth--) {
    const name = $head.node(depth).type.name;
    if (name === "blockquote") quotes++;
    else if (quotes > 0 && name === "listItem") return null;
    else if (quotes === 0 && (name === "bulletList" || name === "orderedList")) listDepth = depth;
  }
  if (listDepth < 0) return null;
  const listPos = $head.before(listDepth);
  const listEnd = listPos + $head.node(listDepth).nodeSize;
  const placements: LeafPlacement[] = [];
  forEachLeaf(
    doc,
    (leaf) => {
      if (leaf.pos >= listEnd) return false;
      if (leaf.pos > listPos) placements.push(leaf);
      return true;
    },
    $head.index(0),
    $head.index(0) + 1,
  );
  const start = placements[0]!.lineStart;
  const end = placements.at(-1)!.contentEnd;
  const segment = serializeMarkdownFile(doc).slice(start, end);

  const lines: Array<{ prefix: string; body: string; ending: string }> = [];
  for (let at = 0; ;) {
    const match = LINE_ENDING.exec(segment.slice(at));
    const lineEnd = match ? at + match.index : segment.length;
    const text = segment.slice(at, lineEnd);
    let prefixEnd = 0;
    for (let level = 0; level < quotes; level++) {
      const quote = /^ {0,3}> ?/.exec(text.slice(prefixEnd));
      if (!quote) break;
      prefixEnd += quote[0].length;
    }
    lines.push({
      prefix: text.slice(0, prefixEnd),
      body: text.slice(prefixEnd),
      ending: match?.[0] ?? "",
    });
    if (!match) break;
    at = lineEnd + match[0].length;
  }
  const value = lines.map((line) => line.body).join("\n");

  const caret = sourceOffsetAt(doc, selection.head) - start;
  let cursor = 0;
  for (let line = 0, at = 0; line < lines.length; line++) {
    const { prefix, body, ending } = lines[line]!;
    if (caret <= at + prefix.length + body.length || line === lines.length - 1) {
      cursor += Math.max(0, caret - at - prefix.length);
      break;
    }
    cursor += body.length + 1;
    at += prefix.length + body.length + ending.length;
  }

  const listEdit = compute(value, cursor);
  if (!listEdit) return null;
  const newValue =
    value.slice(0, listEdit.start) + listEdit.replacement + value.slice(listEdit.end);
  const bodies = newValue.split("\n");
  const added = bodies.length - lines.length;
  const split = value.slice(0, listEdit.start).split("\n").length - 1;
  if (keepLaterNumbers) {
    for (let line = split + Math.max(added, 0) + 1; line < bodies.length; line++) {
      const old = lines[line - added];
      if (old && line - added > split && onlyRenumbered(bodies, line, old.body)) {
        bodies[line] = old.body;
      }
    }
  }
  const lineEnding = doc.attrs.lineEnding as string;
  let rebuilt = "";
  let caretInSegment = 0;
  const caretLine = newValue.slice(0, listEdit.cursorAfter).split("\n").length - 1;
  const caretColumn =
    listEdit.cursorAfter - (newValue.lastIndexOf("\n", listEdit.cursorAfter - 1) + 1);
  bodies.forEach((body, line) => {
    // Lines after the edit keep their own prefixes; lines it inserted take the split line's.
    const source = line <= split ? line : line - added > split ? line - added : split;
    const old = lines[source]!;
    const ending =
      line === bodies.length - 1
        ? ""
        : line >= split && line < split + Math.max(added, 0)
          ? lineEnding
          : old.ending || lineEnding;
    if (line === caretLine) caretInSegment = rebuilt.length + old.prefix.length + caretColumn;
    rebuilt += old.prefix + body + ending;
  });

  let prefix = 0;
  while (
    prefix < segment.length &&
    prefix < rebuilt.length &&
    segment[prefix] === rebuilt[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < segment.length - prefix &&
    suffix < rebuilt.length - prefix &&
    segment[segment.length - 1 - suffix] === rebuilt[rebuilt.length - 1 - suffix]
  ) {
    suffix++;
  }
  const caretOffset = start + caretInSegment;
  return replaceRegionSource(
    state,
    {
      from: start + prefix,
      to: start + segment.length - suffix,
      insert: rebuilt.slice(prefix, rebuilt.length - suffix),
      selection: [caretOffset, caretOffset],
    },
    options,
  );
}

const transientParagraph = (continuation: string) =>
  markdownFileSchema.nodes.paragraph!.create({ transient: continuation });

/** An empty paragraph after `leaf` for the caret, owning no bytes until it is typed into. */
function insertTransientAfter(tr: Transaction, after: number, continuation: string) {
  tr.insert(after, transientParagraph(continuation));
  return tr.setSelection(TextSelection.create(tr.doc, after + 1));
}

/** Enter. */
export const splitBlock: Command = (state, options) => {
  const leaf = selectedLeaf(state);
  if (!leaf) return null;
  const { doc, selection } = state;
  const { node, pos, placement } = leaf;
  // Markdown has one blank line between blocks however many are typed, so a second empty
  // paragraph would own no bytes either and the caret would fall into the next block.
  if (node.type.name === "paragraph" && node.attrs.transient !== null && node.content.size === 0) {
    return null;
  }
  const lineEnding = doc.attrs.lineEnding as string;
  const parentOffset = selection.$from.parentOffset;

  if (isRawLeaf(node)) {
    const prefix = caretLinePrefix(node, parentOffset);
    const inserted = [
      markdownFileSchema.text(lineEnding),
      ...(prefix ? [markdownFileSchema.nodes.linePrefix!.create({ text: prefix })] : []),
    ];
    const tr = state.tr.replaceWith(selection.from, selection.to, inserted);
    const caret = selection.from + lineEnding.length + (prefix ? 1 : 0);
    return tr.setSelection(TextSelection.create(tr.doc, caret));
  }
  if (node.type.name !== "paragraph" && node.type.name !== "heading") return null;
  const from = sourceOffsetAt(doc, selection.from);
  const to = sourceOffsetAt(doc, selection.to);
  const continuation = caretLinePrefix(node, parentOffset);
  const atEnd = selection.empty && parentOffset === node.content.size;
  const $pos = selection.$from;

  if (node.type.name === "paragraph" && $pos.node($pos.depth - 1).type.name === "listItem") {
    const item = $pos.node($pos.depth - 1);
    const listDepth = $pos.depth - 2;
    const list = $pos.node(listDepth);
    let outermost = true;
    for (let depth = 1; depth < listDepth; depth++) {
      if ($pos.node(depth).type.name !== "blockquote") outermost = false;
    }
    // Enter on the empty last item of an outer list leaves the list, as an empty paragraph.
    // GFM reads a task box with nothing after it as the item's text.
    if (
      (node.content.size === 0 || /^\[[ xX]\][ \t]*$/.test(leafContentSource(node))) &&
      item.childCount === 1 &&
      list.lastChild === item &&
      list.childCount > 1 &&
      outermost
    ) {
      // The line goes with the line ending and blank lines before it, so the line after the
      // list keeps its own and an Enter that made the item is undone byte for byte.
      const source = serializeMarkdownFile(doc);
      const head = source.slice(0, placement.lineStart);
      const from = head.length - (TRAILING_LINE_ENDS.exec(head)?.[0].length ?? 0);
      const to =
        placement.contentEnd + /^[ \t]*/.exec(source.slice(placement.contentEnd))![0].length;
      const tr = replaceRegionSource(
        state,
        { from, to, insert: "", selection: [from, from] },
        options,
      );
      // The previous item's text ends where the removed bytes started.
      const $previous = tr.doc.resolve(posAtSourceOffset(tr.doc, from));
      const listName = $previous.depth > listDepth ? $previous.node(listDepth).type.name : "";
      if (listName === "bulletList" || listName === "orderedList") {
        insertTransientAfter(
          tr,
          $previous.after(listDepth),
          quotePrefix(node.attrs.before as string),
        );
      }
      return tr;
    }
    const listTr = editListSource(state, options, listContinuationForEnter, true);
    if (listTr) return listTr;
  }

  if (node.type.name === "paragraph" && atEnd) {
    const fence = /^(?:(`{3,})[^`\r\n]*|(~{3,})[^\r\n]*|(\$\$))$/.exec(leafContentSource(node));
    if (fence) {
      const closing = fence[1] ?? fence[2] ?? fence[3]!;
      const insert = `${lineEnding}${continuation}${lineEnding}${continuation}${closing}`;
      const caret = placement.contentEnd + lineEnding.length + continuation.length;
      return replaceRegionSource(
        state,
        { from: placement.contentEnd, to: placement.contentEnd, insert, selection: [caret, caret] },
        options,
      );
    }
  }
  if (atEnd) {
    return insertTransientAfter(state.tr, pos + node.nodeSize, continuation);
  }
  const insert = `${lineEnding}${blankPrefix(continuation)}${lineEnding}${continuation}`;
  const caret = from + insert.length;
  // The new paragraph starts at its first character, as the old one did.
  const spaces = /^[ \t]*/.exec(serializeMarkdownFile(doc).slice(to, placement.contentEnd))![0];
  return replaceRegionSource(
    state,
    { from, to: to + spaces.length, insert, selection: [caret, caret] },
    options,
  );
};

/**
 * Gives a typed-into transient paragraph its bytes: a blank line on each side, so it neither
 * joins its neighbours nor is dropped by the next parse.
 */
export const materializeTransient: Command = (state, options) => {
  const { $head } = state.selection;
  const node = $head.parent;
  const continuation = node.attrs.transient as string | null;
  if (node.type.name !== "paragraph" || continuation === null || node.content.size === 0) {
    return null;
  }
  const source = serializeMarkdownFile(state.doc);
  const at = sourceOffsetAt(state.doc, $head.before() + 1);
  const text = leafContentSource(node);
  const lineEnding = state.doc.attrs.lineEnding as string;
  const blank = blankPrefix(continuation);
  const head = source.slice(0, at);
  const leading =
    at === 0 || BLANK_LINE_BEFORE.test(head)
      ? ""
      : /(?:\r\n|\n|\r)$/.test(head)
        ? `${blank}${lineEnding}`
        : `${lineEnding}${blank}${lineEnding}`;
  // At the end of a file that ends a line, the new paragraph ends one too.
  const trailing =
    at + text.length < source.length
      ? `${lineEnding}${blank}${lineEnding}`
      : /(?:\r\n|\n|\r)$/.test(head)
        ? lineEnding
        : "";
  const caret = at + leading.length + continuation.length + $head.parentOffset;
  return replaceRegionSource(
    state,
    {
      from: at,
      to: at + text.length,
      insert: leading + continuation + text + trailing,
      selection: [caret, caret],
    },
    options,
  );
};

/** Shift-Enter: a backslash hard break, which survives editors that trim trailing spaces. */
export const hardBreak: Command = (state, options) => {
  const leaf = selectedLeaf(state);
  if (leaf?.node.type.name !== "paragraph" || leaf.node.attrs.transient !== null) return null;
  const { doc, selection } = state;
  const from = sourceOffsetAt(doc, selection.from);
  const to = sourceOffsetAt(doc, selection.to);
  const insert = `\\${doc.attrs.lineEnding}${caretLinePrefix(leaf.node, selection.$from.parentOffset)}`;
  const caret = from + insert.length;
  return replaceRegionSource(state, { from, to, insert, selection: [caret, caret] }, options);
};

/**
 * Backspace at the start of a leaf's content: removes the innermost marker before it (heading,
 * task box, list marker, quote), or else joins the leaf to the previous one.
 */
export const liftMarker: Command = (state, options) => {
  const leaf = selectedLeaf(state);
  const { selection } = state;
  if (!leaf || !selection.empty || selection.$from.parentOffset !== 0) return null;
  if (leaf.node.type.name !== "paragraph" && leaf.node.type.name !== "heading") return null;
  const { placement } = leaf;
  const before = leaf.node.attrs.before as string;
  const last = prefixTokens(before).at(-1);
  if (last && last.kind !== "space" && last.to === before.length) {
    const from = placement.lineStart + last.from;
    return replaceRegionSource(
      state,
      { from, to: placement.lineStart + last.to, insert: "", selection: [from, from] },
      options,
    );
  }
  const previous = adjacentLeaf(state.doc, leaf.pos, -1);
  if (!previous) return null;
  if (isRawLeaf(previous.node)) {
    return state.tr.setSelection(
      TextSelection.create(state.doc, previous.pos + previous.node.nodeSize - 1),
    );
  }
  if (previous.node.isAtom) {
    const caret = placement.contentStart - (previous.end - previous.lineStart);
    return replaceRegionSource(
      state,
      { from: previous.lineStart, to: previous.end, insert: "", selection: [caret, caret] },
      options,
    );
  }
  return replaceRegionSource(
    state,
    {
      from: previous.contentEnd,
      to: placement.contentStart,
      insert: "",
      selection: [previous.contentEnd, previous.contentEnd],
    },
    options,
  );
};

/** Delete at the end of a leaf's content: joins the next leaf to it. */
export const joinForward: Command = (state, options) => {
  const leaf = selectedLeaf(state);
  const { selection } = state;
  if (!leaf || !selection.empty || selection.$from.parentOffset !== leaf.node.content.size) {
    return null;
  }
  if (leaf.node.type.name !== "paragraph" && leaf.node.type.name !== "heading") return null;
  const next = adjacentLeaf(state.doc, leaf.pos, 1);
  if (!next) return null;
  const caret = leaf.placement.contentEnd;
  if (isRawLeaf(next.node)) {
    return state.tr.setSelection(TextSelection.create(state.doc, next.pos + 1));
  }
  const range = next.node.isAtom
    ? { from: next.lineStart, to: next.end }
    : { from: caret, to: next.contentStart };
  return replaceRegionSource(state, { ...range, insert: "", selection: [caret, caret] }, options);
};

/** Marks a transaction that already parsed the block the caret left. */
export const REPARSED_META = "md-reparsed";

/** Escape in a code or raw block: the caret goes just after it, so the block shows rendered. */
export const leaveRawBlock: Command = (state, options) => {
  const leaf = selectedLeaf(state);
  if (!leaf || !isRawLeaf(leaf.node)) return null;
  const { end } = leaf.placement;
  const tr = replaceRegionSource(
    state,
    { from: end, to: end, insert: "", selection: [end, end] },
    options,
  ).setMeta(REPARSED_META, true);
  const { selection } = tr;
  const { $head } = selection;
  if (
    selection.empty &&
    $head.parent.isTextblock &&
    !isRawLeaf($head.parent) &&
    $head.parentOffset === 0 &&
    sourceOffsetAt(tr.doc, $head.before() + 1) >= end
  ) {
    return tr;
  }
  // Nothing editable starts right after it: an empty paragraph there, owning no bytes.
  const $last = tr.doc.resolve(posAtSourceOffset(tr.doc, end - 1));
  const continuation = caretLinePrefix(leaf.node, leaf.node.content.size);
  return insertTransientAfter(tr, $last.after(), continuation);
};

/** Tab in list item text. */
export const indentListItem: Command = (state, options) =>
  editListSource(state, options, (value, cursor) => listIndentForTab(value, cursor, cursor));

/** Shift-Tab in list item text. */
export const outdentListItem: Command = (state, options) =>
  editListSource(state, options, (value, cursor) => listOutdentForTab(value, cursor, cursor));

/** Checks or unchecks the task list item at or around `pos`. */
export function toggleTask(
  state: EditorState,
  pos: number,
  options: MarkdownEditOptions,
): Transaction | null {
  const $pos = state.doc.resolve(pos);
  let itemPos = -1;
  if ($pos.nodeAfter?.type.name === "listItem") itemPos = pos;
  for (let depth = $pos.depth; depth >= 1 && itemPos < 0; depth--) {
    if ($pos.node(depth).type.name === "listItem") itemPos = $pos.before(depth);
  }
  if (itemPos < 0) return null;
  const item = state.doc.nodeAt(itemPos)!;
  if (item.attrs.checked === null) return null;
  let leafPos = itemPos + 1;
  let leafNode = item.firstChild!;
  while (!leafNode.isTextblock && !leafNode.isAtom) {
    leafPos += 1;
    leafNode = leafNode.firstChild!;
  }
  const placement = placementOf(state.doc, leafPos);
  const before = leafNode.attrs.before as string;
  const box = [...before.matchAll(/\[[ xX]\]/g)].at(-1);
  if (!placement || box?.index === undefined) return null;
  const toggled = setMarkdownTaskChecked(before, box.index, !item.attrs.checked);
  const from = placement.lineStart + box.index + 1;
  return replaceRegionSource(
    state,
    { from, to: from + 1, insert: toggled[box.index + 1]! },
    options,
  );
}

const INLINE_MARKERS: Partial<Record<InlineStyleKind, string>> = {
  strong: "**",
  em: "*",
  code: "`",
  del: "~~",
};

/**
 * Mod-B, Mod-I, Mod-E, Mod-Shift-S and Mod-K: wraps the selection in markers, or removes the
 * markers of the styled range of that kind the selection lies in. A plain text edit; the
 * structure does not change.
 */
export function toggleInline(
  state: EditorState,
  kind: "strong" | "em" | "code" | "del" | "a",
  options: MarkdownEditOptions,
): Transaction | null {
  const leaf = selectedLeaf(state);
  if (!leaf || (leaf.node.type.name !== "paragraph" && leaf.node.type.name !== "heading")) {
    return null;
  }
  const { selection, doc } = state;
  const { node, pos } = leaf;
  let from = textOffsetIn(node, selection.$from.parentOffset);
  let to = textOffsetIn(node, selection.$to.parentOffset);
  // A marker next to whitespace does not open or close a style: `a* b*` stays literal.
  const text = leafText(node);
  while (from < to && /\s/.test(text[from]!)) from++;
  while (to > from && /\s/.test(text[to - 1]!)) to--;
  if (from === to && !selection.empty) return null;
  const analysis = inlineAnalysisFor(node, documentDefinitions(doc, options), options);
  const index =
    analysis?.styles.findIndex(
      (style) => style.kind === kind && style.innerFrom <= from && to <= style.innerTo,
    ) ?? -1;
  const tr = state.tr;
  if (analysis && index >= 0) {
    const markers = analysis.markers.filter((marker) => marker.style === index).reverse();
    for (const marker of markers) {
      tr.delete(posOfTextOffset(node, pos, marker.from), posOfTextOffset(node, pos, marker.to));
    }
    return tr;
  }
  // A marker inside a code span is literal and would split it, exposing its text as syntax.
  for (const style of analysis?.styles ?? []) {
    if (style.kind === "code" && style.from < to && from < style.to) {
      from = Math.min(from, style.from);
      to = Math.max(to, style.to);
    }
  }
  const fromPos = posOfTextOffset(node, pos, from);
  const toPos = selection.empty ? fromPos : posOfTextOffset(node, pos, to);
  if (kind === "a") {
    tr.insertText("]()", toPos);
    tr.insertText("[", fromPos);
    return tr.setSelection(TextSelection.create(tr.doc, toPos + 3));
  }
  let open = INLINE_MARKERS[kind]!;
  let close = open;
  const inner = text.slice(from, to);
  if (kind === "code" && inner.includes("`")) {
    // CommonMark: a code span's fence is a backtick run its content does not contain.
    const longest = Math.max(...(inner.match(/`+/g) ?? []).map((run) => run.length));
    const pad = inner.startsWith("`") || inner.endsWith("`") ? " " : "";
    open = "`".repeat(longest + 1) + pad;
    close = pad + "`".repeat(longest + 1);
  }
  tr.insertText(close, toPos);
  tr.insertText(open, fromPos);
  return tr.setSelection(TextSelection.create(tr.doc, fromPos + open.length, toPos + open.length));
}

/** Sets a fenced code block's language, rewriting only the language in its info string. */
export function setCodeBlockLanguage(
  state: EditorState,
  pos: number,
  language: string,
  options: MarkdownEditOptions,
): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (node?.type.name !== "codeBlock") return null;
  const placement = placementOf(state.doc, pos);
  const before = node.attrs.before as string;
  const fence = /^([^\r\n]*?)(`{3,}|~{3,})([^\r\n]*)/.exec(before);
  if (!placement || !fence) return null;
  const from = placement.lineStart + fence[1]!.length + fence[2]!.length;
  const info = fence[3]!;
  return replaceRegionSource(
    state,
    { from, to: from + info.length, insert: withInfoStringLanguage(info, language) },
    options,
  );
}

/**
 * Takes in a new version of the file written elsewhere: only the blocks around the changed span
 * parse again, the selection is mapped, and the change is not undoable.
 */
export function applyExternalSource(
  state: EditorState,
  source: string,
  options: MarkdownSyntaxOptions,
): Transaction | null {
  const old = serializeMarkdownFile(state.doc);
  if (old === source) return null;
  let prefix = 0;
  while (prefix < old.length && prefix < source.length && old[prefix] === source[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < source.length - prefix &&
    old[old.length - 1 - suffix] === source[source.length - 1 - suffix]
  ) {
    suffix++;
  }
  return replaceRegionSource(
    state,
    { from: prefix, to: old.length - suffix, insert: source.slice(prefix, source.length - suffix) },
    { ...options, addToHistory: false },
  );
}
