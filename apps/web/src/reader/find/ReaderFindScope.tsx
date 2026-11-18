import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { MarkdownFindContext } from "~/components/chat/markdownFindContext";
import { subscribePreviewAction, type PreviewAction } from "~/components/preview/previewActionBus";
import { isMacPlatform } from "~/lib/utils";
import { registerCommands } from "~/shortcuts/dispatcher";

import { ReaderFindBar } from "./ReaderFindBar";
import {
  createReaderFindSession,
  type ReaderFindSession,
  type ReaderFindState,
} from "./readerFindSession";

export interface ReaderFindHandle {
  readonly open: () => void;
}

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

/**
 * Find in a rendered document. Wraps the document's scroll area, answers the panel's find
 * command while it is visible, and keeps folded text mounted while the bar is open.
 */
export function ReaderFindScope(props: {
  readonly handleRef?: Ref<ReaderFindHandle>;
  readonly children: ReactNode;
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ReaderFindState>({ count: 0, active: 0 });
  const [focusRequestId, setFocusRequestId] = useState(0);
  const sessionRef = useRef<ReaderFindSession | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const open = () => {
    const focused = root?.ownerDocument.activeElement;
    if (!isOpen && focused instanceof HTMLElement) returnFocusRef.current = focused;
    setIsOpen(true);
    setFocusRequestId((id) => id + 1);
  };
  useImperativeHandle(props.handleRef, () => ({ open }));

  const close = () => {
    setIsOpen(false);
    const previous = returnFocusRef.current;
    returnFocusRef.current = null;
    const target = previous?.isConnected
      ? previous
      : root?.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    target?.focus({ preventScroll: true });
    // In an editable document the current match becomes the selection, ready to be typed over.
    const match = sessionRef.current?.activeRange();
    if (target?.isContentEditable && match && target.contains(match.commonAncestorContainer)) {
      const selection = target.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(match.cloneRange());
    }
  };

  const changeQuery = (next: string) => {
    setQuery(next);
    sessionRef.current?.setQuery(next);
  };

  const readQuery = useEffectEvent(() => query);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- indexes the rendered document and owns its CSS highlights while the bar is open
  useEffect(() => {
    if (!isOpen || root === null) return;
    const container = root.querySelector<HTMLElement>(VIEWPORT_SELECTOR) ?? root;
    const session = createReaderFindSession(container, setResult);
    sessionRef.current = session;
    session.setQuery(readQuery());
    return () => {
      session.dispose();
      sessionRef.current = null;
    };
  }, [isOpen, root]);

  const onPanelAction = useEffectEvent((action: PreviewAction) => {
    // Hidden panel tabs stay mounted; only the visible document answers.
    if (action === "find" && root?.getClientRects().length) open();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the panel find command, which fires while focus is anywhere in the right panel
  useEffect(() => subscribePreviewAction(onPanelAction), []);

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return true;
    }
    const mod = isMacPlatform(navigator.platform)
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!mod || event.altKey || event.key.toLowerCase() !== "g") return false;
    // Ahead of the chat's own Mod+Shift+G while the document has focus.
    event.preventDefault();
    event.stopPropagation();
    sessionRef.current?.step(event.shiftKey ? -1 : 1);
    return true;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers Escape and next/previous match keys in the capture phase while the bar is open
  useEffect(() => {
    if (!isOpen || root === null) return;
    return registerCommands(
      {},
      {
        capture: true,
        when: (event) => event.target instanceof Node && root.contains(event.target),
        onKeyDown,
      },
    );
  }, [isOpen, root]);

  return (
    <div ref={setRoot} data-reader-find-scope="" className="relative flex min-h-0 flex-1 flex-col">
      <MarkdownFindContext value={isOpen}>{props.children}</MarkdownFindContext>
      {isOpen ? (
        <ReaderFindBar
          query={query}
          count={result.count}
          active={result.active}
          focusRequestId={focusRequestId}
          onQueryChange={changeQuery}
          onStep={(delta) => sessionRef.current?.step(delta)}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
