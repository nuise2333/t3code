import { EN_US_EXCEPTIONS, EN_US_PATTERNS } from "./hyphenationEnUs";

const LEFT_MIN = 2;
const RIGHT_MIN = 3;

interface HyphenationDictionary {
  readonly patterns: ReadonlyMap<string, ReadonlyArray<number>>;
  readonly longestPattern: number;
  readonly exceptions: ReadonlyMap<string, ReadonlyArray<number>>;
}

function parsePattern(pattern: string): [string, Array<number>] {
  let letters = "";
  const levels = [0];
  for (const char of pattern) {
    const digit = char.charCodeAt(0) - 48;
    if (digit >= 0 && digit <= 9) {
      levels[letters.length] = digit;
    } else {
      letters += char;
      levels.push(0);
    }
  }
  return [letters, levels];
}

function parseException(entry: string): [string, Array<number>] {
  const points: Array<number> = [];
  let word = "";
  for (const part of entry.split("-")) {
    if (word !== "") points.push(word.length);
    word += part;
  }
  return [word, points];
}

function buildDictionary(): HyphenationDictionary {
  const patterns = new Map<string, ReadonlyArray<number>>();
  let longestPattern = 0;
  for (const pattern of EN_US_PATTERNS.split(/\s+/u)) {
    if (pattern === "") continue;
    const [letters, levels] = parsePattern(pattern);
    patterns.set(letters, levels);
    longestPattern = Math.max(longestPattern, letters.length);
  }
  const exceptions = new Map<string, ReadonlyArray<number>>();
  for (const entry of EN_US_EXCEPTIONS.split(/\s+/u)) {
    if (entry === "") continue;
    const [word, points] = parseException(entry);
    exceptions.set(word, points);
  }
  return { patterns, longestPattern, exceptions };
}

let dictionary: HyphenationDictionary | undefined;
const cache = new Map<string, ReadonlyArray<number>>();
const MAX_CACHED_WORDS = 20_000;

function patternPoints(word: string, { patterns, longestPattern }: HyphenationDictionary) {
  const dotted = `.${word}.`;
  const levels = new Array<number>(dotted.length + 1).fill(0);
  for (let start = 0; start < dotted.length; start += 1) {
    const longest = Math.min(longestPattern, dotted.length - start);
    for (let length = 1; length <= longest; length += 1) {
      const pattern = patterns.get(dotted.slice(start, start + length));
      if (pattern === undefined) continue;
      for (let offset = 0; offset < pattern.length; offset += 1) {
        const level = pattern[offset] ?? 0;
        if (level > (levels[start + offset] ?? 0)) levels[start + offset] = level;
      }
    }
  }
  const points: Array<number> = [];
  for (let index = 1; index < word.length; index += 1) {
    if ((levels[index + 1] ?? 0) % 2 === 1) points.push(index);
  }
  return points;
}

/**
 * Offsets in `word` where it may be divided, by American English Liang patterns. An offset `n`
 * means a hyphen may follow the first `n` UTF-16 units.
 */
export function hyphenationPoints(word: string): ReadonlyArray<number> {
  if (word.length < LEFT_MIN + RIGHT_MIN) return [];
  const lower = word.toLowerCase();
  if (lower.length !== word.length) return [];
  const known = cache.get(lower);
  if (known !== undefined) return known;
  dictionary ??= buildDictionary();
  const points = (dictionary.exceptions.get(lower) ?? patternPoints(lower, dictionary)).filter(
    (point) => point >= LEFT_MIN && point <= word.length - RIGHT_MIN,
  );
  if (cache.size >= MAX_CACHED_WORDS) cache.clear();
  cache.set(lower, points);
  return points;
}
