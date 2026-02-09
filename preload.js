const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    onPasteNote: (callback) => ipcRenderer.on('paste-note', (event, key) => callback(key)),
    onRequestNote: (callback) => ipcRenderer.on('request-note', (event, key) => callback(key)),
    sendDeliverNote: (key, type, content) => ipcRenderer.send('deliver-note', key, type, content),
    onCopyNote: (callback) => ipcRenderer.on('copy-note', (event, key) => callback(key)),

    // New Storage APIs
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    getStorageConfig: () => ipcRenderer.invoke('get-config'),
    saveExternalData: (filename, data) => ipcRenderer.invoke('save-external-data', filename, data),
    loadExternalData: (filename) => ipcRenderer.invoke('load-external-data', filename),
    exportToJson: (data) => ipcRenderer.invoke('export-to-json', data),
    resetConfig: () => ipcRenderer.invoke('reset-config'),
    triggerSystemPaste: () => ipcRenderer.send('trigger-system-paste')
});