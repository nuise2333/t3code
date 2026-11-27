import { parseDiffFromFile } from "@pierre/diffs";

interface Change {
  from: number;
  to: number;
  lines: string[];
  side: "local" | "disk";
}

function changes(base: string, variant: string, side: Change["side"]): Change[] {
  if (base === variant) return [];
  const diff = parseDiffFromFile(
    { name: "document", contents: base },
    { name: "document", contents: variant },
    { context: 0, disableLineMatching: true },
  );
  return diff.hunks.map((hunk) => {
    // Unified diff locates a zero-length old range on the line preceding the insertion.
    const from = hunk.deletionLineIndex + Number(hunk.deletionCount === 0);
    return {
      from,
      to: from + hunk.deletionCount,
      side,
      lines: diff.additionLines.slice(
        hunk.additionLineIndex,
        hunk.additionLineIndex + hunk.additionCount,
      ),
    };
  });
}

function render(base: string[], start: number, end: number, edits: Change[]) {
  const parts: string[] = [];
  for (const edit of edits) {
    parts.push(base.slice(start, edit.from).join(""), edit.lines.join(""));
    start = edit.to;
  }
  return parts.join("") + base.slice(start, end).join("");
}

function terminate(value: string) {
  return value && !value.endsWith("\n") ? value + "\n" : value;
}

export function mergeThreeWay(base: string, local: string, disk: string) {
  const eol = local.match(/\r\n|\n|\r/)?.[0] ?? base.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const normalize = (s: string) => s.replace(/\r\n?/g, "\n");
  const original = normalize(base);
  const left = normalize(local);
  const right = normalize(disk);
  if (left === right || right === original) return { merged: local, conflicts: 0 };
  if (left === original) return { merged: right.replaceAll("\n", eol), conflicts: 0 };
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const edits = [...changes(original, left, "local"), ...changes(original, right, "disk")].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  );
  const result: string[] = [];
  let conflicts = 0;
  let cursor = 0;
  for (let i = 0; i < edits.length;) {
    const first = edits[i++]!;
    const group = [first];
    let end = first.to;
    while (i < edits.length) {
      const next = edits[i]!;
      if (next.from >= end && !(next.from === first.from && end === first.from && next.to === end))
        break;
      group.push(next);
      end = Math.max(end, next.to);
      i++;
    }
    result.push(lines.slice(cursor, first.from).join(""));
    const a = group.filter((edit) => edit.side === "local");
    const b = group.filter((edit) => edit.side === "disk");
    const ours = render(lines, first.from, end, a);
    const theirs = render(lines, first.from, end, b);
    if (!a.length) result.push(theirs);
    else if (!b.length || ours === theirs) result.push(ours);
    else {
      result.push(
        "<<<<<<< Local\n",
        terminate(ours),
        "=======\n",
        terminate(theirs),
        ">>>>>>> Disk\n",
      );
      conflicts++;
    }
    cursor = end;
  }
  result.push(lines.slice(cursor).join(""));
  const parts = result.filter(Boolean);
  // A side may remove its final newline while the other appends lines at that boundary.
  const merged = parts.map((part, i) => (i + 1 < parts.length ? terminate(part) : part)).join("");
  return { merged: merged.replaceAll("\n", eol), conflicts };
}
