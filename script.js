// state
let notes = [];
let groups = [];
let currentGroupId = localStorage.getItem('currentGroupId') || 'default';
let storageMode = 'indexeddb'; // 'indexeddb' or 'external'
let externalPath = null;
const storageKey = 'memableNotes';

// --- Undo Logic ---
let lastDeletedNote = null;

const workspace = document.getElementById('workspace');
const groupList = document.getElementById('group-list');
const addGroupButton = document.getElementById('add-group-button');

// --- Storage Switch Logic ---
async function initStorageMode() {
    if (window.electronAPI) {
        const config = await window.electronAPI.getStorageConfig();
        if (config && config.externalPath) {
            storageMode = 'external';
            externalPath = config.externalPath;
            updateSettingsUI();
            return;
        }
    }
    storageMode = 'indexeddb';
    updateSettingsUI();
}

function updateSettingsUI() {
    const pathDisplay = document.getElementById('storage-path-display');
    const statusBox = document.getElementById('storage-status');
    if (pathDisplay) {
        pathDisplay.value = externalPath || 'IndexedDB (Standard)';
    }
    if (statusBox) {
        if (storageMode === 'external') {
            statusBox.classList.remove('d-none');
            statusBox.textContent = `External sync active at ${externalPath}`;
        } else {
            statusBox.classList.add('d-none');
        }
    }
}

// データ保存時に外部ストレージが有効なら書き込む
async function syncToExternalIfNeeded() {
    if (storageMode === 'external' && window.electronAPI) {
        // すべてのメモとグループを取得して保存
        const allNotes = await getAllNotesDB_Full();
        const allGroups = await getAllGroupsDB();
        await window.electronAPI.saveExternalData('notes.json', allNotes);
        await window.electronAPI.saveExternalData('groups.json', allGroups);
    }
}

// 起動時に外部ストレージからデータを読み込む
async function syncFromExternalIfNeeded() {
    if (storageMode === 'external' && window.electronAPI) {
        const extNotes = await window.electronAPI.loadExternalData('notes.json');
        const extGroups = await window.electronAPI.loadExternalData('groups.json');

        if (extNotes || extGroups) {
            const db = await dbPromise;
            const tx = db.transaction(['notes', 'groups'], 'readwrite');
            
            if (extNotes) {
                const noteStore = tx.objectStore('notes');
                noteStore.clear();
                for (const note of extNotes) {
                    noteStore.put(note);
                }
            }
            
            if (extGroups) {
                const groupStore = tx.objectStore('groups');
                groupStore.clear();
                for (const group of extGroups) {
                    groupStore.put(group);
                }
            }

            return new Promise((resolve) => {
                tx.oncomplete = () => {
                    console.log('Synced from external storage');
                    resolve();
                };
            });
        }
    }
}

