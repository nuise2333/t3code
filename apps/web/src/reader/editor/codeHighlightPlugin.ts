import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { languageOfInfoString } from "~/composer-code-languages";
import { getSyntaxHighlighterPromise, MAX_HIGHLIGHTED_CODE_LENGTH } from "~/lib/syntaxHighlighting";

import { READER_SYNTAX_THEME_NAME } from "../markdown/readerSyntaxTheme";
import { leafTextOf, replacedRange } from "./inlineSyntaxPlugin";
import { leafText } from "./markdownFileSerialize";
import { nearBlocks, scrollerOf } from "./typesetPlugin";

interface ColoredRange {
  readonly from: number;
  readonly to: number;
  readonly color: string;
}

const MAX_CACHED = 300;
// Colored ranges per language and code, in offsets of the block's text.
const tokenCache = new Map<string, ReadonlyArray<ColoredRange>>();
const pending = new Set<string>();

const languageOf = (node: ProseMirrorNode) =>
  languageOfInfoString((node.attrs.info as string).trim()).toLowerCase();
const cacheKey = (language: string, text: string) => `${language}\u0001${text}`;

async function tokenize(language: string, text: string): Promise<ReadonlyArray<ColoredRange>> {
  const highlighter = await getSyntaxHighlighterPromise(language);
  const { tokens } = highlighter.codeToTokens(text, {
    lang: language,
    theme: READER_SYNTAX_THEME_NAME,
  });
  const ranges: ColoredRange[] = [];
  const lines = text.split(/(\r\n|\r|\n)/);
  let offset = 0;
  for (let line = 0; line * 2 < lines.length; line++) {
    const lineText = lines[line * 2]!;
    let at = offset;
    for (const token of tokens[line] ?? []) {
      const to = at + token.content.length;
      if (token.color && !token.color.includes("--reader-foreground")) {
        ranges.push({ from: at, to, color: token.color });
      }
      at = to;
    }
    // The highlighter rewrote the line; leave the block uncoloured rather than misplace colour.
    if (at - offset !== lineText.length) return [];
    offset += lineText.length + (lines[line * 2 + 1]?.length ?? 0);
  }
  return ranges;
}

function blockDecorations(node: ProseMirrorNode, pos: number): Decoration[] | null {
  const language = languageOf(node);
  if (language === "") return [];
  if (leafText(node).length > MAX_HIGHLIGHTED_CODE_LENGTH) return [];
  const leaf = leafTextOf(node, pos);
  const ranges = tokenCache.get(cacheKey(language, leaf.text));
  if (!ranges) return null;
  return ranges.map((range) =>
    Decoration.inline(leaf.startPos(range.from), leaf.endPos(range.to), {
      style: `color:${range.color}`,
    }),
  );
}

const codeHighlightKey = new PluginKey<DecorationSet>("md-code-highlight");

function codeBlocksIn(doc: ProseMirrorNode, from: number, to: number) {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "codeBlock") blocks.push({ node, pos });
    return !node.isTextblock;
  });
  return blocks;
}

/**
 * Colours fenced code with the reader's syntax theme. Only blocks near the view are tokenized,
 * as the reading view does; tokens are cached by language and text and computed a frame after
 * an edit or scroll. Until they arrive a block keeps its previous colours mapped through edits.
 */
export function createCodeHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: codeHighlightKey,
    state: {
      init: (_, state) => {
        const decorations: Decoration[] = [];
        for (const { node, pos } of codeBlocksIn(state.doc, 0, state.doc.content.size)) {
          decorations.push(...(blockDecorations(node, pos) ?? []));
        }
        return DecorationSet.create(state.doc, decorations);
      },
      apply: (tr, set, _old, state) => {
        // The cache keys of blocks whose tokens arrived.
        const arrived = tr.getMeta(codeHighlightKey) as ReadonlySet<string> | undefined;
        if (!tr.docChanged && !arrived) return set;
        let mapped = set.map(tr.mapping, state.doc);
        const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
        const range = tr.docChanged ? replacedRange(tr) : null;
        if (range) {
          const end = Math.min(state.doc.content.size, range.to + 1);
          blocks.push(...codeBlocksIn(state.doc, Math.max(0, range.from - 1), end));
        }
        if (arrived) {
          for (const block of codeBlocksIn(state.doc, 0, state.doc.content.size)) {
            if (arrived.has(cacheKey(languageOf(block.node), leafText(block.node)))) {
              blocks.push(block);
            }
          }
        }
        for (const { node, pos } of blocks) {
          const fresh = blockDecorations(node, pos);
          if (!fresh) continue;
          const to = pos + node.nodeSize;
          mapped = mapped.remove(mapped.find(pos, to)).add(state.doc, fresh);
        }
        return mapped;
      },
    },
    props: { decorations: (state) => codeHighlightKey.getState(state) },
    view: (view) => {
      let frame = 0;
      let arrived = new Set<string>();
      const deliver = () => {
        if (view.isDestroyed || arrived.size === 0) return;
        const keys = arrived;
        arrived = new Set();
        view.dispatch(view.state.tr.setMeta(codeHighlightKey, keys).setMeta("addToHistory", false));
      };
      let scroller: HTMLElement | null | undefined;
      const request = () => {
        frame = 0;
        if (view.isDestroyed) return;
        // Read once the view is laid out, not while the commit that made it runs.
        if (scroller === undefined) {
          scroller = scrollerOf(view.dom);
          scroller?.addEventListener("scroll", schedule, { passive: true });
        }
        const missing = new Map<string, { language: string; text: string }>();
        for (const block of nearBlocks(view)) {
          const end = block.pos + block.node.nodeSize;
          for (const { node } of codeBlocksIn(view.state.doc, block.pos, end)) {
            const language = languageOf(node);
            if (language === "") continue;
            const text = leafText(node);
            if (text.length > MAX_HIGHLIGHTED_CODE_LENGTH) continue;
            const key = cacheKey(language, text);
            if (!tokenCache.has(key) && !pending.has(key)) missing.set(key, { language, text });
          }
        }
        for (const [key, { language, text }] of missing) {
          pending.add(key);
          void tokenize(language, text)
            .catch(() => [])
            .then((ranges) => {
              pending.delete(key);
              if (tokenCache.size >= MAX_CACHED) tokenCache.clear();
              tokenCache.set(key, ranges);
              if (arrived.size === 0) queueMicrotask(deliver);
              arrived.add(key);
            });
        }
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(request);
      };
      schedule();
      return {
        update: (_view, previous) => {
          if (view.state.doc !== previous.doc) schedule();
        },
        destroy: () => {
          cancelAnimationFrame(frame);
          scroller?.removeEventListener("scroll", schedule);
        },
      };
    },
  });
}
