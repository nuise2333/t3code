import type { RuntimeMode } from "@t3tools/contracts";
import { type ReactNode, useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import { ComposerContextPermissions } from "../ComposerContextPermissions";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  focusRequestedPermission,
  markOpenToPermissions,
  useComposerMenuProps,
} from "./composerEventScope";
import { ComposerFooterModeControls, ComposerPermissionsSection } from "./ComposerFooterControls";
import { ComposerPickerFooter } from "./ComposerModelEffort";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";

const options = runtimeModeOptions.map((mode) => ({ mode, ...runtimeModeConfig[mode] }));

// Mirrors the overflow menu, which holds the Permissions section.
function OverflowMenu() {
  const [mode, setMode] = useState<RuntimeMode>("full-access");
  const composerMenuProps = useComposerMenuProps();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Menu onOpenChangeComplete={(open) => focusRequestedPermission(open, triggerRef.current)}>
        <MenuTrigger ref={triggerRef}>More</MenuTrigger>
        <MenuPopup {...composerMenuProps}>
          <ComposerPermissionsSection
            runtimeMode={mode}
            defaultRuntimeMode="full-access"
            runtimeModeOptions={options}
            onRuntimeModeChange={setMode}
          />
        </MenuPopup>
      </Menu>
      <p role="status">{mode}</p>
    </>
  );
}

it("reaches Permissions with arrow keys, shows the Default pill, and picks with Enter", async () => {
  await using screen = await render(<OverflowMenu />, { router: false }); // no routes involved
  const trigger = screen.getByRole("button", { name: "More" });
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  const supervised = page.getByRole("menuitemradio", { name: "Supervised" });
  await expect.element(supervised).toHaveFocus();
  await expect
    .element(supervised)
    .toHaveAccessibleDescription("Ask before commands and file changes.");
  await expect.element(page.getByText("Default", { exact: true })).toBeVisible();

  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Auto-accept edits" }))
    .toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(supervised).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(screen.getByRole("status")).toHaveTextContent("auto-accept-edits");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Supervised" }))
    .not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("marks the current mode as checked and closes on Escape", async () => {
  await using screen = await render(<OverflowMenu />, { router: false }); // no routes involved
  await userEvent.tab();
  await userEvent.keyboard("{ArrowDown}");
  const fullAccess = page.getByRole("menuitemradio", { name: "Full access" });
  await expect.element(fullAccess).toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(fullAccess).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "More" })).toHaveFocus();
});

// The real composer menu focus rule (useComposerMenuProps), with a stub composer handle.
function withComposer(children: ReactNode) {
  const handle = { focusAtEnd: vi.fn() };
  const ref = { current: handle } as unknown as ComposerHandleRef;
  return { handle, ui: <ComposerHandleContext value={ref}>{children}</ComposerHandleContext> };
}

it("returns focus to the editor after a pick", async () => {
  const { handle, ui } = withComposer(<OverflowMenu />);
  await using screen = await render(ui, { router: false }); // no routes involved
  await userEvent.tab();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(page.getByRole("menuitemradio", { name: "Supervised" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("status")).toHaveTextContent("approval-required");
  await vi.waitFor(() => expect(handle.focusAtEnd).toHaveBeenCalled());
});

// Standalone footer permissions control: opens on tap and closes on outside tap without focusing editor on touch.
function StandalonePermissions() {
  const [mode, setMode] = useState<RuntimeMode>("full-access");
  return (
    <>
      <p>Timeline</p>
      <ComposerFooterModeControls
        runtimeMode={mode}
        defaultRuntimeMode="full-access"
        runtimeModeOptions={options}
        accessDisplay="label"
        onRuntimeModeChange={setMode}
      />
    </>
  );
}

it("on a touch tablet, tapping outside the standalone Permissions menu leaves the editor unfocused", async () => {
  const realMatchMedia = window.matchMedia.bind(window);
  using _touch = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => realMatchMedia(query === "(pointer: coarse)" ? "all" : query));
  const { handle, ui } = withComposer(<StandalonePermissions />);
  await using screen = await render(ui, { router: false }); // no routes involved
  await userEvent.click(screen.getByRole("button", { name: "Permissions: Full access" }));
  const fullAccess = page.getByRole("menuitemradio", { name: "Full access" });
  await expect.element(fullAccess).toBeInTheDocument();
  await userEvent.click(document.body, { position: { x: 1, y: 1 } });
  await expect.element(fullAccess).not.toBeInTheDocument();
  // Focusing the editor after a tap opens the on-screen keyboard on Android tablets.
  expect(handle.focusAtEnd).not.toHaveBeenCalled();
});

it("renders View Usage in the model picker footer without a duplicate permissions control", async () => {
  const onViewUsage = vi.fn();
  await using screen = await render(
    <Popover>
      <PopoverTrigger>Model</PopoverTrigger>
      <PopoverPopup>
        <ComposerPickerFooter onViewUsage={onViewUsage} />
      </PopoverPopup>
    </Popover>,
    { router: false }, // no routes involved
  );
  await userEvent.click(screen.getByRole("button", { name: "Model" }));
  await expect.element(page.getByRole("button", { name: /Permissions:/ })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "View Usage" }));
  expect(onViewUsage).toHaveBeenCalledOnce();
});

