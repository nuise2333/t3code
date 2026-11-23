import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  CopyIcon,
  MessageCircleQuestionIcon,
  Minimize2Icon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { chatMarkdownClipboardPayload } from "~/markdown-clipboard";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut } from "../ui/menu";

const EXCLUDED_TARGET_SELECTOR =
  'a[href], button, [role="button"], input, textarea, select, [contenteditable="true"], [role="textbox"], [role="menu"], [role="dialog"], img, video, audio, canvas, iframe';

interface TimelineContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly selectedText: string;
  readonly messageText: string | null;
  readonly composerHasDraft: boolean;
  readonly citationSelection: {
    readonly citation: AssistantCitation;
    readonly sourceAnchor: AssistantCitationSourceAnchor;
  } | null;
}

export interface TimelineContextMenuProps {
  readonly viewport: HTMLElement | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly resolveMessageText: (messageId: string) => string | null;
  readonly hasComposerDraft?: (() => boolean) | undefined;
  readonly onAskAsideWithCitation?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
  readonly onAskAsideEmpty?: (() => boolean) | undefined;
  readonly sideChatAvailable?: boolean | undefined;
  readonly sideChatDisabledReason?: string | null | undefined;
  readonly onCompactContext?: (() => void) | undefined;
  readonly compactDisabled?: boolean | undefined;
  readonly onFreshSession?: (() => void) | undefined;
  readonly freshSessionDisabled?: boolean | undefined;
  readonly onOpenModelPicker?: (() => void) | undefined;
}

export function TimelineContextMenu({
  viewport,
  threadRef,
  resolveMessageText,
  hasComposerDraft,
  onAskAsideWithCitation,
  onAskAsideEmpty,
  sideChatAvailable,
  sideChatDisabledReason,
  onCompactContext,
  compactDisabled,
  onFreshSession,
  freshSessionDisabled,
  onOpenModelPicker,
}: TimelineContextMenuProps) {
  const [menuState, setMenuState] = useState<TimelineContextMenuState | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for right-click contextmenu events inside the timeline viewport
  useEffect(() => {
    if (!viewport) return;
    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest(EXCLUDED_TARGET_SELECTOR)) return;

      const messageContainer = target.closest<HTMLElement>(
        "[data-message-id], [data-assistant-citation-source]",
      );
      if (!messageContainer || !viewport.contains(messageContainer)) return;

      const nativeSelection = window.getSelection();
      let selectedText = "";
      if (
        nativeSelection &&
        !nativeSelection.isCollapsed &&
        nativeSelection.rangeCount > 0 &&
        nativeSelection.getRangeAt(0).intersectsNode(viewport)
      ) {
        const markdownPayload = chatMarkdownClipboardPayload(nativeSelection);
        selectedText = (markdownPayload?.text ?? nativeSelection.toString()).trim();
      }

      let citationSelection: TimelineContextMenuState["citationSelection"] = null;
      if (threadRef && selectedText.length > 0) {
        const captured = captureAssistantTextSelection(viewport, nativeSelection);
        const citationMessageId = captured?.source.dataset.assistantCitationSource;
        if (
          captured &&
          citationMessageId &&
          captured.selector.text.length <= ASSISTANT_CITATION_MAX_TEXT_LENGTH
        ) {
          citationSelection = {
            citation: {
              version: 1,
              ...threadRef,
              messageId: MessageId.make(citationMessageId),
              ...captured.selector,
            },
            sourceAnchor: {
              source: captured.source,
              range: captured.range,
              viewport,
            },
          };
        }
      }

      const rowMessageId =
        messageContainer.dataset.messageId ??
        messageContainer.dataset.assistantCitationSource ??
        null;
      const messageText = rowMessageId ? resolveMessageText(rowMessageId) : null;

      event.preventDefault();
      setMenuState({
        x: event.clientX,
        y: event.clientY,
        selectedText,
        messageText,
        composerHasDraft: hasComposerDraft?.() ?? false,
        citationSelection,
      });
    };

    viewport.addEventListener("contextmenu", handleContextMenu);
    return () => viewport.removeEventListener("contextmenu", handleContextMenu);
  }, [hasComposerDraft, resolveMessageText, threadRef, viewport]);

  const menuAnchor = menuState
    ? { getBoundingClientRect: () => new DOMRect(menuState.x, menuState.y, 0, 0) }
    : undefined;

  const hasSelection = (menuState?.selectedText.length ?? 0) > 0;
  const copyText = hasSelection ? (menuState?.selectedText ?? "") : (menuState?.messageText ?? "");
  const showAskAside =
    sideChatAvailable !== false &&
    (onAskAsideWithCitation !== undefined || onAskAsideEmpty !== undefined);
  const askAsideNeedsEmptyComposer = true;
  const askAsideDisabled =
    (askAsideNeedsEmptyComposer && menuState?.composerHasDraft === true) ||
    Boolean(sideChatDisabledReason) ||
    (menuState?.citationSelection ? !onAskAsideWithCitation : !onAskAsideEmpty);

  const hasQuickCommands =
    onCompactContext !== undefined ||
    onFreshSession !== undefined ||
    onOpenModelPicker !== undefined;

  return (
    <Menu
      open={menuState !== null}
      onOpenChange={(open) => {
        if (!open) setMenuState(null);
      }}
    >
      <MenuPopup
        anchor={menuAnchor}
        align="start"
        side="bottom"
        sideOffset={0}
        aria-label="Message actions"
        data-testid="timeline-context-menu"
      >
        <MenuItem
          disabled={copyText.trim().length === 0}
          onClick={() => {
            if (copyText.trim().length === 0) return;
            void writeTextToClipboard(copyText, hasSelection ? "selection" : "message");
          }}
        >
          <CopyIcon />
          {hasSelection ? "Copy selection" : "Copy message"}
        </MenuItem>

        {showAskAside ? (
          <MenuItem
            disabled={askAsideDisabled}
            onClick={() => {
              if (!menuState || askAsideDisabled) return;
              if (menuState.citationSelection && onAskAsideWithCitation) {
                if (
                  onAskAsideWithCitation(
                    menuState.citationSelection.citation,
                    menuState.citationSelection.sourceAnchor,
                  )
                ) {
                  window.getSelection()?.removeAllRanges();
                }
                return;
              }
              onAskAsideEmpty?.();
            }}
          >
            <MessageCircleQuestionIcon />
            Ask aside
            <MenuShortcut>/btw</MenuShortcut>
          </MenuItem>
        ) : null}

        {hasQuickCommands ? <MenuSeparator /> : null}

        {onCompactContext !== undefined ? (
          <MenuItem
            disabled={Boolean(compactDisabled)}
            onClick={() => {
              if (!compactDisabled) onCompactContext();
            }}
          >
            <Minimize2Icon />
            Compact context
            <MenuShortcut>/compact</MenuShortcut>
          </MenuItem>
        ) : null}

        {onFreshSession !== undefined ? (
          <MenuItem
            disabled={Boolean(freshSessionDisabled)}
            onClick={() => {
              if (!freshSessionDisabled) onFreshSession();
            }}
          >
            <RotateCcwIcon />
            Fresh session
            <MenuShortcut>/clear</MenuShortcut>
          </MenuItem>
        ) : null}

        {onOpenModelPicker !== undefined ? (
          <MenuItem onClick={onOpenModelPicker}>
            <SlidersHorizontalIcon />
            Switch model
            <MenuShortcut>/model</MenuShortcut>
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
