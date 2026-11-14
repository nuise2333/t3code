/** Escapes a value for a quoted Spotlight query string, so `*` and `?` match literally. */
export function escapeSpotlightString(value: string): string {
  return value.replace(/([\\'"*?])/gu, "\\$1");
}

export function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