it("opens on the checked permission when composer.mode marked the trigger", async () => {
  await using screen = await render(<OverflowMenu />, { router: false }); // no routes involved
  const trigger = screen.getByRole("button", { name: "More" });
  markOpenToPermissions(trigger.element() as HTMLElement);
  await userEvent.click(trigger);
  await expect.element(page.getByRole("menuitemradio", { name: "Full access" })).toHaveFocus();

  // The mark is used once: a plain reopen lands on the menu's usual first focus.
  await userEvent.keyboard("{Escape}");
  await userEvent.click(trigger);
  await expect.element(page.getByRole("menuitemradio", { name: "Full access" })).not.toHaveFocus();
});

// Mirrors ComposerControlsBar: the standalone permissions trigger stays visible and changes mode.
function PermissionsChip() {
  const [mode, setMode] = useState<RuntimeMode>("approval-required");
  return (
    <div data-slot="composer-shell">
      <button type="button" data-composer-shortcut="composer.effort">
        Model
      </button>
      <ComposerFooterModeControls
        runtimeMode={mode}
        defaultRuntimeMode="full-access"
        runtimeModeOptions={options}
        accessDisplay="label"
        onRuntimeModeChange={setMode}
      />
    </div>
  );
}

it("changes mode from the standalone footer control and returns focus to the editor", async () => {
  const { handle, ui } = withComposer(<PermissionsChip />);
  await using screen = await render(ui, { router: false }); // no routes involved
  await userEvent.click(screen.getByRole("button", { name: "Permissions: Supervised" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Full access" }));
  await expect
    .element(screen.getByRole("button", { name: "Permissions: Full access" }))
    .toBeVisible();
  await vi.waitFor(() => expect(handle.focusAtEnd).toHaveBeenCalled());
  await expect.element(screen.getByRole("button", { name: "Model" })).not.toHaveFocus();
});

function ContextPermissions() {
  const [mode, setMode] = useState<RuntimeMode>("full-access");
  return (
    <ComposerContextPermissions
      environmentId={null}
      runtimeMode={mode}
      supportedRuntimeModes={["approval-required", "full-access"]}
      onRuntimeModeChange={setMode}
    />
  );
}

it("opens permissions directly from the context strip and applies a supported mode", async () => {
  await using screen = await render(<ContextPermissions />, { router: false }); // no routes involved
  await userEvent.click(screen.getByRole("button", { name: "Permissions: Full access" }));
  await expect
    .element(page.getByRole("menuitemradio", { name: "Full access" }))
    .toHaveAttribute("aria-checked", "true");
  await expect
    .element(page.getByRole("menuitemradio", { name: "Auto", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.click(page.getByRole("menuitemradio", { name: "Supervised" }));
  const trigger = screen.getByRole("button", { name: "Permissions: Supervised" });
  await expect.element(trigger).toBeVisible();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Supervised" }))
    .not.toBeInTheDocument();
  await userEvent.click(trigger);
  await expect
    .element(page.getByRole("menuitemradio", { name: "Supervised" }))
    .toHaveAttribute("aria-checked", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
});
