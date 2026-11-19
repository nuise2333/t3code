import DOMPurify from "dompurify";

import {
  isRecord,
  normalizePackagePath,
  openOpenVsxPackage,
  parseJsoncObject,
  readZipText,
  shortHash,
  themeContributions,
  type OpenVsxThemeExtension,
} from "./openVsxThemes";

const MAX_ICON_THEMES_PER_EXTENSION = 8;
const MAX_ICON_THEME_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ICON_SVG_BYTES = 256 * 1024;
const MAX_SPRITE_BYTES = 8 * 1024 * 1024;
const MAX_ICON_DEFINITIONS = 6_000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const INHERITED_ROOT_ATTRIBUTES = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "opacity",
  "color",
  "style",
];

// VS Code maps these through language contributions; T3 has none, so map the common ones by extension.
const LANGUAGE_ID_EXTENSIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  bat: ["bat", "cmd"],
  c: ["c", "h"],
  clojure: ["clj", "cljs", "cljc", "edn"],
  coffeescript: ["coffee"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
  csharp: ["cs", "csx"],
  css: ["css"],
  dart: ["dart"],
  diff: ["diff", "patch"],
  elixir: ["ex", "exs"],
  erlang: ["erl", "hrl"],
  fsharp: ["fs", "fsi", "fsx"],
  go: ["go"],
  graphql: ["graphql", "gql"],
  groovy: ["groovy", "gradle"],
  haskell: ["hs", "lhs"],
  html: ["html", "htm"],
  ini: ["ini"],
  java: ["java"],
  javascript: ["js", "mjs", "cjs"],
  javascriptreact: ["jsx"],
  json: ["json"],
  jsonc: ["jsonc"],
  julia: ["jl"],
  kotlin: ["kt", "kts"],
  less: ["less"],
  lua: ["lua"],
  makefile: ["mk"],
  markdown: ["md", "markdown"],
  objc: ["m"],
  perl: ["pl", "pm"],
  php: ["php"],
  plaintext: ["txt"],
  powershell: ["ps1", "psm1", "psd1"],
  python: ["py", "pyi"],
  r: ["r"],
  ruby: ["rb"],
  rust: ["rs"],
  scala: ["scala", "sc"],
  scss: ["scss"],
  shellscript: ["sh", "bash", "zsh"],
  sql: ["sql"],
  swift: ["swift"],
  toml: ["toml"],
  typescript: ["ts", "mts", "cts"],
  typescriptreact: ["tsx"],
  vue: ["vue"],
  xml: ["xml", "xsd", "xsl"],
  yaml: ["yml", "yaml"],
  zig: ["zig"],
};

export type FileIconMaps = {
  readonly file?: string;
  readonly folder?: string;
  readonly folderExpanded?: string;
  readonly fileNames: Readonly<Record<string, string>>;
  readonly fileExtensions: Readonly<Record<string, string>>;
  readonly folderNames: Readonly<Record<string, string>>;
  readonly folderNamesExpanded: Readonly<Record<string, string>>;
};

export type FileIconTheme = {
  readonly id: string;
  readonly label: string;
  readonly collectionId: string;
  readonly version: string;
  /** An SVG string of `<symbol>`s; every map value is one of their ids. */
  readonly sprite: string;
  readonly dark: FileIconMaps;
  readonly light: FileIconMaps;
};

type MutableMaps = {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
};

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function applySection(
  maps: MutableMaps,
  section: Record<string, unknown>,
  symbolFor: (definitionId: string) => string | undefined,
) {
  const assign = (target: Record<string, string>, source: unknown, lowerCase: boolean) => {
    for (const [key, definitionId] of Object.entries(stringMap(source))) {
      const symbol = symbolFor(definitionId);
      if (symbol) target[lowerCase ? key.toLowerCase() : key] = symbol;
    }
  };
  for (const [languageId, definitionId] of Object.entries(stringMap(section.languageIds))) {
    const symbol = symbolFor(definitionId);
    if (!symbol) continue;
    for (const extension of LANGUAGE_ID_EXTENSIONS[languageId] ?? []) {
      maps.fileExtensions[extension] = symbol;
    }
  }
  // Explicit extensions win over languages, as in VS Code.
  assign(maps.fileExtensions, section.fileExtensions, true);
  assign(maps.fileNames, section.fileNames, true);
  assign(maps.folderNames, section.folderNames, true);
  assign(maps.folderNamesExpanded, section.folderNamesExpanded, true);
  for (const key of ["file", "folder", "folderExpanded"] as const) {
    const definitionId = section[key];
    const symbol = typeof definitionId === "string" ? symbolFor(definitionId) : undefined;
    if (symbol) maps[key] = symbol;
  }
}

