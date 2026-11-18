import { hasRightToLeftText, type InlineStyle } from "../readerFlow";
import type { InlineRun } from "../typeset";
import { scriptClass } from "../typeset/classify";
import type {
  InlineAnalysis,
  InlineRange,
  InlineReveal,
  InlineStyleKind,
} from "./markdownFileInline";

export interface EditorTextRun {
  readonly kind: "text";
  /** What the engine sets: the shown characters, with white space as the reader's text has it. */
  readonly text: string;
  /** The leaf text offset of each character of `text`. */
  readonly sources: Int32Array;
  /** The styles around the run, outermost first, as element names: the font's key. */
  readonly kinds: string;
  readonly isCode: boolean;
}

export type EditorFlowRun = EditorTextRun | { readonly kind: "break" };

export interface EditorFlow {
  readonly runs: ReadonlyArray<EditorFlowRun>;
  /** White space the engine sets at no width (a source line end between Han): hide it. */
  readonly gone: ReadonlyArray<InlineRange>;
}

const STYLE_TAGS: Record<InlineStyleKind, string> = {
  strong: "strong",
  em: "em",
  del: "del",
  code: "code",
  mark: "mark",
  sup: "sup",
  sub: "sub",
  a: "a",
};

export const styleTag = (kind: InlineStyleKind) => STYLE_TAGS[kind];

const isWhite = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\n" || char === "\r";
const isLineEnding = (char: string | undefined) => char === "\n" || char === "\r";
// Shown as written, extra spaces are set as fixed boxes the engine does not collapse.
const SHOWN_SPACE = " ";

/** Which characters of a leaf's text are not drawn: hidden markers. */
function hiddenCharacters(
  text: string,
  analysis: InlineAnalysis,
  reveal: InlineReveal,
): Uint8Array {
  const hidden = new Uint8Array(text.length);
  analysis.markers.forEach((marker, index) => {
    if (!reveal.markers.has(index)) hidden.fill(1, marker.from, marker.to);
  });
  return hidden;
}

/**
 * A leaf's shown text as the reading view's runs: split where the styles around the text change
 * and at hard breaks, without hidden markers, and with the white space around a source line end
 * reduced to the line end, as the reader's Markdown to HTML step trims it. Null when the
 * engine cannot set it (right-to-left text).
 */
export function editorFlow(
  text: string,
  analysis: InlineAnalysis,
  reveal: InlineReveal,
): EditorFlow | null {
  if (hasRightToLeftText(text)) return null;
  const hidden = hiddenCharacters(text, analysis, reveal);
  const hardBreaks = new Map<number, number>();
  for (const lineBreak of analysis.breaks) {
    if (!lineBreak.hard) continue;
    hardBreaks.set(
      lineBreak.at,
      text[lineBreak.at] === "\r" && text[lineBreak.at + 1] === "\n" ? 2 : 1,
    );
  }
  const shownSpace = new Uint8Array(text.length);
  analysis.collapsed.forEach((range, index) => {
    if (reveal.spaces.has(index)) shownSpace.fill(1, range.from, range.to);
  });

  // Styles are recorded parent first, so the ones around a character, in order, run outermost
  // first and the last is the innermost.
  const { styles } = analysis;
  const innermost = new Int32Array(text.length).fill(-1);
  styles.forEach((style, index) => innermost.fill(index, style.innerFrom, style.innerTo));
  const paths = new Map<number, ReadonlyArray<number>>();
  const cachedPath = (at: number) => {
    const style = innermost[at]!;
    let path = paths.get(style);
    if (!path) {
      path = styles.flatMap((candidate, index) =>
        candidate.innerFrom <= at && at < candidate.innerTo ? [index] : [],
      );
      paths.set(style, path);
    }
    return path;
  };

  const runs: EditorFlowRun[] = [];
  const gone: InlineRange[] = [];
  let runText = "";
  let runSources: number[] = [];
  let runStyle = Number.NaN;
  const flush = () => {
    if (runText === "") return;
    const path = cachedPath(runSources[0]!);
    runs.push({
      kind: "text",
      text: runText,
      sources: Int32Array.from(runSources),
      kinds: path.map((index) => STYLE_TAGS[styles[index]!.kind]).join(">"),
      isCode: path.some((index) => styles[index]!.kind === "code"),
    });
    runText = "";
    runSources = [];
  };
  const push = (char: string, at: number) => {
    const style = innermost[at]!;
    if (style !== runStyle) {
      flush();
      runStyle = style;
    }
    runText += char;
    runSources.push(at);
  };
  let previousShown = -1;
  const nextShown = (from: number) => {
    let at = from;
    while (at < text.length && (hidden[at] === 1 || isWhite(text[at]))) at++;
    return at;
  };

  for (let at = 0; at < text.length; at++) {
    if (hidden[at] === 1) continue;
    const width = hardBreaks.get(at);
    if (width !== undefined) {
      flush();
      runs.push({ kind: "break" });
      runStyle = Number.NaN;
      at += width - 1;
      continue;
    }
    const char = text[at]!;
    if (!isWhite(char)) {
      push(char, at);
      previousShown = at;
      continue;
    }
    let end = at;
    while (end < text.length && hidden[end] !== 1 && isWhite(text[end]) && !hardBreaks.has(end)) {
      end++;
    }
    let hasLineEnding = false;
    for (let index = at; index < end; index++) hasLineEnding ||= isLineEnding(text[index]);
    if (hasLineEnding) {
      const after = nextShown(end);
      const isHan = (index: number) =>
        index >= 0 && index < text.length && scriptClass(text.codePointAt(index)!) === "han";
      if (isHan(previousShown) && isHan(after)) gone.push({ from: at, to: end });
      for (let index = at; index < end; index++) {
        if (isLineEnding(text[index])) push(text[index]!, index);
      }
    } else {
      for (let index = at; index < end; index++) {
        const shownAsWritten = shownSpace[index] === 1 && index > at;
        push(shownAsWritten ? SHOWN_SPACE : text[index]!, index);
      }
    }
    at = end - 1;
  }
  flush();
  return { runs, gone };
}

/** The flow's runs for the engine, with each run's font; null when a font is not known yet. */
export function editorInlineRuns(
  flow: EditorFlow,
  fontOf: (kinds: string) => InlineStyle | undefined,
): InlineRun[] | null {
  const runs: InlineRun[] = [];
  for (const run of flow.runs) {
    if (run.kind === "break") {
      runs.push(run);
      continue;
    }
    const style = fontOf(run.kinds);
    if (!style) return null;
    runs.push({
      kind: "text",
      text: run.text,
      font: style.font,
      fontSize: style.fontSize,
      isCode: run.isCode,
      isItalic: style.isItalic,
    });
  }
  return runs;
}
