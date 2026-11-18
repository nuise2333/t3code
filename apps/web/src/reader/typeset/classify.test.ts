import { describe, expect, it } from "vite-plus/test";
import { charClass, hangFraction, punctuationSide, scriptClass } from "./classify";

const cp = (char: string) => char.codePointAt(0) ?? 0;

describe("character classes", () => {
  it.each([
    ["国", "han", "han"],
    ["々", "han", "han"],
    ["あ", "kana", "han"],
    ["ー", "kana", "han"],
    ["한", "hangul", "han"],
    ["「", "fullWidthOpening", "cjkPunctuation"],
    ["（", "fullWidthOpening", "cjkPunctuation"],
    ["」", "fullWidthClosing", "cjkPunctuation"],
    ["，", "fullWidthStop", "cjkPunctuation"],
    ["。", "fullWidthStop", "cjkPunctuation"],
    ["：", "fullWidthStop", "cjkPunctuation"],
    ["・", "fullWidthMiddle", "han"],
    ["—", "fullWidthMiddle", "other"],
    ["…", "fullWidthMiddle", "other"],
    ["Ａ", "fullWidthOther", "cjkPunctuation"],
    ["\u3000", "fullWidthOther", "cjkPunctuation"],
    ["a", "latinLetter", "latin"],
    ["é", "latinLetter", "latin"],
    ["7", "digit", "latin"],
    ["(", "asciiPunctuation", "other"],
    ["α", "other", "other"],
    ["Я", "other", "other"],
    ["“", "other", "other"],
    ["×", "other", "latin"],
    ["÷", "other", "latin"],
    ["𠀀", "other", "other"],
    [" ", "space", "space"],
  ] as const)("%s is %s / %s", (char, fine, script) => {
    expect(charClass(cp(char))).toBe(fine);
    expect(scriptClass(cp(char))).toBe(script);
  });

  it("puts stops on the closing side and leaves quotes, dashes and middle dots unsqueezed", () => {
    expect(Array.from("「（《『【", (char) => punctuationSide(cp(char)))).toEqual(
      Array.from({ length: 5 }, () => "opening"),
    );
    expect(Array.from("」）》、。，：；？！", (char) => punctuationSide(cp(char)))).toEqual(
      Array.from({ length: 10 }, () => "closing"),
    );
    expect(Array.from("“”—…·・～国a(", (char) => punctuationSide(cp(char)))).toEqual(
      Array.from({ length: 10 }, () => undefined),
    );
  });

  it("hangs commas and full stops fully, other closers by half, and nothing else", () => {
    expect(Array.from("，。、．,.", (char) => hangFraction(cp(char)))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(Array.from("；：？！）」』》;:!?)]”’", (char) => hangFraction(cp(char)))).toEqual(
      Array.from({ length: 16 }, () => 0.5),
    );
    expect(Array.from("-–…%］｝（国a", (char) => hangFraction(cp(char)))).toEqual(
      Array.from({ length: 9 }, () => 0),
    );
  });
});
