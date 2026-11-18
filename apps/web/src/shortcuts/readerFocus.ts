const READER_SELECTOR = ".chat-markdown.markdown-reader";

/** The reading view that holds focus: focus inside it, or on the scrolled view around it. */
function focusedReader(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.isConnected || active === document.body) {
    return null;
  }
  const inside = active.closest<HTMLElement>(READER_SELECTOR);
  if (inside !== null) return inside;
  if (!active.matches('[data-slot="scroll-area-viewport"]')) return null;
  return active.querySelector<HTMLElement>(READER_SELECTOR);
}

export function isReaderFocused(): boolean {
  return focusedReader() !== null;
}

/** The reader a command palette action means: the focused one, else the only one on screen. */
export function activeReader(): HTMLElement | null {
  const focused = focusedReader();
  if (focused !== null) return focused;
  const shown = [...document.querySelectorAll<HTMLElement>(READER_SELECTOR)].filter(
    (reader) => reader.getClientRects().length > 0,
  );
  return shown.length === 1 ? (shown[0] ?? null) : null;
}
