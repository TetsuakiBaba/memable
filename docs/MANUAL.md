# memable Manual

`memable` is a lightweight sticky-note app for macOS, designed for keeping snippets at hand and organizing ideas during meetings and projects.

---

## 1. Notes

- **Create**: double-click empty space on the canvas, or press `⌘N`.
- **Move**: drag the note header.
- **Resize**: drag the bottom-right corner.
- **Edit**: click the note text. Click outside the note or press `Esc` to return to the Markdown preview.
- **Markdown**: `#` headings, `-` / `1.` lists, `>` quotes, fenced code, `` `inline code` ``, `**bold**`, `[links](https://…)` and `[[Note Title]]` / `[[note-id]]` internal links.
- **Color**: pick a color in the header (narrow notes show a color menu). The last chosen color becomes the default for new notes.
- **Title / tags / source**: click the tag icon. Double-click the header title to rename quickly.
- **Copy**: click the copy icon, or press the note's key.
- **Delete**: click the trash icon. `⌘Z` restores it.
- **Images and text**: drag & drop images or text onto the canvas, or press `⌘V` while no note is being edited. Double-click an image note to enlarge it.
- **Grid snap** (`⌥⌘G`) aligns movement to a 25 pt grid; **Align Notes** (`⌥⌘L`) lays notes out in rows.
- **Zoom**: `⌘+`, `⌘-`, `⌘0`.

## 2. Keyboard Shortcuts

Each note in the current group gets a key shown in its header: `1`–`9`, `0`, then `a`–`z`.

| Shortcut | Action |
| --- | --- |
| `1`–`0`, `a`–`z` | Copy that note (while no text is being edited) |
| `⌘⌥` + key | **Global Quick Paste**: copy the note and paste it into the frontmost app |
| `⌘N` / `⇧⌘N` | New note / new group |
| `⇧⌘E` | Export LLM context |
| `⌥⌘K` | Switch the group between Canvas and Kanban |
| `⌘Z` | Undo delete |

Global Quick Paste works while memable runs in the background. Enable it in **Settings → Shortcuts** and allow memable in **System Settings → Privacy & Security → Accessibility** so it can send `⌘V`.

## 3. Groups (Sidebar)

- **Switch**: click a group.
- **Create**: `+` at the top of the sidebar.
- **Rename**: double-click a group (or right-click → Rename).
- **Reorder / nest**: drag a group above, below, or onto another group.
- **Delete**: trash icon on hover (or right-click). Child groups move up one level.
- The sidebar can be resized or hidden with the toolbar button.

## 4. Kanban

- Switch a group to Kanban with the toolbar segmented control or the icon on the group row.
- **ToDo** and **Done** are fixed; customize the steps in between with the slider icon (Kanban Steps).
- Double-click inside a column to add a card; drag cards by their header to another column.
- Drop a card outside the columns (or double-click there) to make a free note on the board; drag a free note onto a column to turn it back into a card.

## 5. LLM Context Export

- Click **Context** to export the current group as Markdown.
- Select specific notes with their checkbox icon (or `⌘`-click a note header) to export only those.
- Options: include child groups, include the Done column, include image data, and add an instruction for the receiving LLM.
- **Copy Markdown** or **Save .md…**.

## 6. Storage, Sync and Backup

Open **Settings** with `⌘,`.

- **Storage**: notes are saved automatically. Choose a sync folder (Dropbox, iCloud Drive …) to share notes between Macs; changes made on another Mac appear live. When the chosen folder already has notes you can load them or overwrite them.
- Each note is a Markdown file in `notes/`, images are in `assets/`, and `layout.json` stores positions separately from the content.
- **Export / Import JSON**: full backup of notes and groups (compatible with older versions). Importing replaces the current data.
- **Reset to Default**: deletes local notes and settings (files in a sync folder are kept).
