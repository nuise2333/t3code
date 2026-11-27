import type { Nodes } from "mdast";
import { parseMarkdownSyntax } from "./markdownSyntax";

export { tableEdit, type TableOperation } from "./markdownTable";

export interface TextSelection {
  start: number;
  end: number;
}
export type CommandResult = { text: string; selection: TextSelection } | { refused: string };
type ParagraphKind =
  | "paragraph"
  | "promote"
  | "demote"
  | "quote"
  | "orderedList"
  | "bulletList"
  | "taskList"
  | "codeFence"
  | "mathBlock"
  | "rule"
  | "table"
  | "toc"
  | "frontMatter"
  | "paragraphBefore"
  | "paragraphAfter";
export type ParagraphCommand =
  | ParagraphKind
  | { kind: ParagraphKind }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 };
export type InlineFormat =
  | "strong"
  | "emphasis"
  | "underline"
  | "code"
  | "strike"
  | "link"
  | "image"
  | "clear";

const item = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(?:\[([ xX])\]([ \t]+))?/;
const heading = /^(#{1,6})(?:[ \t]+|$)/;
const quote = /^>[ \t]?/;
const eolOf = (text: string) => text.match(/\r\n|[\n\r]/)?.[0] ?? "\n";

function splice(text: string, from: number, to: number, value: string, start: number, end = start) {
  return {
    text: text.slice(0, from) + value + text.slice(to),
    selection: { start: from + start, end: from + end },
  };
}

function lineStart(text: string, at: number) {
  return Math.max(text.lastIndexOf("\n", at - 1), text.lastIndexOf("\r", at - 1)) + 1;
}

function lineEnd(text: string, at: number) {
  const rest = text.slice(at).search(/[\r\n]/);
  return rest === -1 ? text.length : at + rest;
}

function selectedLines(text: string, selection: TextSelection) {
  const from = selection.start === 0 ? 0 : lineStart(text, selection.start);
  let to = lineEnd(text, Math.max(selection.start, selection.end - 1));
  if (to > from && text[to] === "\n" && text[to - 1] === "\r") to--;
  const segments = text.slice(from, to).split(/(\r\n|[\n\r])/);
  return { from, to, segments };
}

// Commands change a line prefix. Map both ends of the selection through those edits.
function changeLines(
  text: string,
  selection: TextSelection,
  transform: (line: string, index: number) => string,
) {
  const { from, to, segments } = selectedLines(text, selection);
  let pos = from;
  let start = selection.start;
  let end = selection.end;
  const value = segments
    .map((line, i) => {
      const previous = pos;
      pos += line.length;
      if (i % 2) return line;
      const next = transform(line, i / 2);
      let retained = 0;
      while (
        retained < line.length &&
        retained < next.length &&
        line[line.length - 1 - retained] === next[next.length - 1 - retained]
      )
        retained++;
      const removed = line.length - retained;
      const added = next.length - retained;
      const delta = (point: number) =>
        point < previous ? 0 : added - Math.min(removed, point - previous);
      start += delta(selection.start);
      end += delta(selection.end);
      return next;
    })
    .join("");
  return splice(text, from, to, value, start - from, end - from);
}

const tableTemplate = "|     |     |     |\n| --- | --- | --- |\n|     |     |     |";

function itemKind(marker: RegExpMatchArray | null) {
  if (!marker) return undefined;
  if (marker[4] !== undefined) return "taskList";
  return /^\d/.test(marker[2]!) ? "orderedList" : "bulletList";
}

export function applyParagraphCommand(
  text: string,
  selection: TextSelection,
  command: ParagraphCommand,
  options: { isFirstBlock: boolean } = { isFirstBlock: false },
): CommandResult {
  const kind = typeof command === "string" ? command : command.kind;
  const eol = eolOf(text);
  const blank = eol + eol;
  if (kind === "paragraphBefore") return splice(text, 0, 0, blank, 0);
  if (kind === "paragraphAfter") return splice(text, text.length, text.length, blank, blank.length);
  if (kind === "frontMatter") {
    if (!options.isFirstBlock) return { refused: "Front matter must be the first block." };
    const prefix = "---" + eol;
    return splice(text, 0, 0, prefix + eol + "---" + (text ? blank : ""), prefix.length);
  }
  const { from, to, segments } = selectedLines(text, selection);
  const raw = text.slice(from, to);
  if (kind === "codeFence" || kind === "mathBlock") {
    const runs = [...raw.matchAll(/^`+/gm)].map((match) => match[0].length + 1);
    const delimiter =
      kind === "mathBlock" ? "$$" : "`".repeat(runs.reduce((a, b) => Math.max(a, b), 3));
    const prefix = delimiter + eol;
    return splice(
      text,
      from,
      to,
      prefix + raw + eol + delimiter,
      selection.start - from + prefix.length,
      selection.end - from + prefix.length,
    );
  }
  if (kind === "toc" || kind === "rule" || kind === "table") {
    const value =
      kind === "toc" ? "[toc]" : kind === "rule" ? "---" : tableTemplate.replaceAll("\n", eol);
    const before = selection.start > 0 ? blank : "";
    const after = selection.end < text.length ? blank : "";
    return splice(
      text,
      selection.start,
      selection.end,
      before + value + after,
      before.length + (kind === "table" ? 2 : value.length),
    );
  }
  if (/^ {0,3}(?:`{3,}|~{3,}|\$\$\s*(?:\r?\n|$))/.test(text))
    return { refused: "Cannot change paragraph style inside a fenced block." };
  const lines = segments.filter((_, i) => i % 2 === 0);
  if (
    (kind === "promote" || kind === "demote") &&
    lines.some((line) => !heading.test(line.trimStart()))
  )
    return { refused: "Select a heading first." };
  const toggleOff = lines.every((line) =>
    kind === "quote" ? quote.test(line.trimStart()) : itemKind(line.match(item)) === kind,
  );
  return changeLines(text, selection, (line, index) => {
    const indent = line.match(/^[ \t]*/)![0];
    const body = line.slice(indent.length);
    const list = line.match(item);
    if (kind === "paragraph") {
      return (
        indent +
        body.replace(
          /^(?:(?:#{1,6}(?:[ \t]+|$)|>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?))+/,
          "",
        )
      );
    }
    if (kind === "heading" || kind === "promote" || kind === "demote") {
      const level = heading.exec(body)?.[1]?.length ?? 0;
      const depth =
        typeof command === "object" && command.kind === "heading"
          ? command.level
          : Math.max(1, Math.min(6, level + (kind === "promote" ? -1 : 1)));
      return indent + "#".repeat(depth) + " " + body.replace(heading, "");
    }
    if (kind === "quote")
      return indent + (toggleOff ? body.replace(quote, "") : quote.test(body) ? body : "> " + body);
    const content = list ? line.slice(list[0].length) : body;
    if (toggleOff) return indent + content;
    if (itemKind(list) === kind) return line;
    const marker =
      kind === "orderedList" ? `${index + 1}. ` : kind === "taskList" ? "- [ ] " : "- ";
    return indent + marker + content;
  });
}

export function continueOnEnter(text: string, caret: number) {
  const start = caret > 0 ? lineStart(text, caret) : 0;
  const line = text.slice(start, lineEnd(text, caret));
  const quotes = line.match(/^(?:[ \t]*>[ \t]?)+/)?.[0] ?? "";
  const content = line.slice(quotes.length);
  const list = content.match(item);
  if (!list && !quotes) return null;
  const marker = quotes + (list?.[0] ?? "");
  if (caret < start + marker.length) return null;
  if (!line.slice(marker.length).trim()) {
    const outer = list ? quotes : quotes.replace(/[ \t]*>[ \t]?$/, "");
    return splice(text, start, start + line.length, outer, outer.length);
  }
  let prefix = quotes;
  if (list) {
    const bullet = list[2]!;
    prefix +=
      list[1] +
      (/^\d/.test(bullet) ? String(parseInt(bullet, 10) + 1) + bullet.slice(-1) : bullet) +
      list[3];
    if (list[4] !== undefined) prefix += "[ ]" + list[5];
  }
  const insert = eolOf(text) + prefix;
  return splice(text, caret, caret, insert, insert.length);
}

export function indentLines(
  text: string,
  selection: TextSelection,
  direction: 1 | -1,
): CommandResult {
  const { segments } = selectedLines(text, selection);
  const first = segments[0]?.match(item);
  if (!first) return { refused: "Select a list item first." };
  const width = first[2]!.length + first[3]!.length;
  const unindent = new RegExp(`^(?:\\t| {1,${width}})`);
  return changeLines(text, selection, (line) =>
    direction === 1 ? " ".repeat(width) + line : line.replace(unindent, ""),
  );
}

const wrappers = {
  strong: [
    ["**", "**"],
    ["__", "__"],
  ],
  emphasis: [
    ["*", "*"],
    ["_", "_"],
  ],
  underline: [["<u>", "</u>"]],
  code: [["`", "`"]],
  strike: [["~~", "~~"]],
  link: [["[", "](url)"]],
  image: [["![", "](url)"]],
} as const;

interface InlineSpan {
  format: Exclude<InlineFormat, "clear">;
  from: number;
  inner: number;
  end: number;
  to: number;
}

function inlineSpans(text: string) {
  const spans: InlineSpan[] = [];
  function visit(node: Nodes) {
    const from = node.position?.start.offset;
    const to = node.position?.end.offset;
    if (from === undefined || to === undefined) return;
    const raw = text.slice(from, to);
    const add = (format: InlineSpan["format"], left: number, right = left) => {
      spans.push({ format, from, to, inner: from + left, end: to - right });
    };
    switch (node.type) {
      case "strong":
        add("strong", 2);
        break;
      case "emphasis":
        add("emphasis", 1);
        break;
      case "delete":
        add("strike", 2);
        break;
      case "inlineCode": {
        const ticks = raw.match(/^`+/)![0].length;
        const inside = raw.slice(ticks, -ticks);
        const padded = inside.startsWith(" ") && inside.endsWith(" ") && /[^ ]/.test(inside);
        add("code", ticks + Number(padded));
        break;
      }
      case "link":
      case "image": {
        const label = raw.match(/^(?:!?)\[((?:\\.|[^\]\\]|\](?!\())*)\]\(/s);
        if (label) {
          const left = node.type === "image" ? 2 : 1;
          add(node.type, left, raw.length - left - label[1]!.length);
        }
        break;
      }
    }
    if ("children" in node) {
      const opens: number[] = [];
      for (const child of node.children) {
        const offset = child.position?.start.offset;
        if (child.type === "html" && offset !== undefined) {
          if (child.value === "<u>") opens.push(offset);
          if (child.value === "</u>") {
            const open = opens.pop();
            if (open !== undefined)
              spans.push({
                format: "underline",
                from: open,
                inner: open + 3,
                end: offset,
                to: offset + 4,
              });
          }
        }
        visit(child);
      }
    }
  }
  visit(parseMarkdownSyntax(text, { math: false }));
  return spans;
}

export function applyInlineFormat(
  text: string,
  selection: TextSelection,
  format: InlineFormat,
): CommandResult {
  const { start, end } = selection;
  const raw = text.slice(start, end);
  const spans = inlineSpans(text);
  const edits = spans.filter((span) => {
    const wrapped = span.inner === start && span.end === end;
    return format === "clear"
      ? wrapped || (span.from >= start && span.to <= end)
      : format === span.format && (wrapped || (span.from === start && span.to === end));
  });
  if (edits.length) {
    const removed = edits
      .flatMap(
        (span) =>
          [
            [span.from, span.inner],
            [span.end, span.to],
          ] as const,
      )
      .sort((a, b) => a[0] - b[0]);
    const mapPoint = (point: number) =>
      removed.reduce((n, [a, b]) => n - Math.max(0, Math.min(b, point) - a), point);
    const parts: string[] = [];
    let cursor = 0;
    for (const [a, b] of removed) {
      parts.push(text.slice(cursor, a));
      cursor = b;
    }
    return {
      text: parts.join("") + text.slice(cursor),
      selection: { start: mapPoint(start), end: mapPoint(end) },
    };
  }
  // Empty delimiters such as **** have no inline node until the user types.
  if (start === end) {
    for (const [key, pairs] of Object.entries(wrappers)) {
      if (format !== "clear" && key !== format) continue;
      for (const [left, right] of pairs) {
        if (
          start >= left.length &&
          text.startsWith(left, start - left.length) &&
          text.startsWith(right, start)
        )
          return splice(text, start - left.length, start + right.length, "", 0);
      }
    }
  }
  if (format === "clear") return { text, selection };
  let [left, right]: [string, string] = [...wrappers[format][0]];
  if (format === "code" && raw.includes("`")) {
    const length = [...raw.matchAll(/`+/g)].reduce(
      (n, match) => Math.max(n, match[0].length + 1),
      1,
    );
    const pad =
      raw.startsWith("`") || raw.endsWith("`") || (raw.startsWith(" ") && raw.endsWith(" "))
        ? " "
        : "";
    left = "`".repeat(length) + pad;
    right = pad + "`".repeat(length);
  }
  return splice(text, start, end, left + raw + right, left.length, left.length + raw.length);
}
