import { enumerateDays, formatCount } from "@t3tools/shared/usageFormat";

export type HomeRangeId = "all" | "30d" | "7d";

export const HOME_HEAT_WEEKS = 26;
const HOME_HEAT_STEPS = 5;
// The grid starts on the Sunday on or before 26 weeks ago, so it spans at most 26 * 7 + 6 days.
export const HOME_HEAT_WINDOW_DAYS = HOME_HEAT_WEEKS * 7 + 6;
const HOME_CHART_DAYS = 30;
export const HOME_MODEL_ROWS = 6;
export const HOME_MODEL_COLOR_COUNT = 10;

// T3 has no all-time query, so "All" covers the heatmap's span.
export const HOME_RANGES: ReadonlyArray<{
  readonly id: HomeRangeId;
  readonly label: string;
  readonly title: string;
  readonly days: number;
}> = [
  { id: "all", label: "All", title: `Last ${HOME_HEAT_WEEKS} weeks`, days: HOME_HEAT_WINDOW_DAYS },
  { id: "30d", label: "30d", title: "Last 30 days", days: 30 },
  { id: "7d", label: "7d", title: "Last 7 days", days: 7 },
];

function homeRangeDays(range: HomeRangeId): number {
  return HOME_RANGES.find((entry) => entry.id === range)?.days ?? HOME_HEAT_WINDOW_DAYS;
}

function shiftDay(day: string, offset: number): string {
  const [year = 0, month = 1, dayOfMonth = 1] = day.split("-").map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, dayOfMonth + offset)).toISOString().slice(0, 10);
}

function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Inclusive first day of a range ending on `untilDay`. */
export function rangeSinceDay(range: HomeRangeId, untilDay: string): string {
  return shiftDay(untilDay, -(homeRangeDays(range) - 1));
}

export function heatGridDays(untilDay: string): readonly string[] {
  const back = shiftDay(untilDay, -(HOME_HEAT_WEEKS * 7 - 1));
  return enumerateDays(shiftDay(back, -weekday(back)), untilDay);
}

export function heatLevel(tokens: number, peak: number): number {
  if (tokens <= 0 || peak <= 0) return 0;
  return Math.max(1, Math.min(HOME_HEAT_STEPS, Math.ceil((tokens / peak) * HOME_HEAT_STEPS)));
}

export interface HeatCell {
  readonly day: string;
  readonly tokens: number;
  readonly level: number;
}

export function buildHeatCells(
  untilDay: string,
  daily: ReadonlyArray<{ readonly day: string; readonly totalTokens: number }>,
): readonly HeatCell[] {
  const tokensByDay = new Map(daily.map((entry) => [entry.day, entry.totalTokens]));
  const days = heatGridDays(untilDay);
  let peak = 0;
  for (const day of days) peak = Math.max(peak, tokensByDay.get(day) ?? 0);
  return days.map((day) => {
    const tokens = tokensByDay.get(day) ?? 0;
    return { day, tokens, level: heatLevel(tokens, peak) };
  });
}

export function countActiveDays(
  daily: ReadonlyArray<{ readonly day: string; readonly totalTokens: number }>,
  sinceDay: string,
): number {
  return daily.filter((entry) => entry.day >= sinceDay && entry.totalTokens > 0).length;
}

/** Days the Models chart shows: the range itself when shorter than 30 days. */
export function chartDays(range: HomeRangeId, untilDay: string): readonly string[] {
  const span = Math.min(homeRangeDays(range), HOME_CHART_DAYS);
  return enumerateDays(shiftDay(untilDay, -(span - 1)), untilDay);
}

export function axisMax(peak: number): number {
  if (!(peak > 0)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const scaled = peak / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Column indexes that get a date label, kept from the newest day backwards. */
export function axisLabelIndexes(count: number, maxLabels = 6): readonly number[] {
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(count / maxLabels));
  const indexes: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) indexes.unshift(index);
  return indexes;
}

/** Stable colour slots: each id prefers its hash slot and probes forward on collisions. */
export function assignModelColors(ids: readonly string[]): ReadonlyMap<string, number> {
  const assigned = new Map<string, number>();
  const used = new Set<number>();
  for (const id of [...new Set(ids)].toSorted()) {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index += 1) {
      hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
    }
    let slot = (hash >>> 0) % HOME_MODEL_COLOR_COUNT;
    while (used.size < HOME_MODEL_COLOR_COUNT && used.has(slot)) {
      slot = (slot + 1) % HOME_MODEL_COLOR_COUNT;
    }
    used.add(slot);
    assigned.set(id, slot);
  }
  return assigned;
}

