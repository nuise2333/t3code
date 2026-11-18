# Markdown file editor

The rendered view of a workspace Markdown file is an editor
([`ReaderEditor`](../../apps/web/src/reader/editor/ReaderEditor.tsx), mounted by
[`FileMarkdownEditor`](../../apps/web/src/components/files/FileMarkdownEditor.tsx)). It must look
exactly like the read-only reading view and must never change bytes the user did not touch.

## Every byte has one place

The editor's text is the file's own source, inline syntax included. Each leaf (paragraph, heading,
code or raw block) holds its content as text; the bytes around it (container markers, fences,
line endings, blank lines) are its `before` and `after` attributes, and the container prefixes of
its later lines are `linePrefix` atoms. Serializing joins those strings and never generates
Markdown, so an untouched region always writes back as it was read.

Formatting is drawn with ProseMirror decorations from an analysis of each leaf; markers are real
characters the decorations hide away from the caret. Nothing stores marks. A long file draws only
its start when the state is made; the typeset scan draws other leaves as they near the view,
before they are painted, and measures a leaf only once it is drawn.

## Structure changes are source edits

Enter, Backspace at a marker, Tab, task toggles, paste, a space typed after a block marker and
the caret leaving a block whose text no longer parses as its kind all edit the source of the
affected top-level blocks and parse them again
([`replaceRegionSource`](../../apps/web/src/reader/editor/markdownFileEdits.ts)). The structure
is therefore always what Markdown makes of the bytes. A selection across blocks is replaced the
same way; native editing is only ever trusted inside one leaf.

## One grammar

The editor parses with the reading view's remark plugin lists
([`markdownFileSyntax.ts`](../../apps/web/src/reader/editor/markdownFileSyntax.ts)), so links,
`==mark==`, references and escapes behave as the reader renders them. Anything that grammar
cannot represent exactly as editable text (tables, HTML, math, images, footnote definitions,
front matter) is a raw block: source while the caret is in it, the reader's own rendering
otherwise. Reader-only enrichments (file-path links, inline-code chips, citation and thread
chips, autolink suffixes) render as plain text, code or links while editing; parity holds
without them.

## Typesetting parity

The reading view's engine sets the editable paragraphs, headings and list item text too. Its
lines become decorations over the editable text: inline spans with the engine's spacing and
baseline classes, and widgets for line ends and hyphens
([`typesetPlugin.ts`](../../apps/web/src/reader/editor/typesetPlugin.ts),
`readerLineDecorations` beside `readerLineNodes` in
[`readerLines.ts`](../../apps/web/src/reader/readerLines.ts), sharing `pieceSpanStyles`). The
runs come from the shown text with white space reduced as the reader's Markdown to HTML step
reduces it ([`editorFlow.ts`](../../apps/web/src/reader/editor/editorFlow.ts)); any change there
must keep the two views' runs equal. ProseMirror wraps a text node in its decorations from the
inside out, which is why each stretch emits its own span before its style elements.

## The round-trip guard

A document whose parse does not serialize back to the file exactly is shown read-only, with a
notice to use source view, and is never written. The parse corpus test makes that a bug.
