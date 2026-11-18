import { describe, expect, it } from "vite-plus/test";
import { canBreakAcrossSpace, canBreakBetween, lineBreakClass } from "./lineBreak";

function opportunities(text: string) {
  const chars = Array.from(text);
  let out = chars[0] ?? "";
  for (let index = 1; index < chars.length; index += 1) {
    const before = lineBreakClass(chars[index - 1]!.codePointAt(0)!);
    const after = lineBreakClass(chars[index]!.codePointAt(0)!);
    out += (canBreakBetween(before, after) ? "|" : "") + chars[index];
  }
  return out;
}

describe("line break opportunities", () => {
  it.each([
    ["他说：“你好。”他走了。", "他|说：“你|好。”他|走|了。"],
    ["国，国。国）国」国", "国，|国。|国）|国」|国"],
    ["国（国「国《国", "国|（国|「国|《国"],
    ["国——国", "国|——|国"],
    ["国……国", "国……|国"],
    ["国·国・国", "国|·|国・|国"],
    ["国～国〜国", "国|～|国〜|国"],
    ["国ー国っ国々国", "国ー|国っ|国々|国"],
    ["国%国$国", "国%|国|$国"],
    ["国H国8国", "国|H|国|8|国"],
    ["a（b）c", "a（b）|c"],
    ["国(国)国", "国|(国)|国"],
    ["state-of-the-art", "state-|of-|the-|art"],
    ["a/b/c.d,e", "a/|b/|c.d,e"],
    ["x-1", "x-1"],
    ["3.14%", "3.14%"],
  ])("%s", (text, expected) => {
    expect(opportunities(text)).toBe(expected);
  });

  it("keeps closing marks and the inside of an opening bracket together across spaces", () => {
    const cls = (char: string) => lineBreakClass(char.codePointAt(0)!);
    expect(canBreakAcrossSpace(cls("a"), cls("b"))).toBe(true);
    expect(canBreakAcrossSpace(cls("a"), cls("("))).toBe(true);
    expect(canBreakAcrossSpace(cls("("), cls("a"))).toBe(false);
    expect(canBreakAcrossSpace(cls("a"), cls("!"))).toBe(false);
    expect(canBreakAcrossSpace(cls("a"), cls("）"))).toBe(false);
  });
});