/** Resolves a VS Code icon theme document into dark and light lookup maps of symbol ids. */
export function mapIconThemeDocument(
  document: Record<string, unknown>,
  symbolFor: (definitionId: string) => string | undefined,
): { dark: FileIconMaps; light: FileIconMaps } {
  const dark: MutableMaps = {
    fileNames: {},
    fileExtensions: {},
    folderNames: {},
    folderNamesExpanded: {},
  };
  applySection(dark, document, symbolFor);
  if (!dark.folderExpanded && dark.folder) dark.folderExpanded = dark.folder;
  const light: MutableMaps = {
    ...dark,
    fileNames: { ...dark.fileNames },
    fileExtensions: { ...dark.fileExtensions },
    folderNames: { ...dark.folderNames },
    folderNamesExpanded: { ...dark.folderNamesExpanded },
  };
  if (isRecord(document.light)) applySection(light, document.light, symbolFor);
  return { dark, light };
}

/** Every icon definition id the document's maps reference, in either appearance. */
export function referencedIconDefinitions(document: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const collect = (section: Record<string, unknown>) => {
    for (const key of [
      "fileExtensions",
      "fileNames",
      "folderNames",
      "folderNamesExpanded",
      "languageIds",
    ]) {
      for (const id of Object.values(stringMap(section[key]))) ids.add(id);
    }
    for (const key of ["file", "folder", "folderExpanded"]) {
      if (typeof section[key] === "string") ids.add(section[key]);
    }
  };
  collect(document);
  if (isRecord(document.light)) collect(document.light);
  return ids;
}

/** Sanitizes one icon SVG and wraps it as a `<symbol>`, prefixing its internal ids so icons can share a sprite. */
export function svgToSymbol(source: string, symbolId: string): string | null {
  const body = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // A <style> would leak into every other icon in the shared sprite.
    FORBID_TAGS: ["style", "foreignObject", "image", "a"],
    ADD_TAGS: ["use"],
    RETURN_DOM: true,
  }) as HTMLElement;
  const root = body.querySelector("svg");
  if (!root || root.namespaceURI !== SVG_NAMESPACE) return null;
  const parsed = root.ownerDocument;

  const idMap = new Map<string, string>();
  for (const element of root.querySelectorAll("[id]")) {
    const id = element.getAttribute("id")!;
    const prefixed = `${symbolId}-${idMap.size}`;
    idMap.set(id, prefixed);
    element.setAttribute("id", prefixed);
  }
  for (const element of root.querySelectorAll("*")) {
    // Copied because removing an attribute mutates the live map.
    for (const attribute of Array.from(element.attributes)) {
      const isHref = attribute.localName === "href";
      if (isHref) {
        const target = attribute.value.startsWith("#")
          ? idMap.get(attribute.value.slice(1))
          : undefined;
        if (target) attribute.value = `#${target}`;
        else element.removeAttributeNode(attribute);
        continue;
      }
      if (attribute.value.includes("url(")) {
        attribute.value = attribute.value.replace(
          /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g,
          (match: string, id: string) => (idMap.has(id) ? `url(#${idMap.get(id)})` : match),
        );
      }
    }
  }

  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  const viewBox =
    root.getAttribute("viewBox") ??
    `0 0 ${Number.isFinite(width) ? width : 16} ${Number.isFinite(height) ? height : 16}`;
  const symbol = parsed.createElementNS(SVG_NAMESPACE, "symbol");
  symbol.setAttribute("id", symbolId);
  symbol.setAttribute("viewBox", viewBox);
  const group = parsed.createElementNS(SVG_NAMESPACE, "g");
  for (const name of INHERITED_ROOT_ATTRIBUTES) {
    const value = root.getAttribute(name);
    if (value !== null) group.setAttribute(name, value);
  }
  group.append(...root.childNodes);
  symbol.append(group);
  return new XMLSerializer()
    .serializeToString(symbol)
    .replaceAll(` xmlns="${SVG_NAMESPACE}"`, "")
    .replace("<symbol ", `<symbol xmlns="${SVG_NAMESPACE}" `);
}

