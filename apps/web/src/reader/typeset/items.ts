import {
  isClusterExtender,
  isDigit,
  isLatinLetter,
  isSpace,
  punctuationSide,
  scriptClass,
  type PunctuationSide,
  type ScriptClass,
} from "./classify";
import { hyphenationPoints } from "./hyphenate";
import {
  canBreakAcrossSpace,
  canBreakBetween,
  lineBreakClass,
  type LineBreakClass,
} from "./lineBreak";
import type { TextMeasurer } from "./measure";

export interface TextRun {
  readonly kind: "text";
  readonly text: string;
  /** Font key handed to the measurer; it should resolve Han and Latin faces like the DOM will. */
  readonly font: string;
  /** Font size in px. Every em-based rule that touches this run uses it. */
  readonly fontSize: number;
  readonly isCode?: boolean;
  readonly isItalic?: boolean;
}

/** An opaque inline box such as inline math or an image; it sides with Latin text. */
export interface AtomRun {
  readonly kind: "atom";
  readonly advance: number;
}

/** A hard line break. The line before it is set like a last line. */
export interface BreakRun {
  readonly kind: "break";
}

export type InlineRun = TextRun | AtomRun | BreakRun;

export interface BoxItem {
  readonly type: "box";
  readonly width: number;
  readonly run: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Fixed negative margins that set a full-width mark at half width. */
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly isAtom: boolean;
  /** May join its neighbours across letter gaps: a Han character or one character of a split run. */
  readonly isLetterSpaced: boolean;
  /** Start of the last character, for measuring a line-end mark on its own. */
  readonly lastStart: number;
}

export interface GlueItem {
  readonly type: "glue";
  readonly width: number;
  readonly stretch: number;
  readonly shrink: number;
  /** A gap between characters with no natural width, which can be set as letter spacing. */
  readonly isLetterGap: boolean;
  /** Source white space this glue stands for; `run` is -1 when it stands for none. */
  readonly run: number;
  readonly start: number;
  readonly end: number;
}

export interface PenaltyItem {
  readonly type: "penalty";
  readonly width: number;
  readonly cost: number;
  readonly flagged: boolean;
}

export type Item = BoxItem | GlueItem | PenaltyItem;

export const FORBIDDEN_BREAK = 10_000;
export const FORCED_BREAK = -10_000;

const HYPHEN_PENALTY = 50;
const CODE_BREAK_PENALTY = 100;
const SPLIT_PENALTY = 900;
const SPLIT_STRETCH_EM = 0.02;
const SPLIT_MIN_EM = 4;

const HAN_STRETCH_EM = 0.05;
const HAN_SHRINK_EM = 0.04;
const GAP_EM = 0.25;
const GAP_STRETCH_EM = 0.25;
const GAP_SHRINK_EM = 0.03;
const CODE_SLIT_EM = 0.125;
const MARK_BOX_EM = 0.5;
const MARK_SQUEEZE_EM = 0.5;
const MARK_MIN_EXCESS_EM = 0.01;

export interface ItemOptions {
  /** Extra space, in em, between upright and italic Han; depends on the Han italic face. */
  readonly hanItalicSeam?: number;
  /** Lowers the width from which an unbreakable stretch is split, for columns narrower than it. */
  readonly splitWidth?: number;
}

interface Neighbour {
  readonly run: number;
  readonly cp: number;
  readonly end: number;
  readonly script: ScriptClass;
  readonly lineBreak: LineBreakClass;
  readonly isCode: boolean;
  readonly isItalic: boolean;
  readonly isAtom: boolean;
  readonly em: number;
  /** Blank half of a closing full-width mark that has not been emitted as glue yet. */
  readonly blank: number;
}

interface Segment {
  readonly run: TextRun;
  readonly runIndex: number;
  readonly start: number;
  end: number;
  readonly clusterEnds: Array<number>;
  readonly splits: Array<{ readonly at: number; readonly penalty: PenaltyItem }>;
  isHan: boolean;
}

const NO_SOURCE = { run: -1, start: 0, end: 0 };
const NO_HYPHENS: ReadonlySet<number> = new Set();

const penalty = (cost: number, width = 0, flagged = false): PenaltyItem => ({
  type: "penalty",
  width,
  cost,
  flagged,
});

