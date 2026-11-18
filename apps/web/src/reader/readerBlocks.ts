const FENCE_TAG_PATTERN = /(?:^|\s)language-(\S+)/;

// Display names for fence tags; a tag missing here is shown exactly as written.
const CODE_LANGUAGE_LABELS: Record<string, string> = {
  actionscript: "ActionScript",
  ada: "Ada",
  applescript: "AppleScript",
  asciidoc: "AsciiDoc",
  asm: "x86-64 asm",
  awk: "AWK",
  bash: "bash",
  bat: "Batch File",
  bibtex: "BibTeX",
  c: "C",
  "c#": "C#",
  "c++": "C++",
  clojure: "Clojure",
  cmake: "CMake",
  cmd: "Batch File",
  coffee: "CoffeeScript",
  coffeescript: "CoffeeScript",
  console: "bash",
  cpp: "C++",
  crystal: "Crystal",
  cs: "C#",
  css: "CSS",
  csv: "CSV",
  d: "D",
  dart: "Dart",
  diff: "Diff",
  dockerfile: "Dockerfile",
  elixir: "Elixir",
  elm: "Elm",
  erb: "ERB",
  erlang: "Erlang",
  "f#": "F#",
  fish: "Fish",
  gitignore: "Git Ignore",
  go: "Go",
  golang: "Go",
  graphql: "GraphQL",
  groovy: "Groovy",
  h: "Objective-C",
  haskell: "Haskell",
  hcl: "Terraform",
  hs: "Haskell",
  html: "HTML",
  http: "HTTP",
  idris: "Idris",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  jinja: "Jinja2",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  julia: "Julia",
  kotlin: "Kotlin",
  kt: "Kotlin",
  latex: "LaTeX",
  lean: "Lean 4",
  less: "Less",
  lisp: "Lisp",
  livescript: "LiveScript",
  lua: "Lua",
  make: "Makefile",
  makefile: "Makefile",
  markdown: "Markdown",
  matlab: "MATLAB",
  md: "Markdown",
  nginx: "Nginx",
  nim: "Nim",
  nix: "Nix",
  objc: "Objective-C",
  "objective-c": "Objective-C",
  "objective-c++": "Objective-C++",
  ocaml: "OCaml",
  org: "orgmode",
  pascal: "Pascal",
  patch: "Diff",
  perl: "Perl",
  php: "PHP",
  proto: "Protobuf",
  protobuf: "Protobuf",
  purescript: "PureScript",
  py: "Python",
  python: "Python",
  r: "R",
  racket: "Racket",
  rb: "Ruby",
  regex: "Regex",
  rs: "Rust",
  rst: "reStructuredText",
  ruby: "Ruby",
  rust: "Rust",
  sass: "Sass",
  scala: "Scala",
  scss: "SCSS",
  sh: "bash",
  shell: "bash",
  solidity: "Solidity",
  sql: "SQL",
  stylus: "Stylus",
  svelte: "Svelte",
  swift: "Swift",
  tcl: "Tcl",
  terraform: "Terraform",
  tex: "LaTeX",
  toml: "TOML",
  ts: "TypeScript",
  tsv: "TSV",
  tsx: "TSX",
  typescript: "TypeScript",
  verilog: "Verilog",
  vhdl: "VHDL",
  vim: "VimL",
  viml: "VimL",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zig: "Zig",
  zsh: "bash",
};

/** The label for a fenced block, or null when the fence carries no tag. */
export function readerCodeLanguageLabel(className: string | undefined): string | null {
  // Pandoc writes the tag as `{.python}`.
  const tag = className?.match(FENCE_TAG_PATTERN)?.[1]?.replace(/^\{\.?|\}$/g, "");
  if (!tag) return null;
  return CODE_LANGUAGE_LABELS[tag.toLowerCase()] ?? tag;
}

interface HastLikeNode {
  readonly type?: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly children?: ReadonlyArray<HastLikeNode>;
}

function holdsOnlyImages(node: HastLikeNode): boolean {
  let images = 0;
  for (const child of node.children ?? []) {
    if (child.type === "text" && (child.value ?? "").trim() === "") continue;
    if (child.type !== "element") return false;
    if (child.tagName === "br") continue;
    if (child.tagName === "img") images += 1;
    else if (child.tagName === "a" && holdsOnlyImages(child)) images += 1;
    else return false;
  }
  return images > 0;
}

/** A paragraph of images and nothing else is set as centred blocks, not as a line of text. */
export function isReaderFigureParagraph(node: HastLikeNode | undefined): boolean {
  return node !== undefined && holdsOnlyImages(node);
}
