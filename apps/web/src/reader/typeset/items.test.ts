import { describe, expect, it } from "vite-plus/test";
import { body, code, createFakeMeasurer } from "./fakeMeasurer";
import { buildItems, type InlineRun, type ItemOptions } from "./items";

const round = (value: number) => Math.round(value * 100) / 100;

/** Boxes as their text and width, glue as <natural stretch shrink>, penalties as |cost. */
function describeItems(runs: ReadonlyArray<InlineRun>, options?: ItemOptions) {
  return buildItems(runs, createFakeMeasurer(), options)
    .map((item) => {
      if (item.type === "box") return `${item.isAtom ? "@" : item.text}:${round(item.width)}`;
      if (item.type === "penalty") return `|${item.cost}${item.flagged ? "-" : ""}`;
      const source = item.run >= 0 ? "s" : "";
      return `<${round(item.width)} ${round(item.stretch)} ${round(item.shrink)}>${source}`;
    })
    .join(" ");
}

const text = (source: string) => describeItems([body(source)]);

describe("item construction", () => {
  it.each([
    ["word space", "ab cd", "ab:16 <4 2 1.33>s cd:16"],
    ["collapsed and trimmed white space", "  ab \n  cd ", "ab:16 <4 2 1.33>s cd:16"],
    ["Han to Han", "国国", "国:16 <0 0.8 0.64> 国:16"],
    ["closing mark", "国，国", "国:16 ，:8 <8 0 8> 国:16"],
    ["two closing marks", "国。」国", "国:16 。:8 |10000 <0 0 0> 」:8 <8 0 8> 国:16"],
    ["closing then opening", "国」「国", "国:16 」:8 <8 0 4> 「:8 国:16"],
    ["opening after Han", "国（国", "国:16 <8 0 8> （:8 国:16"],
    ["two opening marks", "国（（国", "国:16 <8 0 8> （:8 |10000 <8 0 8> （:8 国:16"],
    ["opening mark at paragraph start", "「国", "<8 0 8> 「:8 国:16"],
    ["space after a closing mark is absorbed", "国， 国", "国:16 ，:8 <8 0 8>s 国:16"],
    ["space before an opening mark stays", "ab （国", "ab:16 <4 2 1.33>s <8 0 8> （:8 国:16"],
    ["curly quotes stick to both sides", "国“国”国", "国“国”国:56"],
    ["Han to Latin", "国H8国", "国:16 <4 4 0.48> H8:16 <4 4 0.48> 国:16"],
    ["gap replaces one typed space", "国 H 国", "国:16 <4 4 0.48>s H:8 <4 4 0.48>s 国:16"],
    ["gap outside half-width brackets", "国(H)国", "国:16 <4 4 0.48> (H):16 <4 4 0.48> 国:16"],
    ["no gap for symbols", "国@国", "国:16 |0 @:4 |0 国:16"],
    ["no gap for Greek", "国α国", "国:16 |0 α:8 |0 国:16"],
    ["no gap after a full-width mark", "H，H", "H:8 ，:8 <8 0 8> H:8"],
    ["typed space between Han stays a word space", "国 国", "国:16 <4 2 1.33>s 国:16"],
    ["soft break between Han vanishes", "国\n国", "国:16 <0 0.8 0.64> 国:16"],
    ["hyphenation points", "considers", "con:24 |50- sid:24 |50- ers:24"],
    ["existing hyphens", "well-to-do", "well-:36 |0 to-:20 |0 do:16"],
    ["short words stay whole", "into the", "into:32 <4 2 1.33>s the:24"],
  ])("%s", (_name, source, expected) => {
    expect(text(source)).toBe(expected);
  });

  it("uses the Han side's size for gaps and adds a slit between Han and Han code", () => {
    expect(describeItems([body("国"), code("H"), body("国")])).toBe(
      "国:16 <4 4 0.48> H:7 <4 4 0.48> 国:16",
    );
    expect(describeItems([body("国"), code("国"), body("国")])).toBe(
      "国:16 <1.75 0.7 2.31> 国:14 <2 0.8 2.64> 国:16",
    );
    expect(describeItems([code("国H")])).toBe("国:14 |0 H:7");
  });

  it("offers breaks in code at joiners and case changes without hyphenating", () => {
    expect(describeItems([code("fooBar.baz_qux")])).toBe(
      "foo:21 |100 Bar.:24.5 |100 baz_:24.5 |100 qux:21",
    );
    expect(describeItems([code("table")])).toBe("table:35");
    expect(describeItems([code("app.test.ts")])).toBe("app.:24.5 |100 test.ts:45.5");
    expect(describeItems([code("a.tsx_b")])).toBe("a.:10.5 |100 tsx_:24.5 |100 b:7");
    expect(text("table")).toBe("ta:16 |50- ble:24");
  });

  it("treats atoms as Latin-side boxes", () => {
    expect(describeItems([body("国"), { kind: "atom", advance: 30 }, body("国 x")])).toBe(
      "国:16 <4 4 0.48> @:30 <4 4 0.48> 国:16 <4 4 0.48>s x:8",
    );
  });

  it("adds a seam between upright and italic Han only", () => {
    const italic = { ...body("国"), isItalic: true };
    expect(describeItems([body("国"), italic, body("国")], { hanItalicSeam: 0.02 })).toBe(
      "国:16 <0.32 0.8 0.96> 国:16 <0.32 0.8 0.96> 国:16",
    );
    expect(describeItems([italic, italic], { hanItalicSeam: 0.02 })).toBe(
      "国:16 <0 0.8 0.64> 国:16",
    );
  });

  it("splits an unbreakable stretch of four em or more between every character", () => {
    expect(text("abcdefg")).toBe("abcdefg:56");
    expect(text("a1b2c3d4")).toBe(
      ["a:8", "1:8", "b:8", "2:8", "c:8", "3:8", "d:8", "4:8"].join(" |900 <0 0.32 0> "),
    );
    expect(describeItems([body("abc")], { splitWidth: 20 })).toBe(
      "a:8 |900 <0 0.32 0> b:8 |900 <0 0.32 0> c:8",
    );
  });

  it("keeps a hard break and the blank of an opening mark after it", () => {
    expect(describeItems([body("ab "), { kind: "break" }, body("「国")])).toBe(
      "ab:16 |-10000 <8 0 8> 「:8 国:16",
    );
  });

  it("measures words whole and fragments as differences of prefixes", () => {
    const asked: Array<string> = [];
    const measurer = {
      advance: (value: string) => {
        asked.push(value);
        return value.length;
      },
      spaceAdvance: () => 1,
      hyphenAdvance: () => 1,
    };
    buildItems([body("the considers")], measurer);
    expect(asked).toEqual(["the", "con", "consid", "considers"]);
  });
});
