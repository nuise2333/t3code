import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { chatMarkdownClipboardPayload } from "../../markdown-clipboard";
import { MermaidDiagram } from "./MermaidDiagram";

it("keeps an oversized diagram copyable as a mermaid fence", async () => {
  // Under 64 Ki UTF-16 units but over 64 KiB of UTF-8.
  const source = `flowchart TD\n${"  甲-->乙\n".repeat(7000)}`;
  await using screen = await render(<MermaidDiagram source={source} onExpand={() => {}} />, {
    router: false, // The diagram reads no route state.
  });
  await expect.element(screen.getByText(/over the 64 KB limit/)).toBeVisible();
  const copy = screen.container.querySelector("[data-markdown-mermaid]");
  expect(copy?.getAttribute("data-markdown-copy")).toMatch(/^```mermaid\nflowchart TD\n/);

  // A selection inside the shown source copies only what is selected.
  const sourceText = screen.container.querySelector("pre")!.firstChild!;
  const range = document.createRange();
  range.setStart(sourceText, 0);
  range.setEnd(sourceText, "flowchart".length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  expect(chatMarkdownClipboardPayload(selection)?.text).toBe("flowchart");
  selection.removeAllRanges();
});
