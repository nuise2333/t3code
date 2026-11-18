# Files

## Files tabs

Each Files tab browses its own folder, and opening a file from it opens the file in
its own tab beside it. To open another Files tab, choose **Files** in the panel's
**+** menu or **New Files tab** in the command palette. `Cmd`/`Ctrl`-click or
middle-click a folder in the tree or in the breadcrumbs, or choose **Open in new
tab** from a folder's context menu, to open that folder in a new tab. Right-click
a Files tab and choose **Duplicate tab** to copy it. A closed Files tab reopens in
the folder it showed. If that folder was deleted or renamed, the tab offers to go
to the nearest folder that still exists.

## Icon view

Use the list and icon buttons beside the search field to switch any folder tab, including
a folder outside the project, between the tree and an icon view of that folder. Each tab
remembers its choice. Click a file to open it, and double-click or press Enter on a folder
to go into it. The up arrow button or `mod+ArrowUp` goes to the enclosing folder. Searching
shows matches in the tree until you clear the search. A folder with more than 5,000 items
shows as a list.

Images show a small preview when the connection can read files. HEIC, TIFF, video and
very large images show their file icon. Over a remote connection, previews skip images
above 3 MB and pause after about 64 MB in a tab; choose **Load previews** to continue.

## Manage files

Right-click an item in the Files panel to create, rename, duplicate, cut, copy, paste,
copy its path, or move it to the Trash. Right-click empty space below the tree to create
or paste at the top of the folder. `Shift`-click selects a range and `Cmd`/`Ctrl`-click
adds or removes a file; on a folder it opens the folder in a new Files tab, so use
`Shift`-click to add folders. A right-click on a selected item acts on the whole selection.
Clicking a file opens it only when it is the only item selected.

New File and New Folder create `untitled` or `untitled folder`, then let you type its
name. Copy and paste work between any folders of the same connection. Pasting a copy
next to an item with the same name keeps both, as `name 2`. Rename, move and create
never replace an existing item. After a rename or move, a toast offers **Undo**, and open
tabs follow the file to its new place.

Everything runs on the machine the connection points at, including a remote one, and
deleting moves items to that machine's Trash or Recycle Bin. When it has none, such as
a headless Linux server, T3 Code asks a second time before deleting permanently. Git
metadata, repositories and their worktrees, system folders, your home folder and T3
Code's own data can't be renamed, moved or deleted here; use a terminal for those.

The connection needs the **Write files** permission. Without it the panel only reads.
See [keyboard shortcuts](keybindings.md#files-panel) for the keys.