// 全ノート取得用（IndexedDBから）
async function getAllNotesDB_Full() {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readonly');
    const store = tx.objectStore('notes');
    return new Promise((res, rej) => {
        const r = store.getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}


// load grid snap state from localStorage
const savedGridSnap = localStorage.getItem('gridSnapEnabled');
let isGridSnap = savedGridSnap === 'true';
const gridToggle = document.getElementById('grid-toggle');
const clearAllButton = document.getElementById('clear-all-button');

// z-index 管理用
let maxZIndex = 100;

// ボタン表示更新関数
function updateGridToggleButton() {
    if (gridToggle) {
        gridToggle.innerHTML = `<span class="material-symbols-outlined">grid_4x4</span> <span class="btn-text">Grid: ${isGridSnap ? 'ON' : 'OFF'}</span>`;
    }
}
// initialize button state
updateGridToggleButton();

if (gridToggle) {
    gridToggle.addEventListener('click', () => {
        isGridSnap = !isGridSnap;
        // save to localStorage
        localStorage.setItem('gridSnapEnabled', isGridSnap);
        updateGridToggleButton();
    });
}
function snap(val) {
    return isGridSnap ? Math.round(val / 25) * 25 : val;
}

// カラーオプション (M3-like Container Colors)
const COLORS = [
    { name: 'yellow', hex: '#F9E264' },
    { name: 'blue', hex: '#D0E4FF' },
    { name: 'green', hex: '#C4EBC1' },
    { name: 'red', hex: '#FFDAD6' },
    { name: 'gray', hex: '#E6E1E5' },
    { name: 'pink', hex: '#FFD8E4' }
];
// デフォルトカラー読み込み
let defaultNoteColor = localStorage.getItem('defaultNoteColor') || 'yellow';

// IndexedDB 初期化
const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('memable-db', 2);
    req.onupgradeneeded = (event) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) {
            db.createObjectStore('notes', { keyPath: 'id' });
        }
        if (event.oldVersion < 2) {
            // Version 2: Add groups store and groupId to notes
            if (!db.objectStoreNames.contains('groups')) {
                db.createObjectStore('groups', { keyPath: 'id' });
            }
            const noteStore = req.transaction.objectStore('notes');
            if (!noteStore.indexNames.contains('groupId')) {
                noteStore.createIndex('groupId', 'groupId', { unique: false });
            }
        }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

async function getAllNotesDB(groupId) {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readonly');
    const store = tx.objectStore('notes');
    const index = store.index('groupId');
    return new Promise((res, rej) => {
        const r = index.getAll(groupId);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

// 既存のメモを移行するための関数（全件取得）
async function migrateLegacyNotes() {
    const db = await dbPromise;
    const tx = db.transaction(['notes', 'groups'], 'readwrite');
    const noteStore = tx.objectStore('notes');
    const groupStore = tx.objectStore('groups');

    // デフォルトグループの作成
    const defaultGroup = { id: 'default', name: 'Default' };
    const groupReq = groupStore.get('default');

    groupReq.onsuccess = () => {
        if (!groupReq.result) {
            groupStore.add(defaultGroup);
        }
    };

    const notesReq = noteStore.getAll();
    notesReq.onsuccess = () => {
        const allNotes = notesReq.result;
        allNotes.forEach(note => {
            if (!note.groupId) {
                note.groupId = 'default';
                noteStore.put(note);
            }
        });
    };
}

async function getAllGroupsDB() {
    const db = await dbPromise;
    const tx = db.transaction('groups', 'readonly');
    const store = tx.objectStore('groups');
    return new Promise((res, rej) => {
        const r = store.getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}

async function addGroupDB(group) {
    const db = await dbPromise;
    const tx = db.transaction('groups', 'readwrite');
    tx.objectStore('groups').add(group);
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}

async function updateGroupDB(group) {
    const db = await dbPromise;
    const tx = db.transaction('groups', 'readwrite');
    tx.objectStore('groups').put(group);
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}

async function deleteGroupDB(id) {
    const db = await dbPromise;
    const tx = db.transaction(['notes', 'groups'], 'readwrite');
    const noteStore = tx.objectStore('notes');
    const groupStore = tx.objectStore('groups');

    // そのグループのノートをすべて削除
    const index = noteStore.index('groupId');
    const cursorReq = index.openCursor(id);
    cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
            cursor.delete();
            cursor.continue();
        }
    };

    groupStore.delete(id);
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}

async function addNoteDB(note) {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').add(note);
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}
async function updateNoteDB(note) {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put(note);
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}
async function deleteNoteDB(id) {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').delete(id);
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}
async function clearAllNotesDB(groupId) {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');
    const index = store.index('groupId');
    const cursorReq = index.openCursor(groupId);
    cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
            cursor.delete();
            cursor.continue();
        }
    };
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}

// 数値をキーIDに変換 (1-9, 0, a-z)
function numToKeyId(num) {
    if (num <= 9) return String(num);
    if (num === 10) return '0';
    const code = 'a'.charCodeAt(0) + (num - 11);
    return String.fromCharCode(code);
}

// 各メモにキーIDを割り当て、DBとDOMを更新
async function assignNoteIds() {
    for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        const keyId = numToKeyId(i + 1);
        note.keyId = keyId;
        await updateNoteDB(note);
        const noteEl = workspace.querySelector(`[data-id='${note.id}']`);
        if (noteEl) {
            const idEl = noteEl.querySelector('.note-id');
            if (idEl) {
                idEl.textContent = `${keyId}`;
                idEl.title = `ショートカットキー: ${keyId}`;
            }
        }
    }
}

// --- Export / Import ---
async function handleExport() {
    const allNotes = await getAllNotesDB_Full();
    const allGroups = await getAllGroupsDB();
    const data = { notes: allNotes, groups: allGroups, version: '1.2.0', source: 'memable' };

    if (window.electronAPI) {
        const success = await window.electronAPI.exportToJson(data);
        if (success) showToast('Export successful!');
    } else {
        // Browser download
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `memable_backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }
}

async function handleImport(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.notes || !data.groups) throw new Error('Invalid data format');

            if (confirm('Importing will clear current data. Continue?')) {
                const db = await dbPromise;
                const tx = db.transaction(['notes', 'groups'], 'readwrite');
                tx.objectStore('notes').clear();
                tx.objectStore('groups').clear();

                for (const g of data.groups) tx.objectStore('groups').add(g);
                for (const n of data.notes) tx.objectStore('notes').add(n);

                tx.oncomplete = () => {
                    alert('Import successful! Reloading...');
                    location.reload();
                };
                tx.onerror = () => alert('Import failed: ' + tx.error);
            }
        } catch (err) {
            alert('Failed to import: ' + err.message);
        }
    };
    reader.readAsText(file);
}

async function handleResetApp() {
    if (confirm('Are you sure you want to reset EVERYTHING? This will delete all notes, groups, and settings. This cannot be undone.')) {
        // 1. Clear IndexedDB
        const db = await dbPromise;
        const tx = db.transaction(['notes', 'groups'], 'readwrite');
        tx.objectStore('notes').clear();
        tx.objectStore('groups').clear();

        tx.oncomplete = async () => {
            // 2. Clear localStorage
            localStorage.clear();

            // 3. Reset Electron Config
            if (window.electronAPI && window.electronAPI.resetConfig) {
                await window.electronAPI.resetConfig();
            }

            alert('App has been reset. Reloading...');
            location.reload();
        };
    }
}

function showToast(message) {
    // Simple feedback logic (can be extended)
    console.log(message);
    const feedback = document.createElement('div');
    feedback.className = 'copy-feedback visible';
    feedback.textContent = message;
    document.body.appendChild(feedback);
    setTimeout(() => {
        feedback.classList.remove('visible');
        setTimeout(() => feedback.remove(), 300);
    }, 2000);
}

// --- Group Management Functions ---

let groupModalInstance = null;

/**
 * グループ名入力用のモーダルを表示する
 * @param {string} title モダールのタイトル
 * @param {string} defaultValue デフォルトの入力値
 * @returns {Promise<string|null>} 保存された名前、またはキャンセル時は null
 */
function showGroupModal(title, defaultValue = '') {
    const modalEl = document.getElementById('groupModal');
    const titleEl = document.getElementById('groupModalTitle');
    const inputEl = document.getElementById('group-name-input');
    const saveBtn = document.getElementById('group-modal-save');

    if (!groupModalInstance) {
        groupModalInstance = new bootstrap.Modal(modalEl);
    }

    titleEl.textContent = title;
    inputEl.value = defaultValue;

    return new Promise((resolve) => {
        const handleSave = () => {
            const name = inputEl.value.trim();
            if (name) {
                cleanup();
                groupModalInstance.hide();
                resolve(name);
            }
        };

        const handleCancel = () => {
            cleanup();
            resolve(null);
        };

        const handleKeydown = (e) => {
            if (e.key === 'Enter') {
                handleSave();
            }
        };

        const cleanup = () => {
            saveBtn.removeEventListener('click', handleSave);
            modalEl.removeEventListener('hidden.bs.modal', handleCancel);
            inputEl.removeEventListener('keydown', handleKeydown);
        };

        saveBtn.addEventListener('click', handleSave);
        modalEl.addEventListener('hidden.bs.modal', handleCancel);
        inputEl.addEventListener('keydown', handleKeydown);

        groupModalInstance.show();

        modalEl.addEventListener('shown.bs.modal', () => {
            inputEl.focus();
            inputEl.select();
        }, { once: true });
    });
}

async function loadGroups() {
    groups = await getAllGroupsDB();
    if (groups.length === 0) {
        const defaultGroup = { id: 'default', name: 'Default' };
        await addGroupDB(defaultGroup);
        groups = [defaultGroup];
    }
    renderGroups();
}

function renderGroups() {
    groupList.innerHTML = '';
    groups.forEach(group => {
        const groupEl = document.createElement('div');
        groupEl.className = `group-item ${group.id === currentGroupId ? 'active' : ''}`;
        groupEl.dataset.id = group.id;

        const nameEl = document.createElement('span');
        nameEl.className = 'group-name';
        nameEl.textContent = group.name;
        nameEl.title = 'Double click to rename';

        const actionsEl = document.createElement('div');
        actionsEl.className = 'group-actions';

        if (group.id !== 'default') {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'group-action-btn material-symbols-outlined';
            deleteBtn.textContent = 'delete';
            deleteBtn.title = 'Delete group and its notes';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Delete group "${group.name}" and all its notes?`)) {
                    deleteGroup(group.id);
                }
            });
            actionsEl.appendChild(deleteBtn);
        }

        groupEl.appendChild(nameEl);
        groupEl.appendChild(actionsEl);

        groupEl.addEventListener('click', () => switchGroup(group.id));

        groupEl.addEventListener('dblclick', async (e) => {
            e.stopPropagation();
            const newName = await showGroupModal('Rename Group', group.name);
            if (newName && newName !== group.name) {
                renameGroup(group.id, newName);
            }
        });

        groupList.appendChild(groupEl);
    });
}