export function fileIconThemeCollectionId(extensionId: string): string {
  return `open-vsx-icons:${extensionId.toLowerCase()}`;
}

export async function importOpenVsxIconThemeExtension(
  extension: OpenVsxThemeExtension,
  signal?: AbortSignal,
): Promise<ReadonlyArray<FileIconTheme>> {
  const { zip, manifest } = await openOpenVsxPackage(extension, signal);
  const contributions = themeContributions(manifest, "iconThemes");
  if (contributions.length === 0) throw new Error("That extension does not contain icon themes.");
  if (contributions.length > MAX_ICON_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many icon themes to import safely.");
  }
  const collectionId = fileIconThemeCollectionId(extension.id);
  const themes: FileIconTheme[] = [];
  for (const contribution of contributions) {
    signal?.throwIfAborted();
    if (typeof contribution.path !== "string") {
      throw new Error("An icon theme in that extension has no path.");
    }
    const path = normalizePackagePath(contribution.path);
    const document = parseJsoncObject(
      await readZipText(zip, path, path, signal, MAX_ICON_THEME_JSON_BYTES),
      path,
    );
    const definitions = isRecord(document.iconDefinitions) ? document.iconDefinitions : {};
    if (Object.keys(definitions).length > MAX_ICON_DEFINITIONS) {
      throw new Error("That icon theme has too many icons to import safely.");
    }
    const themeId = `ovx-icons-${shortHash(`${extension.id.toLowerCase()}:${path}`)}`;
    const symbolsByDefinition = new Map<string, string>();
    const symbolsByFile = new Map<string, string>();
    const symbols: string[] = [];
    let spriteBytes = 0;
    for (const definitionId of referencedIconDefinitions(document)) {
      signal?.throwIfAborted();
      const definition = definitions[definitionId];
      const iconPath = isRecord(definition) ? definition.iconPath : undefined;
      if (typeof iconPath !== "string" || !iconPath.toLowerCase().endsWith(".svg")) continue;
      const svgPath = normalizePackagePath(iconPath, path);
      const existing = symbolsByFile.get(svgPath);
      if (existing) {
        symbolsByDefinition.set(definitionId, existing);
        continue;
      }
      if (!zip.file(svgPath)) continue;
      const symbolId = `${themeId}-${symbols.length}`;
      const symbol = svgToSymbol(
        await readZipText(zip, svgPath, svgPath, signal, MAX_ICON_SVG_BYTES),
        symbolId,
      );
      if (!symbol) continue;
      spriteBytes += symbol.length;
      if (spriteBytes > MAX_SPRITE_BYTES) {
        throw new Error("That icon theme is too large to import safely.");
      }
      symbols.push(symbol);
      symbolsByFile.set(svgPath, symbolId);
      symbolsByDefinition.set(definitionId, symbolId);
    }
    if (symbols.length === 0) {
      throw new Error("That icon theme has no SVG icons T3 Code can use.");
    }
    const label =
      typeof contribution.label === "string" && contribution.label.trim()
        ? contribution.label.trim().slice(0, 64)
        : extension.name;
    themes.push({
      id: themeId,
      label,
      collectionId,
      version: extension.version,
      sprite: `<svg xmlns="${SVG_NAMESPACE}" width="0" height="0" aria-hidden="true">${symbols.join("")}</svg>`,
      ...mapIconThemeDocument(document, (definitionId) => symbolsByDefinition.get(definitionId)),
    });
  }
  return themes;
}
