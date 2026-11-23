import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerAddContextMenu } from "./ComposerAddContextMenu";

it("renders the Add to context rows and triggers each action", async () => {
  const addComposerAttachments = vi.fn(async () => false);
  const onPickFolder = vi.fn();
  const onOpenMention = vi.fn();
  const onOpenActions = vi.fn();
  const onOpenBrowser = vi.fn();
  const focusComposer = vi.fn();

  await using screen = await render(
    <ComposerAddContextMenu
      canAttachFiles
      addComposerAttachments={addComposerAttachments}
      onPickFolder={onPickFolder}
      onOpenMention={onOpenMention}
      onOpenActions={onOpenActions}
      onOpenBrowser={onOpenBrowser}
      focusComposer={focusComposer}
    />,
    { router: false }, // standalone menu test; no routes involved
  );

  const trigger = screen.getByRole("button", { name: "Add to context" });
  const fileInput = screen.container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(fileInput).not.toBeNull();
  using clickSpy = vi.spyOn(fileInput!, "click").mockImplementation(() => {});

  await userEvent.click(trigger);
  await expect.element(page.getByText("Add to context")).toBeVisible();
  await userEvent.click(page.getByRole("menuitem", { name: "Files" }));
  expect(clickSpy).toHaveBeenCalledTimes(1);

  const picked = new File(["hello"], "note.txt", { type: "text/plain" });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(picked);
  Object.defineProperty(fileInput!, "files", { configurable: true, value: dataTransfer.files });
  fileInput!.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(addComposerAttachments).toHaveBeenCalledWith([picked]));
  await vi.waitFor(() => expect(focusComposer).toHaveBeenCalledTimes(1));

  await userEvent.click(trigger);
  await userEvent.click(page.getByRole("menuitem", { name: "Folder" }));
  expect(onPickFolder).toHaveBeenCalledTimes(1);

  await userEvent.click(trigger);
  await userEvent.click(page.getByRole("menuitem", { name: "Mention" }));
  expect(onOpenMention).toHaveBeenCalledTimes(1);

  await userEvent.click(trigger);
  await userEvent.click(page.getByRole("menuitem", { name: "Actions" }));
  expect(onOpenActions).toHaveBeenCalledTimes(1);

  await userEvent.click(trigger);
  await userEvent.click(page.getByRole("menuitem", { name: "Browser" }));
  expect(onOpenBrowser).toHaveBeenCalledTimes(1);
});

it("supports arrow navigation, Enter selection, and returns focus to composer on Escape", async () => {
  const addComposerAttachments = vi.fn(async () => true);
  const onPickFolder = vi.fn();
  const onOpenMention = vi.fn();
  const onOpenActions = vi.fn();
  const onOpenBrowser = vi.fn();
  const focusComposer = vi.fn();

  await using screen = await render(
    <ComposerAddContextMenu
      canAttachFiles
      addComposerAttachments={addComposerAttachments}
      onPickFolder={onPickFolder}
      onOpenMention={onOpenMention}
      onOpenActions={onOpenActions}
      onOpenBrowser={onOpenBrowser}
      focusComposer={focusComposer}
    />,
    { router: false }, // standalone menu test; no routes involved
  );

  const trigger = screen.getByRole("button", { name: "Add to context" });
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("menuitem", { name: "Files" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("menuitem", { name: "Folder" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("menuitem", { name: "Mention" })).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(page.getByRole("menuitem", { name: "Folder" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onOpenMention).toHaveBeenCalledTimes(1);
  await expect.element(page.getByRole("menuitem", { name: "Mention" })).not.toBeInTheDocument();

  await userEvent.click(trigger);
  await expect.element(page.getByRole("menuitem", { name: "Files" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menuitem", { name: "Files" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusComposer).toHaveBeenCalledTimes(1));
});

it("omits unavailable rows and renders nothing when no actions are enabled", async () => {
  const addComposerAttachments = vi.fn(async () => true);
  const focusComposer = vi.fn();

  await using screen = await render(
    <ComposerAddContextMenu
      canAttachFiles={false}
      addComposerAttachments={addComposerAttachments}
      onOpenMention={vi.fn()}
      focusComposer={focusComposer}
    />,
    { router: false }, // standalone menu test; no routes involved
  );

  await userEvent.click(screen.getByRole("button", { name: "Add to context" }));
  await expect.element(page.getByRole("menuitem", { name: "Mention" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Files" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: "Folder" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: "Actions" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: "Browser" })).not.toBeInTheDocument();

  await screen.rerender(
    <ComposerAddContextMenu
      canAttachFiles={false}
      addComposerAttachments={addComposerAttachments}
      focusComposer={focusComposer}
    />,
  );
  await expect
    .element(screen.getByRole("button", { name: "Add to context" }))
    .not.toBeInTheDocument();
});
