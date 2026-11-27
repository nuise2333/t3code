import type { CommandResult } from "./markdownCommands";

export type TableOperation =
  | "rowAbove"
  | "rowBelow"
  | "columnLeft"
  | "columnRight"
  | "deleteRow"
  | "deleteColumn"
  | "alignLeft"
  | "alignCenter"
  | "alignRight";

function parseRow(line: string) {
  const pipes = [...line.matchAll(/\\.|\|/g)]
    .filter((match) => match[0] === "|")
    .map((match) => match.index);
  const cells: string[] = [];
  let start = 0;
  for (const pipe of pipes) {
    cells.push(line.slice(start, pipe));
    start = pipe + 1;
  }
  cells.push(line.slice(start));
  const prefix = pipes.length && !cells[0]!.trim() ? cells.shift() + "|" : "";
  const suffix = pipes.length && !cells.at(-1)?.trim() ? "|" + cells.pop() : "";
  return { cells, prefix, suffix };
}

function changeAlignment(cell: string, op: TableOperation) {
  const marker = cell.trim();
  const left = op !== "alignRight" ? ":" : "";
  const right = op !== "alignLeft" ? ":" : "";
  return cell.replace(
    marker,
    left + "-".repeat(Math.max(1, marker.length - left.length - right.length)) + right,
  );
}

export function tableEdit(text: string, caret: number, op: TableOperation): CommandResult {
  const segments = text.split(/(\r\n|[\r\n])/);
  const eol = segments[1] ?? "\n";
  const terminal = segments.at(-1) === "";
  const rows = [];
  for (let i = 0; i < segments.length; i += 2) {
    if (terminal && i === segments.length - 1) break;
    rows.push({ ...parseRow(segments[i]!), eol: segments[i + 1] ?? "" });
  }
  const header = rows[0];
  const delimiter = rows[1];
  if (
    !header ||
    !delimiter ||
    !header.cells.length ||
    header.cells.length !== delimiter.cells.length ||
    delimiter.cells.some((cell) => !/^:?-+:?$/.test(cell.trim()))
  )
    return { refused: "Select a Markdown table." };
  const preceding = text.slice(0, caret).split(/\r\n|[\r\n]/);
  const index = Math.min(preceding.length - 1, rows.length - 1);
  const row = rows[index]!;
  let right = row.prefix.length;
  const x = preceding.at(-1)!.length;
  const at = row.cells.findIndex((cell) => {
    right += cell.length + 1;
    return x < right;
  });
  const column = Math.max(0, Math.min(at < 0 ? row.cells.length - 1 : at, header.cells.length - 1));
  let focusRow = index;
  let focusCol = column;
  if (op === "rowAbove" || op === "rowBelow") {
    const template = index === 1 ? header : row;
    const blank = {
      ...template,
      cells: delimiter.cells.map((cell) => " ".repeat(cell.length)),
    };
    if (op === "rowAbove" && index === 0) {
      rows[0] = blank;
      rows.splice(2, 0, header);
      focusRow = 0;
    } else {
      focusRow = Math.max(2, index + Number(op === "rowBelow"));
      rows.splice(focusRow, 0, blank);
    }
  } else if (op === "deleteRow") {
    if (index === 1) return { refused: "The alignment row is required." };
    if (index === 0) {
      if (!rows[2]) return { refused: "Keep at least one table row." };
      const next = rows.splice(2, 1)[0]!;
      next.cells.length = header.cells.length;
      rows[0] = next;
    } else {
      rows.splice(index, 1);
      focusRow = index === 2 && rows.length === 2 ? 0 : Math.min(index, rows.length - 1);
    }
  } else if (op.startsWith("align")) {
    const old = delimiter.cells[column]!.length;
    delimiter.cells[column] = changeAlignment(delimiter.cells[column]!, op);
    // Only widen padding in a previously aligned column when the new marker needs more room.
    const added = delimiter.cells[column]!.length - old;
    if (added > 0 && rows.every((r, i) => i === 1 || r.cells[column]?.length === old)) {
      for (const [i, r] of rows.entries()) if (i !== 1) r.cells[column] += " ".repeat(added);
    }
  } else if (op === "deleteColumn") {
    if (header.cells.length === 1) return { refused: "Keep at least one table column." };
    for (const r of rows) {
      r.cells.splice(column, 1);
      if (r.cells.length <= 1 && !r.prefix && !r.suffix) {
        r.prefix = "|";
        r.suffix = "|";
      }
    }
    focusCol = Math.min(column, header.cells.length - 1);
  } else {
    focusCol = column + Number(op === "columnRight");
    const divider = delimiter.cells[column]!.replace(/:/g, "-");
    // A common width keeps formerly aligned pipes in the same column on every row.
    const width = divider.length;
    for (const [i, r] of rows.entries()) {
      while (r.cells.length < focusCol) r.cells.push("");
      r.cells.splice(focusCol, 0, i === 1 ? divider : " ".repeat(width));
    }
  }
  const output = rows.map((r, i) => {
    const ending = i === rows.length - 1 && !terminal ? "" : r.eol || eol;
    return r.prefix + r.cells.join("|") + r.suffix + ending;
  });
  const focus = rows[focusRow]!;
  const before = output.slice(0, focusRow).reduce((n, line) => n + line.length, 0);
  const pos =
    before +
    focus.prefix.length +
    focus.cells.slice(0, focusCol).reduce((n, cell) => n + cell.length + 1, 0);
  return { text: output.join(""), selection: { start: pos, end: pos } };
}
