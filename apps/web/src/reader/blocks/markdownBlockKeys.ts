import { applyInlineFormat, applyParagraphCommand, tableEdit } from "./markdownCommands";

type ParagraphCommand = Parameters<typeof applyParagraphCommand>[2];
type InlineFormat = Parameters<typeof applyInlineFormat>[2];
type TableOp = Parameters<typeof tableEdit>[2];

export type MarkdownCommand =
  | { readonly type: "paragraph"; readonly command: ParagraphCommand }
  | { readonly type: "inline"; readonly format: InlineFormat }
  | { readonly type: "table"; readonly op: TableOp };

export type MarkdownCommandResult =
  | { readonly text: string; readonly selection: { readonly start: number; readonly end: number } }
  | { readonly refused: string };

export function runMarkdownCommand(
  command: MarkdownCommand,
  text: string,
  context: { readonly start: number; readonly end: number; readonly isFirstBlock: boolean },
): MarkdownCommandResult {
  const selection = { start: context.start, end: context.end };
  switch (command.type) {
    case "paragraph":
      return applyParagraphCommand(text, selection, command.command, {
        isFirstBlock: context.isFirstBlock,
      });
    case "inline":
      return applyInlineFormat(text, selection, command.format);
    case "table":
      return tableEdit(text, context.start, command.op);
  }
}

const paragraph = (command: ParagraphCommand): MarkdownCommand => ({ type: "paragraph", command });
const inline = (format: InlineFormat): MarkdownCommand => ({ type: "inline", format });

/**
 * Typora's default shortcuts, as ElyMark binds them: `mod` is ⌘ on macOS and Ctrl elsewhere.
 * Each entry is [mod, shift, alt, key, command].
 */
const SHORTCUTS: readonly (readonly [boolean, boolean, boolean, string, MarkdownCommand])[] = [
  [true, false, false, "1", paragraph({ kind: "heading", level: 1 })],
  [true, false, false, "2", paragraph({ kind: "heading", level: 2 })],
  [true, false, false, "3", paragraph({ kind: "heading", level: 3 })],
  [true, false, false, "4", paragraph({ kind: "heading", level: 4 })],
  [true, false, false, "5", paragraph({ kind: "heading", level: 5 })],
  [true, false, false, "6", paragraph({ kind: "heading", level: 6 })],
  [true, false, false, "0", paragraph({ kind: "paragraph" })],
  [true, false, false, "=", paragraph("promote")],
  [true, false, false, "-", paragraph("demote")],
  [true, true, false, "q", paragraph("quote")],
  [true, true, false, "[", paragraph("orderedList")],
  [true, true, false, "]", paragraph("bulletList")],
  [true, true, false, "x", paragraph("taskList")],
  [true, true, false, "k", paragraph("codeFence")],
  [true, true, false, "m", paragraph("mathBlock")],
  [true, false, true, "t", paragraph("table")],
  [true, false, false, "b", inline("strong")],
  [true, false, false, "i", inline("emphasis")],
  [true, false, false, "u", inline("underline")],
  [true, false, false, "k", inline("link")],
  [true, true, false, "i", inline("image")],
  [true, true, false, "`", inline("code")],
  [true, true, false, "5", inline("strike")],
  [true, false, false, "\\", inline("clear")],
];

// Also app commands (sidebar, command palette, usage): the editor takes them only to format
// selected text, as the rich-text composer does.
const SHARED_CHORDS = new Set(["b", "k", "u"]);

export function markdownCommandForKey(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac: boolean,
  hasSelection: boolean,
): MarkdownCommand | null {
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  // Shifted digits and punctuation are read by their key position, as keyboard layouts differ.
  const key = event.code.startsWith("Digit")
    ? event.code.slice(5)
    : event.code === "Equal"
      ? "="
      : event.code === "Minus"
        ? "-"
        : event.code === "BracketLeft"
          ? "["
          : event.code === "BracketRight"
            ? "]"
            : event.code === "Backquote"
              ? "`"
              : event.code === "Backslash"
                ? "\\"
                : event.key.toLowerCase();
  const match = SHORTCUTS.find(
    ([, shift, alt, binding]) =>
      binding === key && shift === event.shiftKey && alt === event.altKey,
  );
  if (!match) return null;
  if (!hasSelection && !match[1] && !match[2] && SHARED_CHORDS.has(key)) return null;
  return match[4];
}

/** A shortcut's label for menus, in the platform's notation. */
export function markdownShortcutLabel(command: MarkdownCommand, mac: boolean): string | null {
  const entry = SHORTCUTS.find(
    ([, , , , candidate]) => JSON.stringify(candidate) === JSON.stringify(command),
  );
  if (!entry) return null;
  const [, shift, alt, key] = entry;
  const keyLabel = key.length === 1 ? key.toUpperCase() : key;
  return mac
    ? `${alt ? "⌥" : ""}${shift ? "⇧" : ""}⌘${keyLabel}`
    : `Ctrl+${alt ? "Alt+" : ""}${shift ? "Shift+" : ""}${keyLabel}`;
}
