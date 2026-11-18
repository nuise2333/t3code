import { DEFAULT_CLIENT_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import * as commandPalette from "../commandPaletteBus";
import * as settings from "../hooks/useSettings";
import * as storage from "../hooks/useLocalStorage";
import * as threadActions from "../lib/chatThreadActions";
import * as entities from "../state/entities";
import * as projectsState from "../state/projects";
import * as session from "../state/session";
import { Atom } from "effect/reactivity";
import type { Project } from "../types";
import { installChatRouteCommands } from "./chatRouteCommands";
import * as previewActions from "../components/preview/previewActionBus";
import * as dispatcher from "./dispatcher";
import * as readerFocus from "./readerFocus";

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("new thread commands", () => {
  it.each([
    { mode: "normal", count: 2, command: "chat.new", picker: true },
    { mode: "boring", count: 2, command: "chat.new", picker: true },
    { mode: "boring", count: 1, command: "chat.new", picker: false },
    { mode: "boring", count: 2, command: "chat.newLocal", picker: false },
  ] as const)("$mode sidebar, $count projects, $command: picker=$picker", (scenario) => {
    using _settings = vi.spyOn(settings, "getClientSettings").mockReturnValue({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    using _projects = vi
      .spyOn(entities, "readProjects")
      .mockReturnValue([project("active"), project("idle")].slice(0, scenario.count));
    using _ready = vi
      .spyOn(projectsState, "defaultProjectFallbackReadyAtom")
      .mockReturnValue(Atom.make(true));
    using storedProject = vi.spyOn(storage, "getLocalStorageItem").mockReturnValue("local:active");
    using openPicker = vi.spyOn(commandPalette, "openCommandPalette").mockImplementation(() => {});
    using startLocal = vi.spyOn(threadActions, "startNewThreadFromContext").mockResolvedValue(true);
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = { state: { matches: [] } } as unknown as AnyRouter;
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    const commands = register.mock.calls[0]![0];
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    storedProject.mockReturnValue("local:idle");
    commands[scenario.command]!(event);

    if (scenario.picker) {
      expect(openPicker).toHaveBeenCalledWith({ open: "new-thread-in" });
      expect(startLocal).not.toHaveBeenCalled();
    } else {
      expect(openPicker).not.toHaveBeenCalled();
      expect(startLocal).toHaveBeenCalledOnce();
      expect(startLocal.mock.calls[0]![0].defaultProjectRef).toEqual({
        environmentId: "local",
        projectId: scenario.count === 1 ? "active" : "idle",
      });
    }
  });
});

describe("zoom keys in the reading view", () => {
  it.each([
    { command: "preview.zoomIn", readerFocused: true, readerZoom: 110 },
    { command: "preview.resetZoom", readerFocused: true, readerZoom: 100 },
    { command: "reader.zoomOut", readerFocused: true, readerZoom: 90 },
    { command: "preview.zoomIn", readerFocused: false, readerZoom: null },
  ] as const)(
    "$command with reader focus $readerFocused sets reading zoom $readerZoom",
    (scenario) => {
      using _settings = vi
        .spyOn(settings, "getClientSettings")
        .mockReturnValue({ ...DEFAULT_CLIENT_SETTINGS, readerZoom: 100 });
      using update = vi.spyOn(settings, "updateClientSettings").mockResolvedValue();
      using _focus = vi
        .spyOn(readerFocus, "isReaderFocused")
        .mockReturnValue(scenario.readerFocused);
      using previewAction = vi
        .spyOn(previewActions, "dispatchPreviewAction")
        .mockImplementation(() => {});
      using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
      const router = { state: { matches: [] } } as unknown as AnyRouter;
      using stack = new DisposableStack();
      stack.defer(installChatRouteCommands(router));
      const commands = register.mock.calls[0]![0];
      const event = {
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as KeyboardEvent;

      commands[scenario.command]!(event);

      expect(event.preventDefault).toHaveBeenCalled();
      if (scenario.readerZoom === null) {
        expect(update).not.toHaveBeenCalled();
      } else {
        expect(previewAction).not.toHaveBeenCalled();
        if (scenario.readerZoom === 100) expect(update).not.toHaveBeenCalled();
        else expect(update).toHaveBeenCalledWith({ readerZoom: scenario.readerZoom });
      }
    },
  );
});

describe("preview commands without the preview-operate scope", () => {
  it.each([
    { command: "preview.find", action: "find", dispatched: true },
    { command: "preview.refresh", action: "refresh", dispatched: false },
  ] as const)("$command dispatches: $dispatched", (scenario) => {
    using _scope = vi.spyOn(session, "readEnvironmentScope").mockReturnValue(false);
    using _focus = vi.spyOn(readerFocus, "isReaderFocused").mockReturnValue(false);
    using previewAction = vi
      .spyOn(previewActions, "dispatchPreviewAction")
      .mockImplementation(() => {});
    using register = vi.spyOn(dispatcher, "registerCommands").mockReturnValue(() => {});
    const router = {
      state: { matches: [{ params: { environmentId: "local", threadId: "thread-1" } }] },
    } as unknown as AnyRouter;
    using stack = new DisposableStack();
    stack.defer(installChatRouteCommands(router));
    const commands = register.mock.calls[0]![0];
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent;

    commands[scenario.command]!(event);

    if (scenario.dispatched) expect(previewAction).toHaveBeenCalledWith(scenario.action);
    else expect(previewAction).not.toHaveBeenCalled();
  });
});
