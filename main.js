const { app, BrowserWindow, globalShortcut, clipboard, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const { updateElectronApp } = require('update-electron-app');
updateElectronApp();

let mainWindow;

// Prevent multiple app processes from sharing the same userData/IndexedDB files.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
}

// --- Persistence for Settings ---
const configPath = path.join(app.getPath('userData'), 'config.json');
let config = { externalPath: null, globalShortcutsEnabled: false };
let watchers = [];
let lastInternalWriteTime = 0;
let externalChangeTimer = null;

const NOTE_FILE_VERSION = 2;

function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function writeTextAtomic(filePath, content) {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
}

function writeJsonAtomic(filePath, value) {
    writeTextAtomic(filePath, JSON.stringify(value, null, 2));
}

function noteFileName(id) {
    return `${String(id).replace(/[^a-zA-Z0-9._-]/g, '_')}.md`;
}

function encodeFrontmatterValue(value) {
    return JSON.stringify(value === undefined ? null : value);
}

function serializeNoteMarkdown(note, assetPath = null) {
    const fields = {
        id: note.id,
        title: note.title || '',
        group: note.groupId,
        type: note.type || 'text',
        status: note.kanbanColumnId || 'todo',
        order: Number.isFinite(note.kanbanOrder) ? note.kanbanOrder : 0,
        tags: Array.isArray(note.tags) ? note.tags : [],
        created_at: note.createdAt || null,
        updated_at: note.updatedAt || null,
        source: note.source || { type: 'manual', url: null },
        asset: assetPath
    };
    const frontmatter = Object.entries(fields)
        .map(([key, value]) => `${key}: ${encodeFrontmatterValue(value)}`)
        .join('\n');
    const body = note.type === 'image'
        ? (assetPath ? `![${note.title || 'image'}](${assetPath})` : '')
        : (note.content || '');
    return `---\n${frontmatter}\n---\n\n${body}\n`;
}

function parseNoteMarkdown(markdown) {
    const match = String(markdown).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return null;
    const metadata = {};
    match[1].split(/\r?\n/).forEach(line => {
        const separator = line.indexOf(':');
        if (separator < 0) return;
        const key = line.slice(0, separator).trim();
        const rawValue = line.slice(separator + 1).trim();
        try {
            metadata[key] = JSON.parse(rawValue);
        } catch (_) {
            metadata[key] = rawValue;
        }
    });
    return { metadata, body: match[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '') };
}

function dataUrlToAsset(content, assetsDir, id) {
    const match = typeof content === 'string' && content.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) return null;
    const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    const extension = extensions[match[1]] || 'bin';
    const filename = `${String(id).replace(/[^a-zA-Z0-9._-]/g, '_')}.${extension}`;
    fs.writeFileSync(path.join(assetsDir, filename), Buffer.from(match[2], 'base64'));
    return `../assets/${filename}`;
}

function assetToDataUrl(notesDir, relativeAssetPath) {
    if (!relativeAssetPath || typeof relativeAssetPath !== 'string') return '';
    const resolved = path.resolve(notesDir, relativeAssetPath);
    const assetsRoot = path.resolve(path.dirname(notesDir), 'assets');
    const relativeToAssets = path.relative(assetsRoot, resolved);
    if (relativeToAssets.startsWith('..') || path.isAbsolute(relativeToAssets)) return '';
    const extension = path.extname(resolved).toLowerCase();
    const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    if (!fs.existsSync(resolved) || !mimeTypes[extension]) return '';
    return `data:${mimeTypes[extension]};base64,${fs.readFileSync(resolved).toString('base64')}`;
}