async function switchGroup(groupId) {
    if (currentGroupId === groupId) return;
    currentGroupId = groupId;
    localStorage.setItem('currentGroupId', currentGroupId);

    renderGroups();

    workspace.innerHTML = '';
    notes = [];
    await loadNotes();
}

async function createNewGroup() {
    const name = await showGroupModal('New Group');
    if (!name) return;
    const id = generateId();
    const newGroup = { id, name };
    await addGroupDB(newGroup);
    groups.push(newGroup);
    renderGroups();
    switchGroup(id);
}

async function renameGroup(id, newName) {
    const group = groups.find(g => g.id === id);
    if (group) {
        group.name = newName;
        await updateGroupDB(group);
        renderGroups();
    }
}

async function deleteGroup(id) {
    await deleteGroupDB(id);
    groups = groups.filter(g => g.id !== id);
    if (currentGroupId === id) {
        await switchGroup('default');
    } else {
        renderGroups();
    }
}

if (addGroupButton) {
    addGroupButton.addEventListener('click', createNewGroup);
}

// load notes from IndexedDB
async function loadNotes() {
    await migrateLegacyNotes();
    await loadGroups();
    notes = await getAllNotesDB(currentGroupId);
    notes.forEach(renderNote);
    updateNoteCount();
    await assignNoteIds();
}

