import { assert, describe, it } from "vite-plus/test";

import { mapIconThemeDocument, referencedIconDefinitions } from "./fileIconThemeImport";
import { resolveThemedIconForEntry } from "./pierre-icons";

const DOCUMENT = {
  iconDefinitions: {},
  file: "file",
  folder: "folder",
  fileExtensions: { "spec.ts": "test", TS: "ts-explicit" },
  fileNames: { "Package.json": "npm" },
  languageIds: { typescript: "ts-language", python: "python" },
  folderNames: { src: "folder-src" },
  folderNamesExpanded: { src: "folder-src-open" },
  light: { fileExtensions: { py: "python-light" }, folder: "folder-light" },
};

const symbolFor = (id: string) => (id === "missing" ? undefined : `sym-${id}`);

describe("file icon themes", () => {
  it("maps VS Code icon theme rules with explicit rules beating languages", () => {
    const { dark, light } = mapIconThemeDocument(DOCUMENT, symbolFor);
    assert.equal(dark.fileExtensions.ts, "sym-ts-explicit");
    assert.equal(dark.fileExtensions.mts, "sym-ts-language");
    assert.equal(dark.fileExtensions.py, "sym-python");
    assert.equal(dark.fileNames["package.json"], "sym-npm");
    assert.equal(dark.folderExpanded, "sym-folder");
    assert.equal(light.fileExtensions.py, "sym-python-light");
    assert.equal(light.folder, "sym-folder-light");
    assert.equal(dark.folder, "sym-folder");
  });

  it("collects only the definitions some rule uses", () => {
    assert.deepEqual(
      [...referencedIconDefinitions({ ...DOCUMENT, iconDefinitions: { unused: {} } })].sort(),
      [
        "file",
        "folder",
        "folder-light",
        "folder-src",
        "folder-src-open",
        "npm",
        "python",
        "python-light",
        "test",
        "ts-explicit",
        "ts-language",
      ],
    );
  });

  it("resolves files and folders by name, expansion, and fallbacks", () => {
    const theme = {
      id: "theme",
      label: "Theme",
      collectionId: "collection",
      version: "1.0.0",
      sprite: "<svg></svg>",
      ...mapIconThemeDocument(DOCUMENT, symbolFor),
    };
    const resolve = (path: string, kind: "file" | "directory", expanded = false) =>
      resolveThemedIconForEntry(theme, "dark", path, kind, undefined, expanded);
    assert.equal(resolve("src/app.spec.ts", "file"), "sym-test");
    assert.equal(resolve("README", "file"), "sym-file");
    assert.equal(resolve("packages/src", "directory"), "sym-folder-src");
    assert.equal(resolve("packages/SRC/", "directory", true), "sym-folder-src-open");
    assert.equal(resolve("docs", "directory", true), "sym-folder");
    assert.equal(
      resolveThemedIconForEntry(theme, "dark", "script", "file", "text/x-python"),
      "sym-python",
    );
    const { folder: _folder, folderExpanded: _expanded, ...darkWithoutFolders } = theme.dark;
    const withoutFolders = { ...theme, dark: darkWithoutFolders };
    assert.isNull(resolveThemedIconForEntry(withoutFolders, "dark", "docs", "directory"));
  });
});
