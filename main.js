const { app, BrowserWindow, globalShortcut, clipboard, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let mainWindow;

// --- Persistence for Settings ---
const configPath = path.join(app.getPath('userData'), 'config.json');
let config = { externalPath: null };
try {
    if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
} catch (e) {
    console.error('Failed to load config', e);
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
    // グローバルショートカット登録
    globalShortcut.unregisterAll();
    const keys = [...Array(10).keys()].map(i => String(i));
    // keys = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
    // Note: mapping 1-9 to 1-9, and 10 to 0

    // Copy: CommandOrControl+1-9, 0
    keys.forEach(key => {
        const accelerator = `CommandOrControl+${key}`;
        const registered = globalShortcut.register(accelerator, () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('request-note', key);
            }
        });
        if (!registered) console.warn(`Failed to register global shortcut: ${accelerator}`);
    });
    // Paste: CommandOrControl+Alt+1-9, 0
    keys.forEach(key => {
        const accelerator = `CommandOrControl+Alt+${key}`;
        const registered = globalShortcut.register(accelerator, () => {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('paste-note', key);
            }
        });
        if (!registered) console.warn(`Failed to register global shortcut: ${accelerator}`);
    });
});

// --- IPC Handlers for Storage ---
ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled) return null;
    config.externalPath = result.filePaths[0];
    saveConfig();
    return config.externalPath;
});

ipcMain.handle('get-config', () => config);

ipcMain.handle('reset-config', () => {
    config = { externalPath: null };
    saveConfig();
    return true;
});

ipcMain.handle('save-external-data', async (event, filename, data) => {
    if (!config.externalPath) return false;
    try {
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