// Token counts per book, measured with o200k_base.
export const HOME_BOOKS: ReadonlyArray<{ readonly title: string; readonly tokens: number }> = [
  { title: "Tao Te Ching", tokens: 7607 },
  { title: "The Yellow Wallpaper", tokens: 7778 },
  { title: "Metamorphosis", tokens: 27557 },
  { title: "The Strange Case of Dr Jekyll and Mr Hyde", tokens: 34713 },
  { title: "Alice's Adventures in Wonderland", tokens: 37248 },
  { title: "Animal Farm", tokens: 39000 },
  { title: "A Christmas Carol", tokens: 40306 },
  { title: "The Call of the Wild", tokens: 42383 },
  { title: "The Time Machine", tokens: 42817 },
  { title: "The Wonderful Wizard of Oz", tokens: 51004 },
  { title: "Heart of Darkness", tokens: 52163 },
  { title: "Faust", tokens: 53930 },
  { title: "The Turn of the Screw", tokens: 57484 },
  { title: "Aesop's Fables", tokens: 60707 },
  { title: "Peter Pan", tokens: 63821 },
  { title: "The Great Gatsby", tokens: 65763 },
  { title: "The Prince", tokens: 66670 },
  { title: "The Invisible Man", tokens: 68163 },
  { title: "Andersen's Fairy Tales", tokens: 73931 },
  { title: "The War of the Worlds", tokens: 80168 },
  { title: "Beyond Good and Evil", tokens: 89836 },
  { title: "White Fang", tokens: 96418 },
  { title: "Meditations", tokens: 96973 },
  { title: "Frankenstein", tokens: 97886 },
  { title: "Harry Potter and the Philosopher's Stone", tokens: 100000 },
  { title: "The Picture of Dorian Gray", tokens: 106339 },
  { title: "To Live", tokens: 115000 },
  { title: "The Hobbit", tokens: 123000 },
  { title: "Grimms' Fairy Tales", tokens: 132467 },
  { title: "Nineteen Eighty-Four", tokens: 136278 },
  { title: "The Adventures of Sherlock Holmes", tokens: 138725 },
  { title: "Gulliver's Travels", tokens: 138958 },
  { title: "Walden", tokens: 152659 },
  { title: "Robinson Crusoe", tokens: 153596 },
  { title: "Adventures of Huckleberry Finn", tokens: 154263 },
  { title: "The Divine Comedy", tokens: 157765 },
  { title: "Madame Bovary", tokens: 159575 },
  { title: "Thus Spoke Zarathustra", tokens: 161488 },
  { title: "Pride and Prejudice", tokens: 171701 },
  { title: "The Odyssey", tokens: 173150 },
  { title: "A Tale of Two Cities", tokens: 187333 },
  { title: "The Three-Body Problem", tokens: 202000 },
  { title: "Dracula", tokens: 213648 },
  { title: "Great Expectations", tokens: 252176 },
  { title: "Jane Eyre", tokens: 256179 },
  { title: "The Republic", tokens: 279539 },
  { title: "Crime and Punishment", tokens: 285009 },
  { title: "Leviathan", tokens: 304696 },
  { title: "Moby-Dick", tokens: 306522 },
  { title: "The Dark Forest", tokens: 307000 },
  { title: "Death's End", tokens: 336000 },
  { title: "Anna Karenina", tokens: 481659 },
  { title: "The Brothers Karamazov", tokens: 487590 },
  { title: "Don Quixote", tokens: 574243 },
  { title: "The Lord of the Rings", tokens: 625000 },
  { title: "Romance of the Three Kingdoms", tokens: 638009 },
  { title: "The Count of Monte Cristo", tokens: 651128 },
  { title: "War and Peace", tokens: 769001 },
  { title: "Journey to the West", tokens: 783200 },
  { title: "Les Misérables", tokens: 801791 },
  { title: "Dream of the Red Chamber", tokens: 903956 },
  { title: "Water Margin", tokens: 958242 },
  { title: "Ordinary World", tokens: 998000 },
  { title: "the complete Harry Potter series", tokens: 1409000 },
  { title: "In Search of Lost Time", tokens: 1647000 },
];

/** `pick` in [0, 1) chooses a book; it falls back to smaller books the total cannot fill. */
export function pickBook(
  totalTokens: number,
  pick: number,
): { readonly title: string; readonly count: number } | null {
  if (!(totalTokens > 0)) return null;
  const clamped = Number.isFinite(pick) ? Math.max(0, Math.min(0.999999, pick)) : 0;
  let index = Math.min(HOME_BOOKS.length - 1, Math.floor(clamped * HOME_BOOKS.length));
  while (index >= 0 && totalTokens < HOME_BOOKS[index]!.tokens) index -= 1;
  const book = HOME_BOOKS[index];
  if (!book) return null;
  return { title: book.title, count: Math.max(1, Math.round(totalTokens / book.tokens)) };
}

export function bookLine(totalTokens: number, pick: number): string | null {
  const book = pickBook(totalTokens, pick);
  if (!book) return null;
  return `Your token usage equals ${formatCount(book.count)} ${book.count === 1 ? "copy" : "copies"} of ${book.title}.`;
}

export type QuotaWarnLevel = 0 | 1 | 2;

export function quotaWarnLevel(remainingPercent: number): QuotaWarnLevel {
  if (remainingPercent <= 15) return 2;
  if (remainingPercent <= 35) return 1;
  return 0;
}

export function quotaHealthLabel(level: QuotaWarnLevel): string {
  return level === 2 ? "Low quota" : level === 1 ? "Running low" : "Healthy";
}

/** Places the heatmap tooltip below a cell when there is room, otherwise above it. */
export function heatTipPosition(input: {
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly cellLeft: number;
  readonly cellTop: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly textLength: number;
}): { readonly left: number; readonly top: number } {
  const width = Math.max(88, Math.min(240, input.textLength * 6.8 + 18));
  const left = Math.min(
    Math.max(input.cellLeft + input.cellWidth / 2 - width / 2, 0),
    Math.max(0, input.gridWidth - width),
  );
  const below = input.gridHeight - input.cellTop - input.cellHeight;
  const top =
    below > input.cellTop && below >= 30
      ? input.cellTop + input.cellHeight + 6
      : input.cellTop - 30;
  return { left: Math.round(left), top: Math.round(top) };
}