// update note count display
function updateNoteCount() {
    const counter = document.getElementById('number_of_memo');
    if (counter) counter.textContent = notes.length;
}

// generate unique id
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// コピー時のフィードバック表示
function showCopyFeedback() {
    const feedback = document.createElement('div');
    feedback.className = 'copy-feedback';
    feedback.textContent = 'Copied!';
    document.body.appendChild(feedback);
    // CSSトランジション適用
    setTimeout(() => feedback.classList.add('visible'), 10);
    // 一定時間後にフェードアウトして削除
    setTimeout(() => {
        feedback.classList.remove('visible');
        setTimeout(() => document.body.removeChild(feedback), 300);
    }, 1000);
}

// アイコンのフィードバック (3秒間チェックマークにする共通関数)
function showIconFeedback(note) {
    const noteEl = workspace.querySelector(`[data-id='${note.id}']`);
    if (noteEl) {
        // header-actions 内の最初のボタン（コピーボタン）を取得
        const copyBtn = noteEl.querySelector('.header-actions .btn');
        const iconSpan = copyBtn ? copyBtn.querySelector('.material-symbols-outlined') : null;
        if (iconSpan) {
            const originalIcon = iconSpan.textContent;
            iconSpan.textContent = 'check';
            setTimeout(() => {
                iconSpan.textContent = originalIcon;
            }, 3000);
        }
    }
}

// ノートをコピーする共通関数
async function handleCopy(note) {
    if (note.type === 'text') {
        await navigator.clipboard.writeText(note.content);
    } else if (note.type === 'image') {
        try {
            const res = await fetch(note.content);
            const blob = await res.blob();
            const item = new ClipboardItem({ [blob.type]: blob });
            await navigator.clipboard.write([item]);
        } catch (err) {
            console.error('画像のコピーに失敗しました', err);
        }
    }
    showCopyFeedback();
    showIconFeedback(note);
}

// テキストに合わせてノートの高さを自動調整する関数
function autoResizeNote(noteEl, note) {
    if (note.type !== 'text') return;
    const content = noteEl.querySelector('.note-content');
    if (!content) return;

    // 一旦高さをautoにして実際の内容量を確認
    const originalHeight = noteEl.style.height;
    noteEl.style.height = 'auto';
    const headerHeight = noteEl.querySelector('.note-header').offsetHeight;
    const contentHeight = content.scrollHeight;
    const padding = 24; // .note-content の上下 padding 合計付近

    const newHeight = headerHeight + contentHeight + padding;

    // スナップさせる
    const snappedHeight = snap(newHeight);

    // 最小サイズを下回らないように
    const finalHeight = Math.max(snappedHeight, 100);

    noteEl.style.height = finalHeight + 'px';

    // DB更新
    if (parseInt(originalHeight) !== finalHeight) {
        note.height = finalHeight;
        updateNoteDB(note);
    }
}

