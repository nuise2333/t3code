import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { isMacPlatform } from "~/lib/utils";

import { type MarkdownCommand, markdownShortcutLabel } from "./markdownBlockKeys";

export interface MarkdownBlockMenuTarget {
  readonly x: number;
  readonly y: number;
  readonly kind: string;
  /** Opened from the block's source field rather than its rendering. */
  readonly editing: boolean;
  /** The rendered block it was opened on: where it began, and its source then. */
  readonly block?: { readonly from: number; readonly source: string };
}

const PARAGRAPH: readonly (readonly [string, MarkdownCommand] | null)[] = [
  ["Heading 1", { type: "paragraph", command: { kind: "heading", level: 1 } }],
  ["Heading 2", { type: "paragraph", command: { kind: "heading", level: 2 } }],
  ["Heading 3", { type: "paragraph", command: { kind: "heading", level: 3 } }],
  ["Heading 4", { type: "paragraph", command: { kind: "heading", level: 4 } }],
  ["Heading 5", { type: "paragraph", command: { kind: "heading", level: 5 } }],
  ["Heading 6", { type: "paragraph", command: { kind: "heading", level: 6 } }],
  ["Paragraph", { type: "paragraph", command: { kind: "paragraph" } }],
  ["Promote heading", { type: "paragraph", command: "promote" }],
  ["Demote heading", { type: "paragraph", command: "demote" }],
  null,
  ["Quote", { type: "paragraph", command: "quote" }],
  ["Ordered list", { type: "paragraph", command: "orderedList" }],
  ["Bullet list", { type: "paragraph", command: "bulletList" }],
  ["Task list", { type: "paragraph", command: "taskList" }],
  null,
  ["Table", { type: "paragraph", command: "table" }],
  ["Code block", { type: "paragraph", command: "codeFence" }],
  ["Math block", { type: "paragraph", command: "mathBlock" }],
  ["Horizontal rule", { type: "paragraph", command: "rule" }],
  ["Table of contents", { type: "paragraph", command: "toc" }],
  ["Front matter", { type: "paragraph", command: "frontMatter" }],
  null,
  ["Insert paragraph before", { type: "paragraph", command: "paragraphBefore" }],
  ["Insert paragraph after", { type: "paragraph", command: "paragraphAfter" }],
];

const FORMAT: readonly (readonly [string, MarkdownCommand])[] = [
  ["Strong", { type: "inline", format: "strong" }],
  ["Emphasis", { type: "inline", format: "emphasis" }],
  ["Underline", { type: "inline", format: "underline" }],
  ["Code", { type: "inline", format: "code" }],
  ["Strikethrough", { type: "inline", format: "strike" }],
  ["Hyperlink", { type: "inline", format: "link" }],
  ["Image", { type: "inline", format: "image" }],
  ["Clear format", { type: "inline", format: "clear" }],
];

const TABLE: readonly (readonly [string, MarkdownCommand] | null)[] = [
  ["Insert row above", { type: "table", op: "rowAbove" }],
  ["Insert row below", { type: "table", op: "rowBelow" }],
  ["Insert column left", { type: "table", op: "columnLeft" }],
  ["Insert column right", { type: "table", op: "columnRight" }],
  null,
  ["Delete row", { type: "table", op: "deleteRow" }],
  ["Delete column", { type: "table", op: "deleteColumn" }],
  null,
  ["Align left", { type: "table", op: "alignLeft" }],
  ["Align center", { type: "table", op: "alignCenter" }],
  ["Align right", { type: "table", op: "alignRight" }],
];

/**
 * The menu at a right-click on a Markdown block, laid out as Typora's: clipboard first, then
 * what applies where the pointer is. A rendered block offers its source; an open one, every
 * paragraph and format command, plus table edits inside a table.
 */
export function MarkdownBlockMenu(props: {
  readonly target: MarkdownBlockMenuTarget | null;
  readonly onClose: () => void;
  readonly onCommand: (command: MarkdownCommand) => void;
  readonly onClipboard: (action: "cut" | "copy" | "paste") => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const { target } = props;
  const mac = isMacPlatform(navigator.platform);
  const anchor = target
    ? { getBoundingClientRect: () => new DOMRect(target.x, target.y, 0, 0) }
    : undefined;
  const run = (command: MarkdownCommand) => {
    props.onCommand(command);
  };
  const items = (list: readonly (readonly [string, MarkdownCommand] | null)[]) =>
    list.map((item, position) =>
      item === null ? (
        // oxlint-disable-next-line react/no-array-index-key -- Separators keep their place in a fixed list.
        <MenuSeparator key={`separator-${position}`} />
      ) : (
        <MenuItem key={item[0]} onClick={() => run(item[1])}>
          {item[0]}
          {markdownShortcutLabel(item[1], mac) ? (
            <MenuShortcut>{markdownShortcutLabel(item[1], mac)}</MenuShortcut>
          ) : null}
        </MenuItem>
      ),
    );
  return (
    <>
      <Menu
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <MenuPopup
          anchor={anchor}
          align="start"
          side="bottom"
          sideOffset={0}
          aria-label="Block actions"
        >
          {target?.editing ? (
            <>
              <MenuItem onClick={() => props.onClipboard("cut")}>Cut</MenuItem>
              <MenuItem onClick={() => props.onClipboard("copy")}>Copy</MenuItem>
              <MenuItem onClick={() => props.onClipboard("paste")}>Paste</MenuItem>
              <MenuSeparator />
              {target.kind === "table" ? (
                <MenuSub>
                  <MenuSubTrigger>Table</MenuSubTrigger>
                  <MenuSubPopup>{items(TABLE)}</MenuSubPopup>
                </MenuSub>
              ) : null}
              <MenuSub>
                <MenuSubTrigger>Paragraph</MenuSubTrigger>
                <MenuSubPopup>{items(PARAGRAPH)}</MenuSubPopup>
              </MenuSub>
              <MenuSub>
                <MenuSubTrigger>Format</MenuSubTrigger>
                <MenuSubPopup>{items(FORMAT)}</MenuSubPopup>
              </MenuSub>
            </>
          ) : (
            <>
              <MenuItem onClick={props.onEdit}>Edit block</MenuItem>
              <MenuItem onClick={() => props.onClipboard("copy")}>Copy as Markdown</MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={props.onDelete}>
                Delete block
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
    </>
  );
}
