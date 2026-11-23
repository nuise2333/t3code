import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";

import { ensureClientSettingsHydrated, persistClientSettingsPatch } from "../../hooks/useSettings";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

const setWordWrap = (wordWrap: boolean) =>
  act(() => persistClientSettingsPatch({ wordWrap }, async () => {}));

it("follows a changed word wrap default while mounted", async () => {
  await ensureClientSettingsHydrated();
  await setWordWrap(false);
  await using screen = await render(
    <MarkdownCodeBlock
      code="a long line"
      language="text"
      fenceTitle={null}
      theme="light"
      isStreaming={false}
    >
      <pre>
        <code>a long line</code>
      </pre>
    </MarkdownCodeBlock>,
    { router: false }, // The code block reads no route state.
  );
  const block = () => screen.container.querySelector(".chat-markdown-codeblock");
  expect(block()?.getAttribute("data-wrap")).toBe("false");

  await setWordWrap(true);
  await expect.element(screen.getByRole("button", { name: "Disable line wrap" })).toBeVisible();
  expect(block()?.getAttribute("data-wrap")).toBe("true");
});

it("invokes onCiteCodeBlock from the @ button when finished and hides it while streaming", async () => {
  const onCiteCodeBlock = vi.fn();
  await using screen = await render(
    <MarkdownCodeBlock
      code={"const answer = 42;\n"}
      language="ts"
      fenceTitle="src/example.ts"
      theme="light"
      isStreaming={false}
      onCiteCodeBlock={onCiteCodeBlock}
    >
      <pre>
        <code>{"const answer = 42;\n"}</code>
      </pre>
    </MarkdownCodeBlock>,
    { router: false }, // The code block reads no route state.
  );

  const citeButton = screen.getByRole("button", { name: "Cite code block in composer" });
  await expect.element(citeButton).toBeVisible();
  await userEvent.click(citeButton);
  expect(onCiteCodeBlock).toHaveBeenCalledTimes(1);
  expect(onCiteCodeBlock).toHaveBeenCalledWith(
    expect.objectContaining({
      code: "const answer = 42;\n",
      language: "ts",
      fenceTitle: "src/example.ts",
    }),
  );

  await screen.rerender(
    <MarkdownCodeBlock
      code={"const answer = 42;\n"}
      language="ts"
      fenceTitle="src/example.ts"
      theme="light"
      isStreaming
      onCiteCodeBlock={onCiteCodeBlock}
    >
      <pre>
        <code>{"const answer = 42;\n"}</code>
      </pre>
    </MarkdownCodeBlock>,
  );
  expect(screen.container.querySelector('[aria-label="Cite code block in composer"]')).toBeNull();
});
