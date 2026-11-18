// micromark's browser build decodes named character references with a DOM element made at
// import, and a worker has no document. This stands in for that element with the references
// Markdown files use; any other name stays literal text, as an unknown name does.
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: String.fromCodePoint(0x2014),
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  times: "×",
  divide: "÷",
  middot: "·",
  bull: "•",
  deg: "°",
  plusmn: "±",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  check: "✓",
  shy: "­",
  zwj: "‍",
  zwnj: "‌",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  sect: "§",
  para: "¶",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};

if (typeof document === "undefined") {
  const element = {
    text: "",
    set innerHTML(value: string) {
      this.text = NAMED[value.slice(1, -1)] ?? value;
    },
    get textContent() {
      return this.text;
    },
  };
  // prosemirror-view, which the schema's module loads, reads the root's style at import.
  Object.assign(globalThis, {
    document: { createElement: () => element, documentElement: { style: {} } },
  });
}
