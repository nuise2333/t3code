import type { Element, ElementContent } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import "../index.css";
import { ReaderParagraph } from "./ReaderTypeset";

const text = (value: string): ElementContent => ({ type: "text", value });
const element = (tagName: string, children: Array<ElementContent>, properties = {}): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});

const PARAGRAPH = element("p", [
  text("Typography is the craft of arranging type so that written language is legible,\nreadable "),
  element("em", [text("and appealing")]),
  text(
    " when displayed. The arrangement involves selecting typefaces, point sizes, line lengths, ",
  ),
  element("strong", [text("line spacing")]),
  text(" and letter spacing, as well as "),
  element("a", [text("adjusting the space between pairs of letters")], {
    href: "https://example.com/kerning",
  }),
  text(". Call "),
  element("code", [text("typesetParagraph(runs, options)")]),
  text(" to set an internationalization-friendly paragraph; 中文与 English 混排也应当正确。"),
]);
const PROSE =
  "Typography is the craft of arranging type so that written language is legible, readable and appealing when displayed. The arrangement involves selecting typefaces, point sizes, line lengths, line spacing and letter spacing, as well as adjusting the space between pairs of letters. Call typesetParagraph(runs, options) to set an internationalization-friendly paragraph; 中文与 English 混排也应当正确。";

const reader = (
  <div className="h-80 overflow-y-auto">
    <div className="chat-markdown markdown-reader">
      <ReaderParagraph node={PARAGRAPH} components={{}} isEnabled>
        {toJsxRuntime(
          { type: "root", children: PARAGRAPH.children },
          { Fragment, jsx, jsxs, passKeys: true },
        )}
      </ReaderParagraph>
    </div>
  </div>
);

// A line's text may hang a mark past the column, by half an em at most.
const HANG = 8;

/** How far each broken line's text ends from the column's right edge, in the paragraph's own px. */
function lineEndGaps(paragraph: HTMLElement) {
  const column = paragraph.getBoundingClientRect();
  const scale = column.width / paragraph.offsetWidth;
  return [...paragraph.querySelectorAll(".reader-eol")].map(
    (end) => (end.getBoundingClientRect().left - column.right) / scale,
  );
}

function expectFilledColumn(paragraph: HTMLElement) {
  const gaps = lineEndGaps(paragraph);
  expect(gaps.length).toBeGreaterThan(1);
  for (const gap of gaps) {
    expect(gap).toBeGreaterThan(-0.5);
    expect(gap).toBeLessThan(HANG);
  }
  // Nothing wrapped on its own: the block is exactly as tall as the engine's lines.
  const lineHeight = Number.parseFloat(getComputedStyle(paragraph).lineHeight);
  expect(Math.round(paragraph.offsetHeight / lineHeight)).toBe(gaps.length + 1);
}

function readerZoom(value: string): Disposable {
  const root = document.documentElement;
  root.style.setProperty("--reader-zoom", value);
  return { [Symbol.dispose]: () => void root.style.removeProperty("--reader-zoom") };
}

it("sets a paragraph in lines that fill the column and copy as the source prose", async () => {
  const container = document.createElement("div");
  container.style.width = "624px";
  await using screen = await render(reader, { container });
  const paragraph = screen.container.querySelector("p")!;
  await expect.element(paragraph).toHaveAttribute("data-reader-typeset");

  expectFilledColumn(paragraph);
  expect(paragraph.innerText).toBe(PROSE);
  const selection = window.getSelection()!;
  selection.selectAllChildren(paragraph);
  expect(selection.toString()).toBe(PROSE);
  selection.removeAllRanges();
  expect(paragraph.querySelectorAll("a")).toHaveLength(1);
});

it("sets the lines again when the column or the view zoom changes", async () => {
  const container = document.createElement("div");
  container.style.width = "624px";
  await using screen = await render(reader, { container });
  const paragraph = screen.container.querySelector("p")!;
  await expect.element(paragraph).toHaveAttribute("data-reader-typeset");
  const linesBefore = paragraph.querySelectorAll(".reader-eol").length;

  container.style.width = "464px";
  await vi.waitFor(() => {
    expect(paragraph.querySelectorAll(".reader-eol").length).toBeGreaterThan(linesBefore);
    expectFilledColumn(paragraph);
  });

  using _zoom = readerZoom("0.8");
  await vi.waitFor(() => {
    expect(paragraph.offsetWidth).toBeGreaterThan(480);
    expectFilledColumn(paragraph);
  });
  expect(paragraph.innerText).toBe(PROSE);
});
