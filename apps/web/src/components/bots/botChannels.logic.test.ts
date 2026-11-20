import { BotChannelMessageId, BotId, type BotChannelMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  channelFaces,
  filterChannels,
  insertMention,
  isAtBottom,
  mentionAt,
  mentionCandidates,
  namesSentence,
  parseMentions,
  retryablePost,
  scrollTopAfterPrepend,
} from "./botChannels.logic";

const bot = (handle: string, name = handle) => ({ id: BotId.make(`bot:${handle}`), handle, name });
const builder = bot("builder", "Builder");
const reviewer = bot("reviewer", "Reviewer");
const writer = bot("writer", "Writer");

describe("channelFaces", () => {
  const many = ["a", "b", "c", "d", "e"].map((handle) => bot(handle));
  it.each([
    [2, 2, 0],
    [4, 4, 0],
    [5, 3, 2],
  ])("%i members show %i faces and +%i", (count, shown, extra) => {
    const faces = channelFaces(
      many.slice(0, count).map((member) => member.id),
      many,
    );
    expect(faces.shown).toHaveLength(shown);
    expect(faces.extra).toBe(extra);
  });

  it("skips members whose bot is gone", () => {
    expect(channelFaces([BotId.make("bot:gone"), builder.id], [builder]).shown).toEqual([builder]);
  });
});

describe("namesSentence", () => {
  it.each([
    [[], ""],
    [["A"], "A"],
    [["A", "B"], "A and B"],
    [["A", "B", "C"], "A, B and C"],
  ])("%j", (names, sentence) => {
    expect(namesSentence(names)).toBe(sentence);
  });
});

describe("parseMentions", () => {
  const members = [builder, reviewer, writer];
  it.each([
    ["no mentions", "Ship it", []],
    ["one", "@builder ship it", [builder.id]],
    ["two, in order, case-insensitive", "@Writer and @builder", [writer.id, builder.id]],
    ["repeated", "@builder @builder", [builder.id]],
    ["not a member", "@someone", []],
    ["an email is not a mention", "mail me@builder.dev", []],
    ["after punctuation", "(@reviewer)", [reviewer.id]],
  ])("%s", (_label, text, ids) => {
    expect(parseMentions(text, members)).toEqual(ids);
  });
});

describe("mention autocomplete", () => {
  it.each([
    ["hi @bu", 6, { start: 3, query: "bu" }],
    ["@", 1, { start: 0, query: "" }],
    ["hi @bu there", 6, { start: 3, query: "bu" }],
    ["me@bu", 5, null],
    ["hi @bu ", 7, null],
  ])("%j at %i", (text, caret, expected) => {
    expect(mentionAt(text, caret)).toEqual(expected);
  });

  it("lists members by handle or name and inserts the handle", () => {
    expect(mentionCandidates([builder, reviewer, writer], "r")).toEqual([reviewer]);
    expect(mentionCandidates([builder, reviewer, writer], "")).toHaveLength(3);
    expect(insertMention("hi @bu there", 3, 6, "builder")).toEqual({
      text: "hi @builder  there",
      caret: 12,
    });
  });
});

describe("retryablePost", () => {
  const message = (
    id: string,
    kind: BotChannelMessage["kind"],
    status: BotChannelMessage["status"],
  ): BotChannelMessage => ({
    id: BotChannelMessageId.make(id),
    kind,
    authorBotId: null,
    text: id,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("finds the latest stopped or failed post, never an assignment", () => {
    expect(
      retryablePost([
        message("old", "user", "stopped"),
        message("newer", "user", "failed"),
        message("assigned", "assigned", "failed"),
        message("done", "user", "completed"),
      ])?.id,
    ).toBe("newer");
    expect(retryablePost([message("done", "user", "completed")])).toBeNull();
  });
});

describe("filterChannels", () => {
  const channels = [{ name: "launch" }, { name: "ops-review" }];
  it.each([
    ["", ["launch", "ops-review"]],
    ["#lau", ["launch"]],
    ["ops rev", ["ops-review"]],
    ["nothing", []],
  ])("%j", (query, names) => {
    expect(filterChannels(channels, query).map((channel) => channel.name)).toEqual(names);
  });
});

describe("scrolling", () => {
  it("counts the last few pixels as the bottom", () => {
    expect(isAtBottom({ scrollTop: 470, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isAtBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
  });

  it("keeps the rows in view when older ones load above", () => {
    expect(
      scrollTopAfterPrepend({ scrollTop: 10, previousScrollHeight: 1000, scrollHeight: 1600 }),
    ).toBe(610);
  });
});