const isOpenBracket = (cp: number) => cp === 0x28 || cp === 0x5b || cp === 0x7b;
const isCloseBracket = (cp: number) => cp === 0x29 || cp === 0x5d || cp === 0x7d;
const isUpper = (cp: number) => cp >= 0x41 && cp <= 0x5a;
const isLower = (cp: number) => cp >= 0x61 && cp <= 0x7a;
const isAsciiAlnum = (cp: number) => isUpper(cp) || isLower(cp) || isDigit(cp);
const isCodeJoiner = (cp: number) => cp === 0x2e || cp === 0x3a || cp === 0x40 || cp === 0x5f;
const isCjkSide = (script: ScriptClass) => script === "han" || script === "cjkPunctuation";

function clusterEnd(text: string, start: number) {
  let end = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
  while (end < text.length) {
    const cp = text.codePointAt(end)!;
    if (!isClusterExtender(cp)) break;
    end += cp > 0xffff ? 2 : 1;
    if (cp === 0x200d && end < text.length) end += text.codePointAt(end)! > 0xffff ? 2 : 1;
  }
  return end;
}

function wordHyphens(text: string, start: number, into: Set<number>) {
  let end = start;
  while (end < text.length && isLatinLetter(text.charCodeAt(end))) end += 1;
  for (const point of hyphenationPoints(text.slice(start, end))) into.add(start + point);
  return end;
}

/** Em of the Han side when an automatic gap belongs between two neighbours, else 0. */
function gapEm(before: Neighbour, after: Neighbour) {
  const sameRun = before.run === after.run;
  const opaqueBefore = before.isCode && sameRun;
  const opaqueAfter = after.isCode && sameRun;
  const latinBefore = before.script === "latin" || (before.script === "other" && opaqueBefore);
  const latinAfter = after.script === "latin" || (after.script === "other" && opaqueAfter);
  const hanBefore = before.script === "han" && !opaqueBefore;
  const hanAfter = after.script === "han" && !opaqueAfter;
  if (latinBefore && hanAfter) return after.em;
  if (hanBefore && latinAfter) return before.em;
  if (hanBefore && isOpenBracket(after.cp) && !opaqueAfter) return before.em;
  if (isCloseBracket(before.cp) && !opaqueBefore && hanAfter) return after.em;
  return 0;
}

/**
 * Turns a paragraph's inline runs into boxes, glue and penalties. A break at a glue discards it
 * and the glue that follows, so everything expressed as glue vanishes at a line edge.
 */
