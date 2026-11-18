import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Pluggable, PluggableList } from "unified";

import { remarkReaderInlineSyntax } from "./readerInlineSyntax";

/** Appended after the shared list: the remark-gfm entry reconfigures the one already there. */
export const READER_REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkReaderInlineSyntax,
];

/** Prepended to the shared list when Render math is on. */
export const REMARK_MATH: Pluggable = [remarkMath, { singleDollarTextMath: true }];
