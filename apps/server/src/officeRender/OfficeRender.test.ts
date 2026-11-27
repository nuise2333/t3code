// @effect-diagnostics nodeBuiltinImport:off - the fake converter writes the same on-disk output as soffice.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as OfficeRender from "./OfficeRender.ts";
import { officeProfile } from "./officeHost.ts";

const layer = ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "office-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const makeSource = Effect.fn("OfficeRenderTest.makeSource")(function* (
  name: string,
  contents: string,
) {
  const files = yield* FileSystem.FileSystem;
  const dir = yield* files.makeTempDirectoryScoped();
  const source = NodePath.join(dir, name);
  yield* files.writeFileString(source, contents);
  return yield* files.realPath(source);
});

it.effect("coalesces renders and renders again whenever the source is replaced or changed", () =>
  Effect.gen(function* () {
    let calls = 0;
    const renderer = yield* OfficeRender.make({
      find: async () => "fake",
      run: async (_binary, args) => {
        calls++;
        await NodeFSP.writeFile(
          NodePath.join(args[args.indexOf("--outdir") + 1]!, "source.pdf"),
          "123",
        );
        return "";
      },
      budget: 6,
    });
    const file = yield* makeSource("sample.docx", "abc");
    const pinnedTime = 1_650_000_000;
    yield* Effect.promise(() => NodeFSP.utimes(file, pinnedTime, pinnedTime));
    const [first, duplicate] = yield* Effect.all(
      [renderer.renderPdf(file), renderer.renderPdf(file)],
      { concurrency: "unbounded" },
    );
    expect(duplicate).toBe(first);
    expect(yield* renderer.renderPdf(file)).toBe(first);
    expect(calls).toBe(1);

    // Another document moved over the path, with the same size and mtime, is not the cached one.
    const replacement = `${file}.new`;
    yield* Effect.promise(() =>
      NodeFSP.writeFile(replacement, "xyz")
        .then(() => NodeFSP.utimes(replacement, pinnedTime, pinnedTime))
        .then(() => NodeFSP.rename(replacement, file)),
    );
    const second = yield* renderer.renderPdf(file);
    expect(second).not.toBe(first);
    expect(calls).toBe(2);

    yield* TestClock.setTime(2_000_000_000_000);
    yield* Effect.promise(() => NodeFSP.writeFile(file, "abcd"));
    const third = yield* renderer.renderPdf(file);
    expect(third).not.toBe(second);
    expect(yield* renderer.renderPdf(file)).toBe(third);
    expect(calls).toBe(3);
    // Three 3-byte PDFs over a 6-byte budget: the least recently used one is gone.
    expect(yield* fsExists(first)).toBe(false);
    expect(yield* fsExists(third)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

const fsExists = (file: string) =>
  Effect.promise(() =>
    NodeFSP.access(file).then(
      () => true,
      () => false,
    ),
  );

it.effect("caches missing executables and reports unavailable before accessing the source", () =>
  Effect.gen(function* () {
    let searches = 0;
    const renderer = yield* OfficeRender.make({
      find: async () => {
        searches++;
        return null;
      },
    });
    expect(yield* renderer.available).toBe(false);
    expect((yield* renderer.renderPdf("/missing.docx").pipe(Effect.flip))._tag).toBe(
      "OfficeRendererUnavailable",
    );
    expect(searches).toBe(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("reports missing output with stderr and retries a failed conversion", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const renderer = yield* OfficeRender.make({
      find: async () => "fake",
      run: async (_binary, args) => {
        if (++attempts === 2)
          await NodeFSP.writeFile(
            NodePath.join(args[args.indexOf("--outdir") + 1]!, "source.pdf"),
            "pdf",
          );
        return "source unreadable";
      },
    });
    const source = yield* makeSource("test.docx", "data");
    expect(yield* renderer.renderPdf(source).pipe(Effect.flip)).toMatchObject({
      _tag: "OfficeRenderFailed",
      detail: expect.stringContaining("source unreadable"),
    });
    expect(yield* fsExists(yield* renderer.renderPdf(source))).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it("links only supplied font directories and replaces aliases of installed families", () => {
  const profile = officeProfile(
    "/profile",
    ["/System/Library/Fonts", "/Users/test/Library/Fonts"],
    ["Songti SC", "Kaiti SC"],
  );
  expect(profile.links.map((link) => link.source)).toEqual([
    "/System/Library/Fonts",
    "/Users/test/Library/Fonts",
  ]);
  expect(profile.links.map((link) => NodePath.dirname(link.target))).toEqual(
    Array(2).fill(NodePath.join("/profile", "user", "fonts")),
  );
  expect(new Set(profile.links.map((link) => link.target)).size).toBe(2);
  for (const alias of ["宋体", "SimSun", "NSimSun", "楷体", "KaiTi"])
    expect(profile.registry).toContain(`<value>${alias}</value>`);
  expect(profile.registry).toContain('oor:name="Always" oor:op="fuse"><value>true</value>');
  expect(profile.registry).not.toContain("PingFang");
});

const chineseDocument = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:mimetype="application/vnd.oasis.opendocument.text" office:version="1.3">
<office:font-face-decls><style:font-face style:name="SimSun" svg:font-family="SimSun"/></office:font-face-decls>
<office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:text-properties style:font-name-asian="SimSun" style:language-asian="zh" style:country-asian="CN"/></style:style></office:automatic-styles>
<office:body><office:text><text:p text:style-name="P1">中文</text:p></office:text></office:body></office:document>`;

it.live(
  "embeds a Chinese font when rendering a SimSun document with installed LibreOffice",
  (ctx) =>
    Effect.gen(function* () {
      const renderer = yield* OfficeRender.make();
      if (!(yield* renderer.available)) return ctx.skip("LibreOffice is unavailable.");
      const pdf = yield* renderer.renderPdf(yield* makeSource("chinese.fodt", chineseDocument));
      const content = yield* Effect.promise(() => NodeFSP.readFile(pdf, "latin1"));
      expect(content).toContain("/FontFile");
      if ((yield* HostProcess.Platform) === "darwin")
        expect(content).toMatch(/\/BaseFont\s*\/[\w+.-]*(?:Songti|STSong)/i);
      expect(content).toMatch(
        /\/BaseFont\s*\/[\w+.-]*(?:Songti|STSong|SimSun|PingFang|Heiti|Noto(?:Serif|Sans)CJK|DroidSansFallback|WenQuanYi)/i,
      );
    }).pipe(Effect.provide(layer)),
);