// create and append note element
function renderNote(note) {
    // ノートにcolorがなければdefaultNoteColorを設定
    if (!note.color) note.color = defaultNoteColor;
    // zIndex がない場合は現在の最小値を割り当て
    if (note.zIndex === undefined) {
        note.zIndex = maxZIndex++;
        updateNoteDB(note);
    } else {
        // maxZIndex を更新して次以降の重なりを担保
        if (note.zIndex >= maxZIndex) maxZIndex = note.zIndex + 1;
    }

    // DB更新（マイグレーション対応）
    if (!note.color || !note.width || !note.height) updateNoteDB(note);
    // 既存ノートに幅・高さがない場合はデフォルトを設定
    if (!note.width || !note.height) {
        note.width = note.width || 250;
        note.height = note.height || 200;
        updateNoteDB(note);
    }
    if (!note.color) {
        note.color = defaultNoteColor;
        updateNoteDB(note);
    }
    const noteEl = document.createElement('div');
    noteEl.classList.add('note');
    noteEl.style.left = note.x + 'px';
    noteEl.style.top = note.y + 'px';
    noteEl.style.width = note.width + 'px';
    noteEl.style.height = note.height + 'px';
    noteEl.style.zIndex = note.zIndex; // 保存された zIndex を適用
    noteEl.dataset.id = note.id;
    // 背景色設定
    noteEl.style.backgroundColor = COLORS.find(c => c.name === note.color).hex;

    // クリック（mousedown）したときに最前面へ
    noteEl.addEventListener('mousedown', async () => {
        const newZ = maxZIndex++;
        noteEl.style.zIndex = newZ;
        note.zIndex = newZ;
        await updateNoteDB(note); // zIndex の変更を保存
    });

    // header
    const header = document.createElement('div');
    header.className = 'note-header';

    // ID Container
    const idContainer = document.createElement('div');
    idContainer.className = 'note-id-container';
    const idLabel = document.createElement('div');
    idLabel.className = 'note-id';
    idLabel.textContent = note.keyId || '';
    idLabel.title = 'ショートカットキー';
    idContainer.appendChild(idLabel);
    header.appendChild(idContainer);

    // Right-aligned container for colors and buttons
    const headerRight = document.createElement('div');
    headerRight.className = 'header-right-group';

    // Color Panel (One-row)
    const noteColorPanel = document.createElement('div');
    noteColorPanel.className = 'color-panel';
    COLORS.forEach(c => {
        const sw = document.createElement('div');
        sw.className = 'color-swatch';
        sw.style.backgroundColor = c.hex;
        sw.dataset.color = c.name;
        if (c.name === note.color) sw.classList.add('selected');
        sw.addEventListener('click', async (e) => {
            e.stopPropagation(); // Prevent drag on color click
            note.color = c.name;
            // 次回からのデフォルトカラーを更新
            defaultNoteColor = c.name;
            localStorage.setItem('defaultNoteColor', defaultNoteColor);

            await updateNoteDB(note);
            noteEl.style.backgroundColor = c.hex;
            noteColorPanel.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('selected'));
            sw.classList.add('selected');
        });
        noteColorPanel.appendChild(sw);
    });
    headerRight.appendChild(noteColorPanel);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'header-actions';

    // copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';
    copyBtn.title = 'コピー';

    // delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn text-danger';
    deleteBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
    deleteBtn.title = '削除';

    actions.appendChild(copyBtn);
    actions.appendChild(deleteBtn);
    headerRight.appendChild(actions);

    header.appendChild(headerRight);

    noteEl.appendChild(header);




    // content
    const content = document.createElement('div');
    content.className = 'note-content';
    if (note.type === 'text') {
        content.textContent = note.content;
        content.contentEditable = "true"; // HTML5 contenteditable を有効化
        content.spellcheck = false;
    } else if (note.type === 'image') {
        const img = document.createElement('img');
        img.src = note.content;
        content.appendChild(img);
    }
    noteEl.appendChild(content);


    // size indicator
    const sizeEl = document.createElement('span');
    sizeEl.className = 'note-size';
    sizeEl.textContent = `${new Blob([note.content]).size} bytes`;
    noteEl.appendChild(sizeEl);

    workspace.appendChild(noteEl);

    // 初期表示時に自動リサイズ
    if (note.type === 'text') {
        autoResizeNote(noteEl, note);
    }

    // events
    // drag
    let isDragging = false;
    let offsetX, offsetY;
    header.addEventListener('mousedown', e => {
        isDragging = true;
        offsetX = e.clientX - noteEl.offsetLeft;
        offsetY = e.clientY - noteEl.offsetTop;
    });

    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const rawX = e.clientX - offsetX;
        const rawY = e.clientY - offsetY;
        noteEl.style.left = snap(rawX) + 'px';
        noteEl.style.top = snap(rawY) + 'px';
    });

    document.addEventListener('mouseup', async e => {
        if (isDragging) {
            isDragging = false;

            // 通常の移動として位置を保存
            const id = noteEl.dataset.id;
            const idx = notes.findIndex(n => n.id === id);
            if (idx > -1) {
                notes[idx].x = noteEl.offsetLeft;
                notes[idx].y = noteEl.offsetTop;
                await updateNoteDB(notes[idx]);
            }
        }
    });

    // リサイズ処理: ResizeObserver でリサイズ後をDBに保存
    // 初回コールをスキップするフラグ
    let isInitialResize = true;
    const resizeObserver = new ResizeObserver(entries => {
        if (isInitialResize) {
            // 初期描画時のNotifyを無視
            isInitialResize = false;
            return;
        }
        for (const entry of entries) {
            // 外側の幅・高さを取得（padding/borderを含む）
            const rect = noteEl.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;
            const id = noteEl.dataset.id;
            const idx = notes.findIndex(n => n.id === id);
            if (idx > -1) {
                notes[idx].width = width;
                notes[idx].height = height;
                updateNoteDB(notes[idx]);
            }
        }
    });
    resizeObserver.observe(noteEl);

    // copy
    copyBtn.addEventListener('click', async () => {
        await handleCopy(note);
    });

    // delete
    deleteBtn.addEventListener('click', async () => {
        // 保存（1つ分のみ）
        lastDeletedNote = { ...note };

        workspace.removeChild(noteEl);
        notes = notes.filter(n => n.id !== note.id);
        await deleteNoteDB(note.id);
        updateNoteCount();
        await assignNoteIds();

        showToast('Note deleted. Press Ctrl+Z to undo.');
    });

    // edit logic
    if (note.type === 'text') {
        content.addEventListener('input', () => {
            note.content = content.innerText;
            autoResizeNote(noteEl, note);

            // update size display
            const sizeEl = noteEl.querySelector('.note-size');
            if (sizeEl) sizeEl.textContent = `${new Blob([note.content]).size} bytes`;
        });

        content.addEventListener('blur', async () => {
            note.content = content.innerText;
            await updateNoteDB(note);
        });

        // Cmd/Ctrl + Enter で編集終了（フォーカスを外す）
        content.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                content.blur();
            }
        });
    }

    content.addEventListener('dblclick', () => {
        if (note.type === 'image') {
            // 画像をモーダルで拡大表示
            const modalImage = document.getElementById('modalImage');
            modalImage.src = note.content;
            const imgModal = new bootstrap.Modal(document.getElementById('imageModal'));
            imgModal.show();
        }
    });
}

