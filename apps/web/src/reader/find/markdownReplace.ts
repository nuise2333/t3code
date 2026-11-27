interface FindOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

function matches(text: string, query: string, options: FindOptions) {
  const found: RegExpExecArray[] = [];
  if (!query) return found;
  const body = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = "[\\p{L}\\p{N}\\p{M}_]";
  try {
    const pattern = new RegExp(
      options.wholeWord ? `(?<!${word})(?:${body})(?!${word})` : body,
      options.caseSensitive ? "gmu" : "gimu",
    );
    for (const match of text.matchAll(pattern)) {
      if (!match[0]) continue;
      found.push(match);
      if (found.length === 10_000) break;
    }
    return found;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid regular expression." };
  }
}

export function findMatches(text: string, query: string, options: FindOptions) {
  const result = matches(text, query, options);
  if ("error" in result) return result;
  return {
    ranges: result.map((match) => ({ from: match.index, to: match.index + match[0].length })),
  };
}

function expand(replacement: string, match: RegExpExecArray) {
  return replacement.replace(/\$(\$|&|<[^>]*>|\d{1,2})/g, (token: string, key: string) => {
    if (key === "$") return "$";
    if (key === "&") return match[0];
    if (key.startsWith("<")) return match.groups ? (match.groups[key.slice(1, -1)] ?? "") : token;
    const n = Number(key);
    if (n > 0 && n < match.length) return match[n] ?? "";
    const first = Number(key[0]);
    if (key.length === 2 && first > 0 && first < match.length) return (match[first] ?? "") + key[1];
    return token;
  });
}

export function replaceMatches(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions,
  only?: number,
) {
  const found = matches(text, query, options);
  if ("error" in found) return { text, count: 0 };
  let from = 0;
  let count = 0;
  const parts: string[] = [];
  for (const [index, match] of found.entries()) {
    if (only !== undefined && only !== index) continue;
    parts.push(
      text.slice(from, match.index),
      options.regex ? expand(replacement, match) : replacement,
    );
    from = match.index + match[0].length;
    count++;
  }
  return { text: parts.join("") + text.slice(from), count };
}
