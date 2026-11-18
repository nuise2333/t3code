/** The numbers an ordered list shows, following its `start` and written item values. */
export function orderedListMarkerNumbers(
  itemValues: ReadonlyArray<unknown>,
  start: unknown,
): Array<number> {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  let number = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const numbers: Array<number> = [];
  for (const value of itemValues) {
    const written = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isNaN(written)) number = written;
    numbers.push(number);
    number += 1;
  }
  return numbers;
}

/** Digits in the widest marker of an ordered list, following its `start` and written item values. */
export function orderedListMarkerDigits(
  itemValues: ReadonlyArray<unknown>,
  start: unknown,
): number {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const first = Number.isNaN(parsedStart) ? 1 : parsedStart;
  return Math.max(
    String(first).length,
    ...orderedListMarkerNumbers(itemValues, start).map((number) => String(number).length),
  );
}
