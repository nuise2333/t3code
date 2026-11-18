interface Point {
  line: number;
  column: number;
  offset?: number;
}

interface InlineNode {
  type: string;
  value?: string;
  url?: string;
  children?: InlineNode[];
  data?: { hName?: string };
  position?: { start: Point; end: Point };
}

type Adjacent = "space" | "punctuation" | "other";

interface Run {
  readonly kind: "run";
  readonly char: string;
  readonly length: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  readonly start: Point | undefined;
  readonly end: Point | undefined;
}

type Item =
  | Run
  | {
      readonly kind: "text";
      readonly value: string;
      readonly start: Point | undefined;
      readonly end: Point | undefined;
    }
  | { readonly kind: "node"; readonly node: InlineNode };

const DELIMITERS = "=^~";
const HAS_DELIMITER = /[=^~]/;
const HAS_SYNTAX = /==|[\^~]/;
const NO_ESCAPES: ReadonlySet<number> = new Set();

const isDelimiterRun = (char: string, length: number) =>
  char === "=" ? length === 2 : length <= 2;

function wrap(run: Run, children: InlineNode[]): InlineNode {
  if (run.char === "=") return { type: "mark", data: { hName: "mark" }, children };
  if (run.char === "^") return { type: "superscript", data: { hName: "sup" }, children };
  return run.length === 2
    ? { type: "delete", children }
    : { type: "subscript", data: { hName: "sub" }, children };
}

function classify(char: string | undefined): Adjacent {
  if (char === undefined || /\s/u.test(char)) return "space";
  return /[\p{P}\p{S}]/u.test(char) ? "punctuation" : "other";
}

function lastCodePoint(value: string) {
  const last = value.at(-1);
  return last !== undefined && /[\uDC00-\uDFFF]/.test(last) ? value.slice(-2) : last;
}

function firstCodePoint(value: string) {
  const first = value.codePointAt(0);
  return first === undefined ? undefined : String.fromCodePoint(first);
}

// A node between two runs stands for the markup that opens or closes it in the source.
function adjacentTo(sibling: InlineNode | undefined, edge: "start" | "end"): Adjacent {
  if (sibling === undefined || sibling.type === "break") return "space";
  if (sibling.type !== "text") return "punctuation";
  const value = sibling.value ?? "";
  return classify(edge === "start" ? firstCodePoint(value) : lastCodePoint(value));
}

function flanking(char: string, before: Adjacent, after: Adjacent) {
  // `^` and `==` only look at whitespace; a single `~` follows CommonMark flanking, so `~/path`
  // and `H~.2~O` stay literal.
  if (char !== "~") return { canOpen: after !== "space", canClose: before !== "space" };
  return {
    canOpen: after !== "space" && (after !== "punctuation" || before !== "other"),
    canClose: before !== "space" && (before !== "punctuation" || after !== "other"),
  };
}

/** Indexes in `value` of delimiter characters the source wrote with a backslash escape. */
function escapedDelimiters(value: string, raw: string | undefined): ReadonlySet<number> {
  if (raw === undefined || raw === value || !raw.includes("\\")) return NO_ESCAPES;
  const escaped = new Set<number>();
  for (const char of DELIMITERS) {
    const inValue: number[] = [];
    for (let at = value.indexOf(char); at !== -1; at = value.indexOf(char, at + 1)) {
      inValue.push(at);
    }
    if (inValue.length === 0) continue;
    const inRaw: boolean[] = [];
    for (let at = raw.indexOf(char); at !== -1; at = raw.indexOf(char, at + 1)) {
      let slashes = 0;
      while (raw[at - slashes - 1] === "\\") slashes++;
      inRaw.push(slashes % 2 === 1);
    }
    // A character reference adds the character to the value only; pairing by order is then unsafe.
    if (inRaw.length !== inValue.length) continue;
    inValue.forEach((at, order) => {
      if (inRaw[order]) escaped.add(at);
    });
  }
  return escaped;
}

function rawOf(node: InlineNode, source: string) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : source.slice(start, end);
}

/** Where `index` of a text node's value sits in the source, when the value is the source. */
function pointIn(node: InlineNode, raw: string | undefined, index: number): Point | undefined {
  const start = node.position?.start;
  if (start?.offset === undefined || raw === undefined || raw !== node.value) return undefined;
  const lineStart = raw.lastIndexOf("\n", index - 1) + 1;
  let lines = 0;
  for (let at = raw.indexOf("\n"); at !== -1 && at < index; at = raw.indexOf("\n", at + 1)) lines++;
  return {
    line: start.line + lines,
    column: lines === 0 ? start.column + index : index - lineStart + 1,
    offset: start.offset + index,
  };
}