function saveExternalSnapshot(snapshot) {
    if (!config.externalPath) return false;
    const notesDir = path.join(config.externalPath, 'notes');
    const assetsDir = path.join(config.externalPath, 'assets');
    ensureDirectory(notesDir);
    ensureDirectory(assetsDir);

    const notes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
    const previousIndexPath = path.join(config.externalPath, 'index.json');
    let previousFiles = [];
    try {
        previousFiles = JSON.parse(fs.readFileSync(previousIndexPath, 'utf8')).notes || [];
    } catch (_) { /* first sync */ }

    const nextFiles = [];
    const layouts = {};
    notes.forEach(note => {
        const filename = noteFileName(note.id);
        const assetPath = note.type === 'image' ? dataUrlToAsset(note.content, assetsDir, note.id) : null;
        writeTextAtomic(path.join(notesDir, filename), serializeNoteMarkdown(note, assetPath));
        nextFiles.push(filename);
        layouts[note.id] = note.presentation || {};
    });

    const nextFileSet = new Set(nextFiles);
    previousFiles.filter(filename => !nextFileSet.has(filename)).forEach(filename => {
        const stalePath = path.join(notesDir, path.basename(filename));
        if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
    });

    writeJsonAtomic(path.join(config.externalPath, 'groups.json'), snapshot.groups || []);
    writeJsonAtomic(path.join(config.externalPath, 'layout.json'), layouts);
    writeJsonAtomic(previousIndexPath, {
        source: 'memable',
        version: NOTE_FILE_VERSION,
        updatedAt: new Date().toISOString(),
        notes: nextFiles
    });
    return true;
}

function loadExternalSnapshot() {
    if (!config.externalPath) return null;
    const notesDir = path.join(config.externalPath, 'notes');
    if (!fs.existsSync(notesDir)) return null;
    let groups = [];
    let layouts = {};
    try { groups = JSON.parse(fs.readFileSync(path.join(config.externalPath, 'groups.json'), 'utf8')); } catch (_) { /* optional */ }
    try { layouts = JSON.parse(fs.readFileSync(path.join(config.externalPath, 'layout.json'), 'utf8')); } catch (_) { /* optional */ }

    const notes = fs.readdirSync(notesDir)
        .filter(filename => filename.endsWith('.md'))
        .map(filename => ({ filename, parsed: parseNoteMarkdown(fs.readFileSync(path.join(notesDir, filename), 'utf8')) }))
        .filter(item => item.parsed)
        .map(({ filename, parsed }) => ({ filename, ...parsed }))
        .filter(Boolean)
        .map(({ filename, metadata, body }) => {
            const id = metadata.id || path.basename(filename, '.md');
            const type = metadata.type === 'image' ? 'image' : 'text';
            return {
                id,
                title: metadata.title || '',
                groupId: metadata.group,
                type,
                content: type === 'image' ? assetToDataUrl(notesDir, metadata.asset) : body,
                kanbanColumnId: metadata.status,
                kanbanOrder: metadata.order,
                tags: metadata.tags,
                createdAt: metadata.created_at,
                updatedAt: metadata.updated_at,
                source: metadata.source,
                presentation: layouts[id] || {}
            };
        });
    return { notes, groups };
}

try {
    if (fs.existsSync(configPath)) {
        config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    }
} catch (e) {
    console.error('Failed to load config', e);
}

function registerShortcuts() {
    globalShortcut.unregisterAll();
    if (!config.globalShortcutsEnabled) return;

    // Keys cover 0-9 and a-z
    const keys = [
        ...[...Array(10).keys()].map(i => String((i + 1) % 10)),
        ...[...Array(26).keys()].map(i => String.fromCharCode(97 + i))
    ];

    // Global shortcut for "Paste" only (Copy content to clipboard and trigger system paste)
    // Shortcut: CommandOrControl+Alt+${key} (for macOS: Command+Option+${key})
    keys.forEach(key => {
        const accelerator = `CommandOrControl+Alt+${key}`;
        globalShortcut.register(accelerator, () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('paste-note', key);
            }
        });
    });
}

