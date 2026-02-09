# memable Manual

`memable` is a lightweight sticky-note application designed for visual organization of ideas during meetings and projects.

---

## 1. Basic Operations (Mouse)

- **Create Note**: **Double-click** on any empty space in the workspace.
- **Move Note**: **Drag** the header bar (grey area) at the top of the note.
- **Resize**: **Drag** the bottom-right corner of the note.
- **Delete Note**: Click the trash icon in the top-right corner.
- **Change Color**: Select a color from the palette in the header.
- **Edit Content**: Click inside the note to type text.
- **Add Images**: **Drag & Drop** image files into the workspace or **Paste (Cmd+V)**.

---

## 2. Keyboard Shortcuts

Notes are assigned unique IDs (1, 2... a, b...) in the top-left corner. Shortcuts behave differently depending on how you are running the app.

### In-App Shortcuts (When not typing)
- **[0-9], [a-z]**: **Copy** the content of the corresponding note to your clipboard.
- *Works in both Desktop App and Web Browser.*

### Global Shortcuts (Desktop App Only)
The Desktop App (Electron) supports shortcuts that work even when the app is in the background or minimized.
- **Cmd/Ctrl + [0-9]**: **Copy** the content of the corresponding note.
- **Cmd/Ctrl + Opt/Alt + [0-9]**: **Paste** (Copy to clipboard and try to insert) the content of the corresponding note.
- *Note: These features are not available when running in a standard Web Browser.*

---

## 3. Group Management (Sidebar)

Organize large numbers of notes using the "Groups" feature.

- **Switch Group**: Click a group name in the sidebar.
- **Create New Group**: Click the "+" button at the top of the sidebar.
- **Rename Group**: **Double-click** a group name in the sidebar.
- **Toggle Sidebar**: Click the menu icon in the sidebar header to collapse/expand.

---

## 4. Settings & Synchronization

Open the settings via the "Gear icon" in the navigation bar.

- **External Storage (Desktop App Only)**: 
    - You can specify a folder (like Dropbox or Google Drive) to sync your notes in real-time across multiple devices.
- **Export Data**:
    - Backup all current data as a JSON file.
- **Import Data**:
    - Restore data from a backup JSON file (this will overwrite current data).

---

## 5. About the Project

`memable` is built for minimal and fast organization of thoughts. It features a Material Design 3 based interface, supports Dark Mode, and includes Grid Snapping for neat alignment.