// add new text note
async function createNewNote(text, x = snap(10), y = snap(10)) {
    const note = {
        id: generateId(),
        groupId: currentGroupId,
        type: 'text',
        content: text,
        x: x,
        y: y,
        width: 250,
        height: 200,
        color: defaultNoteColor,
        zIndex: maxZIndex++ // 新規作成時も zIndex を保存
    };
    await addNoteDB(note);
    notes.push(note);
    renderNote(note);
    updateNoteCount();
    await assignNoteIds();
}

// ダブルクリックで新規メモ作成
workspace.addEventListener('dblclick', async (e) => {
    // ノート自体やノート内の要素をクリックした場合は何もしない
    if (e.target !== workspace) return;

    // クリック位置を取得してスナップ
    const x = snap(e.offsetX);
    const y = snap(e.offsetY);

    // 空のメモを作成
    await createNewNote('New Note', x, y);

    // 作成されたメモを自動的に編集モードにする（最後の要素がそれ）
    const lastNote = notes[notes.length - 1];
    const noteEl = workspace.querySelector(`[data-id='${lastNote.id}']`);
    if (noteEl) {
        const contentEl = noteEl.querySelector('.note-content');
        if (contentEl) {
            contentEl.focus();
            // カーソルを末尾に移動（任意ですが使い勝手向上のため）
            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(contentEl);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }
});

// 全画面ドロップゾーン作成
const globalDropZone = document.createElement('div');
globalDropZone.id = 'global-drop-zone';
globalDropZone.textContent = 'ここに画像をドロップ';
document.body.appendChild(globalDropZone);

// 画像の貼り付け対応
document.addEventListener('paste', async e => {
    // 入力要素（textarea等）や contentEditable 要素でのペーストは無視（編集中のノートなど）
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.isContentEditable) return;

    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file && file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = async () => {
                    const dataUrl = reader.result;
                    // 画面中央付近に配置
                    const x = snap((window.innerWidth - 200) / 2);
                    const y = snap((window.innerHeight - 200) / 2);
                    const note = {
                        id: generateId(),
                        groupId: currentGroupId,
                        type: 'image',
                        content: dataUrl,
                        x: x,
                        y: y,
                        width: 200,
                        height: 200,
                        color: defaultNoteColor,
                        zIndex: maxZIndex++ // paste時も zIndex を保存
                    };
                    await addNoteDB(note);
                    notes.push(note);
                    renderNote(note);
                    updateNoteCount();
                    await assignNoteIds();
                };
                reader.readAsDataURL(file);
            }
        }
    }
});