function startWatching() {
    watchers.forEach(item => item.close());
    watchers = [];

    if (config.externalPath && fs.existsSync(config.externalPath)) {
        console.log(`Watching for changes in: ${config.externalPath}`);
        const notifyChange = (eventType, filename) => {
            // 自分の書き込みから1秒以内なら無視
            if (Date.now() - lastInternalWriteTime < 1000) return;
            const relevant = !filename || filename === 'notes.json' || filename === 'groups.json'
                || filename === 'layout.json' || filename === 'index.json' || String(filename).endsWith('.md');
            if (!relevant) return;
            clearTimeout(externalChangeTimer);
            externalChangeTimer = setTimeout(() => {
                if (mainWindow) mainWindow.webContents.send('external-data-changed');
            }, 250);
        };
        watchers.push(fs.watch(config.externalPath, notifyChange));
        const notesDir = path.join(config.externalPath, 'notes');
        if (fs.existsSync(notesDir)) watchers.push(fs.watch(notesDir, notifyChange));
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Failed to save config', e);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.on('closed', () => mainWindow = null);
    return mainWindow;
}

if (gotSingleInstanceLock) {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(() => {
        mainWindow = createWindow();
        startWatching();
        registerShortcuts();
    });
}

// --- IPC Handlers for Storage ---
ipcMain.handle('toggle-shortcuts', async (event, enabled) => {
    config.globalShortcutsEnabled = enabled;
    saveConfig();
    registerShortcuts();
    return config.globalShortcutsEnabled;
});

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled) return null;
    config.externalPath = result.filePaths[0];
    saveConfig();
    startWatching();
    return config.externalPath;
});

ipcMain.handle('get-config', () => config);

ipcMain.handle('reset-config', () => {
    config = { externalPath: null };
    saveConfig();
    startWatching();
    return true;
});

ipcMain.handle('save-external-data', async (event, filename, data) => {
    if (!config.externalPath) return false;
    try {
        lastInternalWriteTime = Date.now();
        const filePath = path.join(config.externalPath, filename);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        console.error(`Failed to save ${filename}`, e);
        return false;
    }
});

ipcMain.handle('load-external-data', async (event, filename) => {
    if (!config.externalPath) return null;
    try {
        const filePath = path.join(config.externalPath, filename);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {
        console.error(`Failed to load ${filename}`, e);
    }
    return null;
});

ipcMain.handle('save-external-snapshot', async (event, snapshot) => {
    if (!config.externalPath) return false;
    try {
        lastInternalWriteTime = Date.now();
        const notesDirectoryAlreadyExists = fs.existsSync(path.join(config.externalPath, 'notes'));
        const saved = saveExternalSnapshot(snapshot || {});
        if (!notesDirectoryAlreadyExists) startWatching();
        return saved;
    } catch (e) {
        console.error('Failed to save external snapshot', e);
        return false;
    }
});

ipcMain.handle('load-external-snapshot', async () => {
    try {
        return loadExternalSnapshot();
    } catch (e) {
        console.error('Failed to load external snapshot', e);
        return null;
    }
});

ipcMain.handle('export-to-json', async (event, data) => {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: 'memable_export.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (filePath) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    }
    return false;
});

ipcMain.on('deliver-note', (event, key, type, content) => {
    if (type === 'text') {
        clipboard.writeText(content);
    } else if (type === 'image') {
        const img = nativeImage.createFromDataURL(content);
        clipboard.writeImage(img);
    }
});

// システムレベルのペーストを実行（macOS用 AppleScript）
ipcMain.on('trigger-system-paste', () => {
    if (process.platform === 'darwin') {
        // macOS: System Events を使って Cmd+V をシミュレート
        const script = 'tell application "System Events" to keystroke "v" using {command down}';
        exec(`osascript -e '${script}'`, (error) => {
            if (error) console.error('Failed to execute paste script:', error);
        });
    } else if (process.platform === 'win32') {
        // Windows: PowerShell を使って Ctrl+V をシミュレート（参考用）
        const script = '$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys("^v")';
        exec(`powershell -Command "${script}"`, (error) => {
            if (error) console.error('Failed to execute paste script:', error);
        });
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
