import { breakLines, type BreakOptions, type LineBreak } from "./breaker";
import { hangFraction } from "./classify";
import { buildItems, type BoxItem, type GlueItem, type InlineRun, type Item } from "./items";
import type { TextMeasurer } from "./measure";

export interface TypesetOptions {
  /** Width of the column in px. */
  readonly width: number;
  /** Body font size in px; the 20 em no-justify threshold scales with it. */
  readonly em: number;
  /** Defaults to true. False sets every line left aligned at natural spacing. */
  readonly justify?: boolean;
  /** Indent of the first line in px. */
  readonly firstLineIndent?: number;
  /** Space between upright and italic Han in em: 0.02 beside a Song face, 0.04 beside a Hei face. */
  readonly hanItalicSeam?: number;
}

/** A stretch of one text run, set as one inline element `marginLeft + advance + marginRight` wide. */
export interface TextPiece {
  readonly kind: "text";
  /** Index into the `runs` passed to `typesetParagraph`. */
  readonly run: number;
  /** Range of the run's text this piece covers. */
  readonly start: number;
  readonly end: number;
  /** What to render. Source white space is collapsed, so this can differ from the source range. */
  readonly text: string;
  /** Width of `text` as set, including `wordSpacing` per space and `letterSpacing` per inner gap. */
  readonly advance: number;
  /** Extra width of every space in `text`, as CSS `word-spacing`. */
  readonly wordSpacing: number;
  /**
   * Extra width between adjacent characters, as CSS `letter-spacing`. CSS also adds it after the
   * last character, which `advance` does not count: subtract it from the right margin.
   */
  readonly letterSpacing: number;
  /**
   * Space outside the glyphs that is not a typed space: the automatic Han to Latin gap, a Han gap
   * next to another piece, and minus the trimmed blank half of a full-width mark. A negative left
   * margin pulls an opening mark's glyph left; a negative right margin overlaps a closing mark.
   */
  readonly marginLeft: number;
  readonly marginRight: number;
}

/** An atom run in place, `marginLeft + advance + marginRight` wide. */
export interface AtomPiece {
  readonly kind: "atom";
  readonly run: number;
  readonly advance: number;
  readonly marginLeft: number;
  readonly marginRight: number;
}

export type LinePiece = TextPiece | AtomPiece;

/** One line: render it as a non-wrapping inline-block as wide as the column. */
export interface TypesetLine {
  /**
   * Pieces in visual order, laid out from `indent`. A line broken at a space ends with a
   * zero-advance piece holding that space, so copied text keeps it.
   */
  readonly pieces: ReadonlyArray<LinePiece>;
  readonly indent: number;
  /** Total width of the pieces and the hyphen as set. */
  readonly width: number;
  readonly naturalWidth: number;
  /** Adjustment ratio applied to this line's glue: above 0 stretched, below 0 shrunk, 0 natural. */
  readonly ratio: number;
  /**
   * How far the last mark overflows the column on the right. The line was justified to the
   * column width plus this, so nothing needs to move: let it overflow.
   */
  readonly hang: number;
  /** A hyphen to draw after the last piece, in the font of run `run`; not part of any `text`. */
  readonly hyphen: { readonly run: number; readonly advance: number } | undefined;
}

export interface TypesetParagraph {
  readonly lines: ReadonlyArray<TypesetLine>;
  /** False when set left aligned at natural spacing: narrow column, `justify: false`, mostly code. */
  readonly isJustified: boolean;
}

const NO_JUSTIFY_BELOW_EM = 20;
const NO_JUSTIFY_CODE_SHARE = 0.45;
const RAGGED_STRETCH_EM = 2;
const TOLERANCE = 10;
const MAX_CACHED_PARAGRAPHS = 2_000;

interface Spring {
  width: number;
  stretch: number;
  shrink: number;
}

interface Draft {
  readonly run: number;
  readonly isAtom: boolean;
  readonly start: number;
  end: number;
  text: string;
  readonly atomAdvance: number;
  spaces: number;
  spaceGlue: GlueItem | undefined;
  letterGaps: number;
  letterGlue: GlueItem | undefined;
  isLetterSpaced: boolean;
  isCollapsed: boolean;
  readonly fixedLeft: number;
  fixedRight: number;
  readonly left: Spring;
  readonly right: Spring;
}

const spring = (): Spring => ({ width: 0, stretch: 0, shrink: 0 });
const isEmpty = (value: Spring) => value.width === 0 && value.stretch === 0 && value.shrink === 0;
const addGlue = (into: Spring, glue: Spring) => {
  into.width += glue.width;
  into.stretch += glue.stretch;
  into.shrink += glue.shrink;
};
const sameGlue = (a: GlueItem | undefined, b: GlueItem) =>
  a === undefined || (a.width === b.width && a.stretch === b.stretch && a.shrink === b.shrink);
