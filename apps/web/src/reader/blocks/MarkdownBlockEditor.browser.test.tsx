import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { isMacPlatform } from "~/lib/utils";

import { render } from "../../../test/render";
import { MarkdownBlockEditor } from "./MarkdownBlockEditor";

const SOURCE = "---\r\ntitle: x\r\n---\r\n\r\n# Plan\r\n\r\nFirst  line  \r\n\r\n- a\r\n- b\r\n";

function Harness(props: { readonly onText: (text: string) => void }) {
  const [text, setText] = useState(SOURCE);
  return (
    <MarkdownBlockEditor
      text={text}
      math={false}
      externalRevision={0}
      onTextChange={(next) => {
        setText(next);
        props.onText(next);
      }}
      renderBlock={(block, source) => <p data-kind={block.kind}>{source}</p>}
    />
  );
}

const mod = isMacPlatform(navigator.platform) ? "Meta" : "Control";

it("edits a pressed block as source and writes back only its bytes", async () => {
  let latest = SOURCE;
  await using screen = await render(<Harness onText={(text) => (latest = text)} />, {
    router: false, // The editor is a plain component; no route reads it.
  });
  await userEvent.click(screen.getByText("# Plan"));
  const field = screen.getByRole("textbox", { name: "Markdown source" });
  await expect.element(field).toHaveValue("# Plan");

  await userEvent.keyboard("{End} today");
  // Arrow down from the last line closes this block and opens the next one at its start.
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(field).toHaveValue("First  line  ");
  expect(latest).toBe(SOURCE.replace("# Plan", "# Plan today"));

  // A paragraph command turns the open block into a quote, as one step.
  await userEvent.keyboard(`{${mod}>}{Shift>}q{/Shift}{/${mod}}`);
  await expect.element(field).toHaveValue("> First  line  ");
  await userEvent.keyboard("{Escape}");
  expect(latest).toBe(SOURCE.replace("# Plan", "# Plan today").replace("First", "> First"));

  // With no block open, undo takes back the last block's edit, leaving the earlier one.
  await userEvent.keyboard(`{${mod}>}z{/${mod}}`);
  expect(latest).toBe(SOURCE.replace("# Plan", "# Plan today"));
});