// 全画面ドラッグ＆ドロップイベント
// 画像ファイルドラッグ時にオーバーレイ表示
document.addEventListener('dragenter', e => {
    const items = e.dataTransfer.items;
    if (items && Array.from(items).some(item => item.kind === 'file' && item.type.startsWith('image/'))) {
        e.preventDefault();
        globalDropZone.classList.add('active');
    }
});
// オーバーレイ上でドラムオーバー
document.addEventListener('dragover', e => {
    const items = e.dataTransfer.items;
    if (items && Array.from(items).some(item => item.kind === 'file' && item.type.startsWith('image/'))) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }
});
// ドラッグ終了時にオーバーレイ非表示
document.addEventListener('dragend', () => {
    globalDropZone.classList.remove('active');
});
// オーバーレイから離れたとき
globalDropZone.addEventListener('dragleave', () => {
    globalDropZone.classList.remove('active');
});
// ドロップ処理
globalDropZone.addEventListener('drop', async e => {
    e.preventDefault();
    globalDropZone.classList.remove('active');
    const files = Array.from(e.dataTransfer.files || []);
    for (const file of files) {
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = async () => {
                const dataUrl = reader.result;
                // 画面中央に配置
                const baseX = (window.innerWidth - 200) / 2;
                const baseY = (window.innerHeight - 200) / 2;
                const note = {
                    id: generateId(),
                    groupId: currentGroupId,
                    type: 'image',
                    content: dataUrl,
                    x: snap(baseX),
                    y: snap(baseY),
                    width: 200,
                    height: 200,
                    color: defaultNoteColor,
                    zIndex: maxZIndex++
                };
                await addNoteDB(note);
                notes.push(note);
                renderNote(note);
                updateNoteCount();
                await assignNoteIds();
            };
            reader.readAsDataURL(file);
        }
    }
});

// clear all
clearAllButton.addEventListener('click', async () => {
    if (confirm('Are you sure you want to delete all notes in this group?')) {
        await clearAllNotesDB(currentGroupId);
        notes = [];
        workspace.innerHTML = '';
        updateNoteCount();
    }
});

// Dark/Light mode toggle via data-bs-theme
const themeToggle = document.getElementById('themeToggle');
// 初期状態設定
const htmlEl = document.documentElement;
themeToggle.checked = htmlEl.getAttribute('data-bs-theme') === 'dark';
themeToggle.addEventListener('change', () => {
    const mode = themeToggle.checked ? 'dark' : 'light';
    htmlEl.setAttribute('data-bs-theme', mode);
});

// display app version from manifest.json
fetch('manifest.json')
    .then(res => res.json())
    .then(data => {
        const verEl = document.getElementById('appVersion');
        if (verEl && data.version) verEl.textContent = `v${data.version}`;
    })
    .catch(err => console.error('Failed to load manifest version', err));

if (window.electronAPI && window.electronAPI.onPasteNote) {
    window.electronAPI.onPasteNote(async (key) => {
        const note = notes.find(n => n.keyId === key);
        if (!note) return;

        // 背景動作時でも確実にクリップボードへ送るためにメインプロセス経由でコピー
        window.electronAPI.sendDeliverNote(key, note.type, note.content);
        showIconFeedback(note);

        // クリップボードが更新されるのを待ってからシステムレベルのペーストを実行 (500ms 余裕を設ける)
        setTimeout(() => {
            if (window.electronAPI.triggerSystemPaste) {
                window.electronAPI.triggerSystemPaste();
            }
        }, 100);
    });
}

// Electron グローバルショートカット経由でリクエストを受け取り、メモ内容を送信
if (window.electronAPI && window.electronAPI.onRequestNote) {
    window.electronAPI.onRequestNote((key) => {
        const note = notes.find(n => n.keyId === key);
        if (!note) return;
        window.electronAPI.sendDeliverNote(key, note.type, note.content);
        showIconFeedback(note); // アイコンを変化させる
    });
}