const adjustment = (glue: Spring, ratio: number) =>
  ratio > 0 ? ratio * glue.stretch : ratio * glue.shrink;

function draftOf(box: BoxItem, left: Spring): Draft {
  return {
    run: box.run,
    isAtom: box.isAtom,
    start: box.start,
    end: box.end,
    text: box.text,
    atomAdvance: box.isAtom ? box.width : 0,
    spaces: 0,
    spaceGlue: undefined,
    letterGaps: 0,
    letterGlue: undefined,
    isLetterSpaced: box.isLetterSpaced,
    isCollapsed: false,
    fixedLeft: box.marginLeft,
    fixedRight: box.marginRight,
    left,
    right: spring(),
  };
}

function spaceDraft(glue: GlueItem, isCollapsed: boolean): Draft {
  return {
    run: glue.run,
    isAtom: false,
    start: glue.start,
    end: glue.end,
    text: " ",
    atomAdvance: 0,
    spaces: 1,
    spaceGlue: glue,
    letterGaps: 0,
    letterGlue: undefined,
    isLetterSpaced: false,
    isCollapsed,
    fixedLeft: 0,
    fixedRight: 0,
    left: spring(),
    right: spring(),
  };
}

const acceptsMore = (draft: Draft | undefined, run: number, at: number): draft is Draft =>
  draft !== undefined &&
  !draft.isAtom &&
  !draft.isCollapsed &&
  draft.run === run &&
  draft.end === at &&
  draft.fixedRight === 0 &&
  isEmpty(draft.right);

/** Groups a line's items into pieces; glue becomes word spacing, letter spacing or margins. */
function draftLine(items: ReadonlyArray<Item>, line: LineBreak, isRigid: boolean) {
  const drafts: Array<Draft> = [];
  let last: Draft | undefined;
  let pendingSpace: GlueItem | undefined;
  let pendingLetterGap: GlueItem | undefined;
  let lead = spring();

  for (let index = line.start; index < line.end; index += 1) {
    const item = items[index]!;
    if (item.type === "penalty") continue;
    if (item.type === "glue") {
      if (item.run >= 0) {
        if (
          acceptsMore(last, item.run, item.start) &&
          last.letterGlue === undefined &&
          sameGlue(last.spaceGlue, item)
        ) {
          last.text += " ";
          last.end = item.end;
          last.spaces += 1;
          last.spaceGlue = item;
          last.isLetterSpaced = false;
        } else {
          pendingSpace = item;
        }
      } else if (item.isLetterGap) {
        if (!isRigid) pendingLetterGap = item;
      } else if (last !== undefined && pendingSpace === undefined) {
        addGlue(last.right, item);
      } else {
        addGlue(lead, item);
      }
      continue;
    }

    const isPlain = !item.isAtom && item.marginLeft === 0 && isEmpty(lead);
    if (pendingSpace !== undefined) {
      const space = spaceDraft(pendingSpace, false);
      if (isPlain && item.run === pendingSpace.run && item.start === pendingSpace.end) {
        space.text += item.text;
        space.end = item.end;
        space.fixedRight = item.marginRight;
        drafts.push(space);
        last = space;
        pendingSpace = undefined;
        continue;
      }
      drafts.push(space);
      last = space;
      pendingSpace = undefined;
    } else if (pendingLetterGap !== undefined) {
      const gap = pendingLetterGap;
      pendingLetterGap = undefined;
      if (
        isPlain &&
        item.isLetterSpaced &&
        item.marginRight === 0 &&
        acceptsMore(last, item.run, item.start) &&
        last.isLetterSpaced &&
        last.spaces === 0 &&
        sameGlue(last.letterGlue, gap)
      ) {
        last.text += item.text;
        last.end = item.end;
        last.letterGaps += 1;
        last.letterGlue = gap;
        continue;
      }
      if (last === undefined) addGlue(lead, gap);
      else addGlue(last.right, gap);
    } else if (
      isPlain &&
      acceptsMore(last, item.run, item.start) &&
      last.letterGlue === undefined
    ) {
      last.text += item.text;
      last.end = item.end;
      last.isLetterSpaced = false;
      last.fixedRight = item.marginRight;
      continue;
    }
    last = draftOf(item, lead);
    lead = spring();
    drafts.push(last);
  }
  if (pendingSpace !== undefined) drafts.push(spaceDraft(pendingSpace, false));
  const breakItem = items[line.end];
  if (breakItem?.type === "glue" && breakItem.run >= 0) drafts.push(spaceDraft(breakItem, true));
  return drafts;
}