function tokenize(children: ReadonlyArray<InlineNode>, source: string): Item[] {
  const items: Item[] = [];
  children.forEach((child, childIndex) => {
    const value = child.value;
    if (child.type !== "text" || value === undefined || !HAS_DELIMITER.test(value)) {
      items.push({ kind: "node", node: child });
      return;
    }
    const raw = rawOf(child, source);
    const escaped = escapedDelimiters(value, raw);
    const text = (from: number, to: number): Item => ({
      kind: "text",
      value: value.slice(from, to),
      start: pointIn(child, raw, from),
      end: pointIn(child, raw, to),
    });
    let plainFrom = 0;
    let index = 0;
    while (index < value.length) {
      const char = value[index]!;
      if (!DELIMITERS.includes(char) || escaped.has(index)) {
        index++;
        continue;
      }
      let end = index + 1;
      while (value[end] === char && !escaped.has(end)) end++;
      if (isDelimiterRun(char, end - index)) {
        if (index > plainFrom) items.push(text(plainFrom, index));
        const before =
          index === 0
            ? adjacentTo(children[childIndex - 1], "end")
            : classify(lastCodePoint(value.slice(0, index)));
        const after =
          end === value.length
            ? adjacentTo(children[childIndex + 1], "start")
            : classify(firstCodePoint(value.slice(end)));
        items.push({
          kind: "run",
          char,
          length: end - index,
          ...flanking(char, before, after),
          start: pointIn(child, raw, index),
          end: pointIn(child, raw, end),
        });
        plainFrom = end;
      }
      index = end;
    }
    if (plainFrom < value.length) items.push(text(plainFrom, value.length));
  });
  return items;
}

/** Opening item index to closing item index, for every run pair that matched. */
function matchRuns(items: ReadonlyArray<Item>) {
  const closers = new Map<number, number>();
  const openers: Array<{ readonly index: number; readonly run: Run }> = [];
  // A closer that finds no opener hides every earlier opener of its character from later
  // closers, which is why `a~1~~2~` and `a^2^^3^` stay literal.
  const floors = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind !== "run") return;
    if (item.canClose) {
      const floor = Math.min(openers.length, floors.get(item.char) ?? 0);
      let at = openers.length - 1;
      while (
        at >= floor &&
        (openers[at]!.run.char !== item.char || openers[at]!.run.length !== item.length)
      ) {
        at--;
      }
      if (at >= floor) {
        closers.set(openers[at]!.index, index);
        openers.length = at;
        return;
      }
      floors.set(item.char, openers.length);
    }
    if (item.canOpen) openers.push({ index, run: item });
  });
  return closers;
}

function build(
  items: ReadonlyArray<Item>,
  closers: ReadonlyMap<number, number>,
  from: number,
  to: number,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let tail: InlineNode | undefined;
  // A node gets a position only when every piece of it had one, so editors can map it back.
  const text = (value: string, start: Point | undefined, end: Point | undefined) => {
    if (!tail) {
      nodes.push((tail = { type: "text", value }));
      if (start && end) tail.position = { start, end };
      return;
    }
    tail.value += value;
    if (tail.position && end && tail.position.end.offset === start?.offset) tail.position.end = end;
    else delete tail.position;
  };
  for (let index = from; index < to; index++) {
    const item = items[index]!;
    if (item.kind === "text") {
      text(item.value, item.start, item.end);
      continue;
    }
    if (item.kind === "run") {
      const close = closers.get(index);
      const inner = close === undefined ? [] : build(items, closers, index + 1, close);
      if (close === undefined || inner.length === 0) {
        text(item.char.repeat(item.length), item.start, item.end);
        continue;
      }
      const node = wrap(item, inner);
      const closer = items[close] as Run;
      if (item.start && closer.end) node.position = { start: item.start, end: closer.end };
      nodes.push(node);
      index = close;
    } else {
      nodes.push(item.node);
    }
    tail = undefined;
  }
  return nodes;
}

// An autolinked URL, email or file path is its own label: `?a==b==c` in it is not markup.
function isLiteralLink(node: InlineNode) {
  const label = node.children?.length === 1 ? node.children[0] : undefined;
  if (node.type !== "link" || label?.type !== "text" || node.url === undefined) return false;
  const text = label.value ?? "";
  return node.url === text || node.url === `mailto:${text}` || node.url === `http://${text}`;
}

function transform(parent: InlineNode, source: string) {
  const children = parent.children;
  if (!children || isLiteralLink(parent)) return;
  for (const child of children) transform(child, source);
  if (!children.some((child) => child.type === "text" && HAS_DELIMITER.test(child.value ?? ""))) {
    return;
  }
  const items = tokenize(children, source);
  const closers = matchRuns(items);
  if (closers.size > 0) parent.children = build(items, closers, 0, items.length);
}

/**
 * Reader inline syntax: `==mark==`, `^superscript^` and `~subscript~`. Needs remark-gfm with
 * `singleTilde: false`, or GFM takes single tildes as strikethrough first.
 */
export function remarkReaderInlineSyntax() {
  return (tree: InlineNode, file: { toString(): string }) => {
    const text = String(file);
    if (!HAS_SYNTAX.test(text)) return;
    // Node offsets do not count a leading byte order mark.
    transform(tree, text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  };
}
