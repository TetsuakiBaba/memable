const { app, BrowserWindow, globalShortcut, clipboard, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const { updateElectronApp } = require('update-electron-app');
updateElectronApp();

let mainWindow;

// --- Persistence for Settings ---
const configPath = path.join(app.getPath('userData'), 'config.json');
let config = { externalPath: null, globalShortcutsEnabled: false };
let watcher = null;
let lastInternalWriteTime = 0;

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
    if (watcher) {
        watcher.close();
        watcher = null;
    }

    if (config.externalPath && fs.existsSync(config.externalPath)) {
        console.log(`Watching for changes in: ${config.externalPath}`);
        watcher = fs.watch(config.externalPath, (eventType, filename) => {
            // 自分の書き込みから1秒以内なら無視
            if (Date.now() - lastInternalWriteTime < 1000) return;

            if (filename === 'notes.json' || filename === 'groups.json') {
                if (mainWindow) {
                    mainWindow.webContents.send('external-data-changed');
                }
            }
        });
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

app.whenReady().then(() => {
    mainWindow = createWindow();
    startWatching();
    registerShortcuts();
});

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