// Electron グローバルショートカット copy-note イベントでコピー
if (window.electronAPI && window.electronAPI.onCopyNote) {
    window.electronAPI.onCopyNote(async (key) => {
        const note = notes.find(n => n.keyId === key);
        if (!note) return;
        await handleCopy(note);
    });
}

// ウィンドウ内ショートカット (ブラウザ動作時およびフォーカス時用)
window.addEventListener('keydown', async (e) => {
    // 入力中（編集中のメモ、input, textarea）は無視
    if (e.target.tagName === 'INPUT' ||
        e.target.tagName === 'TEXTAREA' ||
        e.target.isContentEditable) {
        return;
    }

    // 修飾キー（Ctrl, Cmd, Alt, Shift）が押されている場合はブラウザ標準機能を優先
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || (e.key === 'Z' && e.shiftKey)) {
            // Undo delete
            if (lastDeletedNote) {
                e.preventDefault();
                const restoredNote = { ...lastDeletedNote };
                lastDeletedNote = null; // Clear to prevent double undo

                await addNoteDB(restoredNote);
                notes.push(restoredNote);
                renderNote(restoredNote);
                updateNoteCount();
                await assignNoteIds();
                showToast('Note restored!');
            }
        }
        return;
    }

    if (e.altKey || e.shiftKey) return;
    const key = e.key;
    const note = notes.find(n => n.keyId === key);
    if (note) {
        e.preventDefault();
        await handleCopy(note);
    }
});

// キャンバス操作ヒントの作成と制御
const canvasHint = document.createElement('div');
canvasHint.className = 'canvas-hint';
canvasHint.textContent = 'Double-click to create a note';
document.body.appendChild(canvasHint);

workspace.addEventListener('mousemove', (e) => {
    // ワークスペース自体（またはそこにあるドロップゾーン）の上でのみヒントを表示
    if (e.target === workspace || e.target.id === 'global-drop-zone') {
        canvasHint.classList.add('visible');
        canvasHint.style.left = (e.clientX + 8) + 'px';
        canvasHint.style.top = (e.clientY + 8) + 'px';
    } else {
        canvasHint.classList.remove('visible');
    }
});

workspace.addEventListener('mouseleave', () => {
    canvasHint.classList.remove('visible');
});

// init
(async () => {
    await initStorageMode();
    await syncFromExternalIfNeeded();
    await loadNotes().then(() => {
        // レンダラー側のメモ配列をメインプロセスから参照可能に
        window.getNotes = () => notes;
    });

    // UI events for settings
    const settingsBtn = document.getElementById('settings-button');
    const helpBtn = document.getElementById('help-button');
    const changeStorageBtn = document.getElementById('change-storage-button');
    const exportBtn = document.getElementById('export-button');
    const importInput = document.getElementById('import-input');
    const toggleSidebarBtn = document.getElementById('toggle-sidebar-button');
    const sidebar = document.getElementById('sidebar');

    // Restore sidebar state
    if (localStorage.getItem('sidebarCollapsed') === 'true') {
        sidebar.classList.add('collapsed');
        if (toggleSidebarBtn) {
            toggleSidebarBtn.querySelector('.material-symbols-outlined').textContent = 'menu';
        }
    }

    if (toggleSidebarBtn && sidebar) {
        toggleSidebarBtn.addEventListener('click', () => {
            const isCollapsed = sidebar.classList.toggle('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed);

            // Toggle icon
            const iconSpan = toggleSidebarBtn.querySelector('.material-symbols-outlined');
            if (iconSpan) {
                iconSpan.textContent = isCollapsed ? 'menu' : 'menu_open';
            }
        });
    }

    if (helpBtn) {
        helpBtn.addEventListener('click', () => {
            const modal = new bootstrap.Modal(document.getElementById('helpModal'));
            modal.show();
        });
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
            modal.show();
        });
    }

    if (changeStorageBtn) {
        if (!window.electronAPI) {
            changeStorageBtn.disabled = true;
            changeStorageBtn.title = "Not available in browser";
        } else {
            changeStorageBtn.addEventListener('click', async () => {
                const path = await window.electronAPI.selectDirectory();
                if (path) {
                    externalPath = path;
                    storageMode = 'external';
                    updateSettingsUI();
                    await syncToExternalIfNeeded();
                }
            });
        }
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', handleExport);
    }

    if (importInput) {
        importInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleImport(e.target.files[0]);
            }
        });
    }

    const resetAppBtn = document.getElementById('reset-app-button');
    if (resetAppBtn) {
        resetAppBtn.addEventListener('click', handleResetApp);
    }
})();