export function buildItems(
  runs: ReadonlyArray<InlineRun>,
  measurer: TextMeasurer,
  options: ItemOptions = {},
): Array<Item> {
  const items: Array<Item> = [];
  const seam = Math.min(Math.max(options.hanItalicSeam ?? 0, 0), 0.5);
  const splitWidth = options.splitWidth ?? Number.POSITIVE_INFINITY;
  let previous: Neighbour | undefined;
  let segment: Segment | undefined;
  let space:
    | { run: number; start: number; end: number; advance: number; soft: boolean }
    | undefined;

  const glue = (width: number, stretch: number, shrink: number, source = NO_SOURCE) =>
    items.push({
      type: "glue",
      width,
      stretch,
      shrink,
      isLetterGap: false,
      run: source.run,
      start: source.start,
      end: source.end,
    });

  const pushBox = (
    current: Segment,
    from: number,
    to: number,
    width: number,
    lastStart: number,
    isLetterSpaced: boolean,
  ) =>
    items.push({
      type: "box",
      width,
      run: current.runIndex,
      start: from,
      end: to,
      text: current.run.text.slice(from, to),
      marginLeft: 0,
      marginRight: 0,
      isAtom: false,
      isLetterSpaced,
      lastStart,
    });

  const flush = () => {
    const current = segment;
    if (current === undefined) return;
    segment = undefined;
    const { text, font } = current.run;
    const prefix = (to: number) => measurer.advance(text.slice(current.start, to), font);
    let from = current.start;
    let measured = 0;
    let cluster = 0;
    const emit = (to: number) => {
      const total = prefix(to);
      const firstCluster = cluster;
      while (cluster < current.clusterEnds.length && current.clusterEnds[cluster]! <= to) {
        cluster += 1;
      }
      const clusters = cluster - firstCluster;
      const width = total - measured;
      const em = current.run.fontSize;
      if (clusters > 1 && width >= Math.min(SPLIT_MIN_EM * em, splitWidth)) {
        for (let index = firstCluster; index < cluster; index += 1) {
          const end = current.clusterEnds[index]!;
          const partial = prefix(end);
          if (index > firstCluster) {
            items.push(penalty(SPLIT_PENALTY));
            items.push({
              type: "glue",
              width: 0,
              stretch: SPLIT_STRETCH_EM * em,
              shrink: 0,
              isLetterGap: true,
              ...NO_SOURCE,
            });
          }
          pushBox(current, from, end, partial - measured, from, true);
          from = end;
          measured = partial;
        }
        return;
      }
      pushBox(
        current,
        from,
        to,
        width,
        clusters > 1 ? current.clusterEnds[cluster - 2]! : from,
        current.isHan && clusters === 1,
      );
      from = to;
      measured = total;
    };
    for (const split of current.splits) {
      emit(split.at);
      items.push(split.penalty);
    }
    emit(current.end);
  };

  const spaceGlue = (after: Neighbour, before: Neighbour, pending: NonNullable<typeof space>) => {
    const breakable = canBreakAcrossSpace(before.lineBreak, after.lineBreak);
    if (!breakable) items.push(penalty(FORBIDDEN_BREAK));
    if (before.blank > 0) {
      glue(before.blank, 0, before.blank, pending);
      return;
    }
    const em = gapEm(before, after);
    if (em > 0) glue(GAP_EM * em, GAP_STRETCH_EM * em, GAP_SHRINK_EM * em, pending);
    else glue(pending.advance, pending.advance / 2, pending.advance / 3, pending);
  };

  /** Emits what belongs between two adjacent characters; true when both stay in one segment. */
  const boundary = (
    before: Neighbour,
    after: Neighbour,
    side: PunctuationSide | undefined,
    blank: number,
    hyphens: ReadonlySet<number>,
    font: string,
    contiguous: boolean,
  ) => {
    const breakable = canBreakBetween(before.lineBreak, after.lineBreak);
    const guarded = (width: number, stretch: number, shrink: number, isLetterGap = false) => {
      flush();
      if (!breakable) items.push(penalty(FORBIDDEN_BREAK));
      items.push({ type: "glue", width, stretch, shrink, isLetterGap, ...NO_SOURCE });
      return false;
    };
    if (side !== undefined && before.blank > 0) {
      const merged = before.blank + blank;
      return side === "closing" ? guarded(0, 0, 0) : guarded(merged / 2, 0, merged / 4);
    }
    if (side === "opening") return guarded(blank, 0, blank);
    if (before.blank > 0) return guarded(before.blank, 0, before.blank);

    const open = contiguous && side === undefined ? segment : undefined;
    const joined = open !== undefined;
    if (open !== undefined && !after.isCode && hyphens.has(before.end)) {
      open.splits.push({
        at: before.end,
        penalty: penalty(HYPHEN_PENALTY, measurer.hyphenAdvance(font), true),
      });
      return true;
    }
    if (
      open !== undefined &&
      after.isCode &&
      !breakable &&
      ((isCodeJoiner(before.cp) && isAsciiAlnum(after.cp)) ||
        ((isDigit(before.cp) || isLower(before.cp)) && isUpper(after.cp)))
    ) {
      open.splits.push({ at: before.end, penalty: penalty(CODE_BREAK_PENALTY) });
      return true;
    }
    const em = gapEm(before, after);
    if (em > 0) return guarded(GAP_EM * em, GAP_STRETCH_EM * em, GAP_SHRINK_EM * em);
    if (isCjkSide(before.script) && isCjkSide(after.script)) {
      const bothHan = before.script === "han" && after.script === "han";
      const crossesRuns = bothHan && before.run !== after.run && !before.isAtom && !after.isAtom;
      const slit = crossesRuns && (before.isCode || after.isCode) ? CODE_SLIT_EM * after.em : 0;
      const italicSeam =
        crossesRuns && !before.isCode && !after.isCode && before.isItalic !== after.isItalic
          ? seam * after.em
          : 0;
      const extra = slit + italicSeam;
      if (breakable || extra > 0) {
        return guarded(
          extra,
          HAN_STRETCH_EM * after.em,
          HAN_SHRINK_EM * after.em + extra,
          extra === 0,
        );
      }
      return joined;
    }
    if (!breakable) return joined;
    if (open !== undefined) {
      open.splits.push({ at: before.end, penalty: penalty(0) });
      return true;
    }
    flush();
    items.push(penalty(0));
    return false;
  };

  runs.forEach((run, runIndex) => {
    if (run.kind === "break") {
      flush();
      items.push(penalty(FORCED_BREAK));
      previous = undefined;
      space = undefined;
      return;
    }
    if (run.kind === "atom") {
      const atom: Neighbour = {
        run: runIndex,
        cp: 0,
        end: 0,
        script: "latin",
        lineBreak: "AL",
        isCode: false,
        isItalic: false,
        isAtom: true,
        em: 0,
        blank: 0,
      };
      if (previous !== undefined && space !== undefined) {
        flush();
        spaceGlue(atom, previous, space);
      } else if (previous !== undefined) {
        boundary(previous, atom, undefined, 0, NO_HYPHENS, "", false);
      }
      flush();
      items.push({
        type: "box",
        width: run.advance,
        run: runIndex,
        start: 0,
        end: 0,
        text: "",
        marginLeft: 0,
        marginRight: 0,
        isAtom: true,
        isLetterSpaced: false,
        lastStart: 0,
      });
      previous = atom;
      space = undefined;
      return;
    }

    const { text, font, fontSize: em } = run;
    const isCode = run.isCode === true;
    const hyphens = new Set<number>();
    let hyphenatedTo = 0;
    let index = 0;
    while (index < text.length) {
      const cp = text.codePointAt(index)!;
      if (isSpace(cp)) {
        const soft = cp === 0x0a || cp === 0x0d;
        if (space === undefined) {
          space = {
            run: runIndex,
            start: index,
            end: index + 1,
            advance: measurer.spaceAdvance(font),
            soft,
          };
        } else {
          if (space.run === runIndex) space.end = index + 1;
          space.soft &&= soft;
        }
        index += 1;
        continue;
      }
      const end = clusterEnd(text, index);
      const isLetter = isLatinLetter(cp);
      if (isLetter && !isCode && index >= hyphenatedTo) {
        hyphenatedTo = wordHyphens(text, index, hyphens);
      }
      const side = punctuationSide(cp);
      const advance = side === undefined ? 0 : measurer.advance(text.slice(index, end), font);
      const excess = advance - MARK_BOX_EM * em;
      const squeezes = side !== undefined && excess > MARK_MIN_EXCESS_EM * em;
      const blank = squeezes ? Math.min(excess, MARK_SQUEEZE_EM * em) : 0;
      const current: Neighbour = {
        run: runIndex,
        cp,
        end,
        script: scriptClass(cp),
        lineBreak: lineBreakClass(cp),
        isCode,
        isItalic: run.isItalic === true,
        isAtom: false,
        em,
        blank: squeezes && side === "closing" ? blank : 0,
      };
      const markSide = squeezes ? side : undefined;

      // A source line break between two Han characters is not a word space.
      const spaced =
        space !== undefined &&
        !(space.soft && previous?.script === "han" && current.script === "han");
      let joined = false;
      if (previous === undefined) {
        if (markSide === "opening") glue(blank, 0, blank);
      } else if (space !== undefined && spaced) {
        flush();
        spaceGlue(current, previous, space);
        if (markSide === "opening") glue(blank, 0, blank);
      } else {
        const contiguous =
          space === undefined &&
          segment !== undefined &&
          segment.runIndex === runIndex &&
          segment.end === index;
        joined = boundary(previous, current, markSide, blank, hyphens, font, contiguous);
      }
      space = undefined;

      if (squeezes) {
        flush();
        items.push({
          type: "box",
          width: advance - excess,
          run: runIndex,
          start: index,
          end,
          text: text.slice(index, end),
          marginLeft: side === "opening" ? -excess : 0,
          marginRight: side === "closing" ? -excess : 0,
          isAtom: false,
          isLetterSpaced: false,
          lastStart: index,
        });
      } else if (joined && segment !== undefined) {
        segment.end = end;
        segment.clusterEnds.push(end);
        segment.isHan &&= current.script === "han";
      } else {
        flush();
        segment = {
          run,
          runIndex,
          start: index,
          end,
          clusterEnds: [end],
          splits: [],
          isHan: current.script === "han",
        };
      }
      previous = current;
      index = end;
    }
  });
  flush();
  return items;
}