function hangOf(
  items: ReadonlyArray<Item>,
  line: LineBreak,
  font: (run: number) => string,
  measurer: TextMeasurer,
) {
  const breakItem = items[line.end];
  if (breakItem?.type === "penalty" && breakItem.width > 0) return 0;
  const box = items[line.end - 1];
  if (box?.type !== "box" || box.isAtom || line.end - 1 < line.start) return 0;
  const lastOffset = box.lastStart - box.start;
  const fraction = hangFraction(box.text.codePointAt(lastOffset) ?? 0);
  if (fraction === 0) return 0;
  if (lastOffset === 0) return fraction * box.width;
  const runFont = font(box.run);
  return (
    fraction *
    (measurer.advance(box.text, runFont) - measurer.advance(box.text.slice(0, lastOffset), runFont))
  );
}

function setLine(
  items: ReadonlyArray<Item>,
  runs: ReadonlyArray<InlineRun>,
  measurer: TextMeasurer,
  line: LineBreak,
  lineWidth: number,
  indent: number,
  isJustified: boolean,
): TypesetLine {
  const font = (run: number) => {
    const source = runs[run];
    return source?.kind === "text" ? source.font : "";
  };
  let itemsWidth = 0;
  for (let index = line.start; index < line.end; index += 1) {
    const item = items[index]!;
    if (item.type !== "penalty") itemsWidth += item.width;
  }
  const breakItem = items[line.end];
  const hyphenAdvance = breakItem?.type === "penalty" && breakItem.flagged ? breakItem.width : 0;
  const isRigid = !isJustified || (line.isNatural && itemsWidth + hyphenAdvance <= lineWidth);
  const drafts = draftLine(items, line, isRigid);

  const total = spring();
  total.width = hyphenAdvance;
  const measured = drafts.map((draft) => {
    if (draft.isAtom) {
      total.width += draft.atomAdvance;
      addGlue(total, draft.left);
      addGlue(total, draft.right);
      return { advance: draft.atomAdvance, wordSpacing: 0 };
    }
    const runFont = font(draft.run);
    const glyphs = measurer.advance(draft.text, runFont);
    const spaceGlue = draft.spaceGlue;
    const wordSpacing = draft.isCollapsed
      ? -glyphs
      : spaceGlue === undefined
        ? 0
        : spaceGlue.width - measurer.spaceAdvance(runFont);
    const advance =
      glyphs + draft.spaces * wordSpacing + draft.letterGaps * (draft.letterGlue?.width ?? 0);
    total.width += advance + draft.fixedLeft + draft.fixedRight;
    addGlue(total, draft.left);
    addGlue(total, draft.right);
    if (!draft.isCollapsed && spaceGlue !== undefined) {
      total.stretch += draft.spaces * spaceGlue.stretch;
      total.shrink += draft.spaces * spaceGlue.shrink;
    }
    total.stretch += draft.letterGaps * (draft.letterGlue?.stretch ?? 0);
    total.shrink += draft.letterGaps * (draft.letterGlue?.shrink ?? 0);
    return { advance, wordSpacing };
  });

  const hang = isJustified && !line.isNatural ? hangOf(items, line, font, measurer) : 0;
  const difference = lineWidth + hang - total.width;
  let ratio = 0;
  if (!isRigid) {
    if (difference < 0) ratio = total.shrink > 0 ? Math.max(difference / total.shrink, -1) : 0;
    else if (!line.isNatural && total.stretch > 0) ratio = difference / total.stretch;
  }

  let width = hyphenAdvance;
  const pieces = drafts.map((draft, index): LinePiece => {
    const { advance, wordSpacing } = measured[index]!;
    const marginLeft = draft.fixedLeft + draft.left.width + adjustment(draft.left, ratio);
    const marginRight = draft.fixedRight + draft.right.width + adjustment(draft.right, ratio);
    if (draft.isAtom) {
      width += marginLeft + advance + marginRight;
      return { kind: "atom", run: draft.run, advance, marginLeft, marginRight };
    }
    const spaceAdjustment =
      draft.spaceGlue === undefined || draft.isCollapsed ? 0 : adjustment(draft.spaceGlue, ratio);
    const letterAdjustment =
      draft.letterGlue === undefined ? 0 : adjustment(draft.letterGlue, ratio);
    const set = advance + draft.spaces * spaceAdjustment + draft.letterGaps * letterAdjustment;
    width += marginLeft + set + marginRight;
    return {
      kind: "text",
      run: draft.run,
      start: draft.start,
      end: draft.end,
      text: draft.text,
      advance: set,
      wordSpacing: wordSpacing + spaceAdjustment,
      letterSpacing: (draft.letterGlue?.width ?? 0) + letterAdjustment,
      marginLeft,
      marginRight,
    };
  });

  let hyphen: TypesetLine["hyphen"];
  if (hyphenAdvance > 0) {
    const box = items[line.end - 1];
    hyphen = { run: box?.type === "box" ? box.run : 0, advance: hyphenAdvance };
  }
  return { pieces, indent, width, naturalWidth: total.width, ratio, hang, hyphen };
}

