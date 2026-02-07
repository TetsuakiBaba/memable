# memable
![App Icon](./icons/icon-192.png)

A temporary copy-and-paste sticky-note web application (PWA-enabled) with native app support via Electron.

## Features
- Create, edit, delete, and copy text notes
- Save image notes via clipboard paste or drag-and-drop
- Move and resize notes freely like sticky notes
- **Grid Snap**: Toggle grid snapping for organized note placement
- **Visual Hints**: Canvas hint "Double-click to create a note" on empty workspace
- **Shortcut Badges**: Display shortcut keys (1, 2, a, b...) on note headers
- **Copy Feedback**: Copy button changes to a checkmark icon for 3 seconds upon success
- Toggle dark/light mode (Bootstrap 5 data-bs-theme)
- PWA support with Web App Manifest for home screen installation
- Double-click image notes to view them in an enlarged modal
- **Keyboard Shortcuts**: instantly copy a note by its key ID
  - Browser: Works when the window is focused (Key only)
  - Native App: Works even in background via global shortcuts (Cmd/Ctrl + Key)

## Installation
1. Clone this repository or download the ZIP
2. Ensure `icons/`, `index.html`, `style.css`, `script.js`, `manifest.json`, `LICENSE`, and `README.md` are in the same directory
3. Install dependencies and serve:
   ```bash
   npm install
   npm start
   ```
   Or serve the directory with any HTTP server (e.g., `python3 -m http.server`) and open `http://localhost:8000`

> **Note:** PWA features require HTTPS or `localhost` to be enabled

## Usage
1. **Double-click** on the empty canvas to create a new text note
2. Paste images from the clipboard or drag-and-drop them into the workspace to create image notes
3. Double-click an image note to view it in an enlarged modal
4. Drag the note header to reposition, or use the bottom-right corner to resize
5. Click the copy icon or press the corresponding **Key ID** to copy note content
6. Click the trash icon on a note to delete it, or use the **Clear All** button to remove all notes
7. Toggle **Grid Snap** in the navbar to align notes to a 25px grid
8. Toggle dark/light mode using the switch in the navbar
9. Notes and their positions are stored in IndexedDB (`memable-db`) and persist after reloads

## Desktop Application via Electron

For environment setup with Electron Forge, see: https://www.electronforge.io/import-existing-project

Prerequisites:
- Node.js (v14+)

Steps:
```bash
# 1. Install dependencies
npm install

# 2. Run in development mode
npm start

# 3. Create a packaged app (out/package)
npm run package

# 4. Make distributables (Zip, DMG) in out/make
npm run make
```

Icons:
- The app icon is set via `icons/icon.icns` (specified in `forge.config.js`).

Global shortcuts:
- Windows/Linux: Press `Ctrl + <key ID>` to copy the corresponding note to the clipboard.
- macOS: Press `⌘ + <key ID>` to copy the corresponding note to the clipboard.

## License
This project is licensed under the MIT License. See `LICENSE` for details.
