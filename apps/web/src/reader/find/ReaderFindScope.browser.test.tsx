import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "../../index.css";
import { MarkdownDetails } from "~/components/chat/MarkdownDetails";
import { ScrollArea } from "~/components/ui/scroll-area";
import { isMacPlatform } from "~/lib/utils";
import { ReaderFindScope, type ReaderFindHandle } from "./ReaderFindScope";

const mod = (key: string) =>
  isMacPlatform(navigator.platform) ? `{Meta>}${key}{/Meta}` : `{Control>}${key}{/Control}`;

function activeMatch() {
  const [range] = CSS.highlights.get("t3-reader-find-active") ?? [];
  return range instanceof Range ? range : undefined;
}

it("finds through a fold, steps with the keyboard and hands focus back on Escape", async () => {
  const handle = createRef<ReaderFindHandle>();
  await using screen = await render(
    <div className="flex h-60 flex-col">
      <button type="button">Before</button>
      <ReaderFindScope handleRef={handle}>
        <ScrollArea className="min-h-0 flex-1" viewportTabIndex={-1}>
          <div className="chat-markdown markdown-reader">
            <p>
              The first <em>needle</em> is plain.
            </p>
            <MarkdownDetails>
              <summary>Folded</summary>
              <p>A folded needle waits here.</p>
            </MarkdownDetails>
          </div>
        </ScrollArea>
      </ReaderFindScope>
    </div>,
    // A bare component; nothing here reads the router.
    { router: false },
  );

  const before = screen.getByRole("button", { name: "Before" });
  (before.element() as HTMLElement).focus();
  await act(() => handle.current?.open());
  const input = screen.getByRole("searchbox", { name: "Find in document" });
  await expect.element(input).toHaveFocus();

  await userEvent.type(input, "NEEDLE");
  await expect.element(screen.getByText("1/2")).toBeVisible();
  expect(activeMatch()?.toString()).toBe("needle");
  await expect.element(screen.getByText("A folded needle waits here.")).not.toBeVisible();

  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("2/2")).toBeVisible();
  await expect.element(screen.getByText("A folded needle waits here.")).toBeVisible();
  await vi.waitFor(() =>
    expect(activeMatch()?.startContainer.textContent).toBe("A folded needle waits here."),
  );

  await userEvent.keyboard(mod("g"));
  await expect.element(screen.getByText("1/2")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(input).not.toBeInTheDocument();
  await expect.element(before).toHaveFocus();
  expect(CSS.highlights.has("t3-reader-find")).toBe(false);
});
