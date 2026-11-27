import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { remarkReaderInlineSyntax } from "../markdown/readerInlineSyntax";
import { READER_REMARK_PLUGINS, REMARK_MATH } from "../markdown/readerRemarkPlugins";

export interface MarkdownSyntaxOptions {
  readonly math: boolean;
}

// The reading view's plugin lists, so gfm, math and directive syntax match it. Only `parse` runs:
// the transformers enrich rendering without changing structure, except the reader's own `==`,
// `^`, `~` pass, which does change the tree and is applied below.
const processors = {
  plain: unified()
    .use(remarkParse)
    .use([...CHAT_MARKDOWN_REMARK_PLUGINS, ...READER_REMARK_PLUGINS])
    .freeze(),
  math: unified()
    .use(remarkParse)
    .use([REMARK_MATH, ...CHAT_MARKDOWN_REMARK_PLUGINS, ...READER_REMARK_PLUGINS])
    .freeze(),
};

const applyReaderInlineSyntax = remarkReaderInlineSyntax();

export function parseMarkdownSyntax(source: string, options: MarkdownSyntaxOptions): Root {
  const tree = processors[options.math ? "math" : "plain"].parse(source);
  applyReaderInlineSyntax(tree as Parameters<typeof applyReaderInlineSyntax>[0], {
    toString: () => source,
  });
  return tree;
}