function codeShare(runs: ReadonlyArray<InlineRun>) {
  let code = 0;
  let all = 0;
  for (const run of runs) {
    if (run.kind !== "text") continue;
    all += run.text.length;
    if (run.isCode === true) code += run.text.length;
  }
  return all === 0 ? 0 : code / all;
}

function contentKey(runs: ReadonlyArray<InlineRun>) {
  let key = "";
  for (const run of runs) {
    if (run.kind === "text") {
      const flags = (run.isCode === true ? 1 : 0) + (run.isItalic === true ? 2 : 0);
      key += `t${flags}\u0002${run.fontSize}\u0002${run.font}\u0002${run.text}\u0001`;
    } else if (run.kind === "atom") {
      key += `a${run.advance}\u0001`;
    } else {
      key += "b\u0001";
    }
  }
  return key;
}

interface CachedParagraph {
  readonly items: Array<Item>;
  readonly results: Map<string, TypesetParagraph>;
}

const caches = new WeakMap<TextMeasurer, Map<string, CachedParagraph>>();

function typesetUncached(
  runs: ReadonlyArray<InlineRun>,
  options: TypesetOptions,
  measurer: TextMeasurer,
  plainItems: Array<Item>,
): TypesetParagraph {
  const width = Number.isFinite(options.width) ? Math.max(options.width, 0) : 0;
  const indent = Math.min(Math.max(options.firstLineIndent ?? 0, 0), width);
  const isJustified =
    options.justify !== false &&
    width >= NO_JUSTIFY_BELOW_EM * options.em &&
    codeShare(runs) < NO_JUSTIFY_CODE_SHARE;
  const breakOptions: BreakOptions = {
    width,
    firstLineWidth: width - indent,
    ragged: !isJustified,
    raggedStretch: RAGGED_STRETCH_EM * options.em,
    tolerance: TOLERANCE,
    isLastResort: false,
  };

  let items = plainItems;
  let breaks = breakLines(items, breakOptions);
  if (breaks === undefined) {
    items = buildItems(runs, measurer, {
      hanItalicSeam: options.hanItalicSeam ?? 0,
      splitWidth: width - indent,
    });
    breaks =
      breakLines(items, breakOptions) ??
      breakLines(items, { ...breakOptions, isLastResort: true }) ??
      [];
  }
  const lines = breaks.map((line, index) =>
    setLine(
      items,
      runs,
      measurer,
      line,
      index === 0 ? width - indent : width,
      index === 0 ? indent : 0,
      isJustified,
    ),
  );
  return { lines, isJustified };
}

/**
 * Sets one paragraph: builds boxes, glue and penalties from the inline runs, chooses breaks by
 * total fit and returns every line as positioned pieces (see `TypesetLine`).
 *
 * Results are cached per measurer by run content and options, so a measurer must be replaced
 * when its answers change, for example after a web font finishes loading.
 */
export function typesetParagraph(
  runs: ReadonlyArray<InlineRun>,
  options: TypesetOptions,
  measurer: TextMeasurer,
): TypesetParagraph {
  let cache = caches.get(measurer);
  if (cache === undefined) {
    cache = new Map();
    caches.set(measurer, cache);
  }
  const seam = options.hanItalicSeam ?? 0;
  const key = `${seam}\u0001${contentKey(runs)}`;
  let cached = cache.get(key);
  if (cached === undefined) {
    if (cache.size >= MAX_CACHED_PARAGRAPHS) cache.clear();
    cached = {
      items: buildItems(runs, measurer, { hanItalicSeam: seam }),
      results: new Map(),
    };
    cache.set(key, cached);
  }
  const layoutKey = `${options.width}|${options.em}|${options.justify !== false}|${options.firstLineIndent ?? 0}`;
  let result = cached.results.get(layoutKey);
  if (result === undefined) {
    result = typesetUncached(runs, options, measurer, cached.items);
    // Only the latest width is worth keeping: a resize revisits widths rarely.
    cached.results.clear();
    cached.results.set(layoutKey, result);
  }
  return result;
}
