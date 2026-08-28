// state
let notes = [];
let groups = [];
let currentGroupId = localStorage.getItem('currentGroupId') || 'default';
let storageMode = 'indexeddb'; // 'indexeddb' or 'external'
let externalPath = null;
let globalShortcutsEnabled = false;
let isSyncing = false; // 外部同期中フラグ（ループ防止）
let pendingExternalSync = false;
let externalSyncPromise = null;
const storageKey = 'memableNotes';
const DEFAULT_GROUP_ID = 'default';
const DEFAULT_KANBAN_TODO_COLUMN = { id: 'todo', name: 'ToDo' };
const DEFAULT_KANBAN_DONE_COLUMN = { id: 'done', name: 'Done' };
const DEFAULT_KANBAN_MIDDLE_COLUMNS = [
    { id: 'doing', name: 'Doing' }
];
const DEFAULT_KANBAN_COLUMNS = buildKanbanColumns(DEFAULT_KANBAN_MIDDLE_COLUMNS);
const KANBAN_FREE_CANVAS_ID = '__kanban_free_canvas__';
const DEFAULT_TEXT_NOTE_WIDTH = 375;
const DEFAULT_TEXT_NOTE_HEIGHT = 200;
const DEFAULT_SIDEBAR_WIDTH = 200;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 480;
const DATA_FORMAT_VERSION = '2.0.0';
const selectedNoteIds = new Set();

// --- Undo Logic ---
let lastDeletedNote = null;

const workspace = document.getElementById('workspace');
const groupList = document.getElementById('group-list');
const addGroupButton = document.getElementById('add-group-button');
const shortcutToggleSwitch = document.getElementById('shortcut-toggle-switch');
const noteResizeObservers = new Map();

// --- Storage & Settings Logic ---
function disconnectNoteObserver(noteId) {
    const observer = noteResizeObservers.get(noteId);
    if (observer) {
        observer.disconnect();
        noteResizeObservers.delete(noteId);
    }
}

function cleanupNoteObservers() {
    noteResizeObservers.forEach(observer => observer.disconnect());
    noteResizeObservers.clear();
}

function isNoteEditorActive() {
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLElement
        && activeElement.isContentEditable
        && Boolean(activeElement.closest('.note-content, .kanban-card-content'));
}

async function applyExternalDataChange() {
    if (externalSyncPromise) {
        pendingExternalSync = true;
        return externalSyncPromise;
    }

    isSyncing = true;
    externalSyncPromise = (async () => {
        console.log('External data change detected. Syncing...');
        await syncFromExternalIfNeeded();
        cleanupNoteObservers();
        workspace.innerHTML = '';
        notes = [];
        await loadNotes();
        showToast('Sync updated from external storage');
    })();

    try {
        await externalSyncPromise;
    } finally {
        externalSyncPromise = null;
        isSyncing = false;
    }

    if (pendingExternalSync && !isNoteEditorActive()) {
        pendingExternalSync = false;
        await applyExternalDataChange();
    }
}

async function flushPendingExternalSync() {
    if (!pendingExternalSync || isNoteEditorActive() || externalSyncPromise) return;
    pendingExternalSync = false;
    await applyExternalDataChange();
}
async function initSettings() {
    if (window.electronAPI) {
        const config = await window.electronAPI.getStorageConfig();
        if (config) {
            if (config.externalPath) {
                storageMode = 'external';
                externalPath = config.externalPath;
            }
            globalShortcutsEnabled = config.globalShortcutsEnabled;
            updateShortcutToggleUI();
        }
    }
    updateSettingsUI();
}

function updateShortcutToggleUI() {
    if (shortcutToggleSwitch) {
        shortcutToggleSwitch.checked = globalShortcutsEnabled;
    }
}

if (shortcutToggleSwitch) {
    shortcutToggleSwitch.addEventListener('change', async () => {
        if (window.electronAPI) {
            const newState = shortcutToggleSwitch.checked;
            globalShortcutsEnabled = await window.electronAPI.toggleShortcuts(newState);
            updateShortcutToggleUI();
            showToast(`Global Shortcuts: ${globalShortcutsEnabled ? 'Enabled' : 'Disabled'}`);
        } else {
            shortcutToggleSwitch.checked = false;
            showToast('Global shortcuts only available in Desktop App');
        }
    });
}

function updateSettingsUI() {
    const pathDisplay = document.getElementById('storage-path-display');
    const statusBox = document.getElementById('storage-status');
    const themeToggle = document.getElementById('themeToggle');

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
    if (themeToggle) {
        themeToggle.checked = document.body.classList.contains('dark-mode');
    }
    updateShortcutToggleUI();
}

// データ保存時に外部ストレージが有効なら書き込む
async function syncToExternalIfNeeded() {
    if (isSyncing) return; // 外部からの同期中（読み込み中）は書き込まない
    if (storageMode === 'external' && window.electronAPI) {
        // すべてのメモとグループを取得して保存
        const allNotes = await getAllNotesDB_Full();
        const allGroups = await getAllGroupsDB();
        if (window.electronAPI.saveExternalSnapshot) {
            await window.electronAPI.saveExternalSnapshot({ notes: allNotes, groups: allGroups });
        } else {
            await window.electronAPI.saveExternalData('notes.json', allNotes);
            await window.electronAPI.saveExternalData('groups.json', allGroups);
        }
    }
}

// 起動時に外部ストレージからデータを読み込む
async function syncFromExternalIfNeeded() {
    if (storageMode === 'external' && window.electronAPI) {
        try {
            const snapshot = window.electronAPI.loadExternalSnapshot
                ? await window.electronAPI.loadExternalSnapshot()
                : null;
            const extNotes = snapshot?.notes ?? await window.electronAPI.loadExternalData('notes.json');
            const extGroups = snapshot?.groups ?? await window.electronAPI.loadExternalData('groups.json');

            const hasNotesFile = Array.isArray(extNotes);
            const hasGroupsFile = Array.isArray(extGroups);
            if (!hasNotesFile && !hasGroupsFile) {
                return;
            }
            const db = await dbPromise;
            const tx = db.transaction(['notes', 'groups'], 'readwrite');

            if (hasNotesFile) {
                const groupsForNormalization = hasGroupsFile ? extGroups : await getAllGroupsDB();
                const normalizedNotes = normalizeBackupPayload({ notes: extNotes, groups: groupsForNormalization }).notes;
                const noteStore = tx.objectStore('notes');
                noteStore.clear();
                for (const note of normalizedNotes) {
                    noteStore.put(serializeNoteForStorage(note));
                }
            }

            if (hasGroupsFile) {
                const normalizedGroups = normalizeBackupPayload({ groups: extGroups, notes: [] }).groups;
                const groupStore = tx.objectStore('groups');
                groupStore.clear();
                for (const group of normalizedGroups) {
                    groupStore.put(group);
                }
            }

            return new Promise((resolve) => {
                tx.oncomplete = () => {
                    console.log('Synced from external storage');
                    resolve();
                };
                tx.onerror = () => {
                    console.error('Transaction error during sync', tx.error);
                    resolve();
                };
            });
        } catch (err) {
            console.error('Failed to sync from external storage:', err);
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
const savedZoomPercent = Number(localStorage.getItem('uiZoomPercent'));
let uiZoomPercent = Number.isFinite(savedZoomPercent) && savedZoomPercent > 0 ? savedZoomPercent : 100;
const gridToggle = document.getElementById('grid-toggle');
const clearAllButton = document.getElementById('clear-all-button');
const zoomLevelLabel = document.getElementById('zoom-level-label');

// z-index 管理用
let maxZIndex = 100;

// ボタン表示更新関数
function updateGridToggleButton() {
    if (gridToggle) {
        gridToggle.innerHTML = `<span class="material-symbols-outlined">grid_4x4</span> <span class="btn-text">Grid: ${isGridSnap ? 'ON' : 'OFF'}</span>`;
    }
}

function clampZoomPercent(value) {
    return Math.min(200, Math.max(50, value));
}

function getZoomScale() {
    return uiZoomPercent / 100;
}

function convertViewportDeltaToWorkspace(delta) {
    return delta / getZoomScale();
}

function getWorkspacePointFromPointer(event) {
    const rect = workspace.getBoundingClientRect();
    return {
        x: convertViewportDeltaToWorkspace(event.clientX - rect.left) + workspace.scrollLeft,
        y: convertViewportDeltaToWorkspace(event.clientY - rect.top) + workspace.scrollTop
    };
}

function updateZoomUI() {
    if (zoomLevelLabel) {
        zoomLevelLabel.textContent = `${uiZoomPercent}%`;
    }
}

function countCharacters(text = '') {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        return Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)).length;
    }
    return Array.from(text).length;
}

function formatNoteSize(content = '') {
    const characterCount = countCharacters(content);
    const byteCount = new Blob([content]).size;
    return `${characterCount} chars / ${byteCount} bytes`;
}

function appendInlineMarkdown(container, text) {
    const tokenPattern = /(\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let cursor = 0;
    for (const match of text.matchAll(tokenPattern)) {
        if (match.index > cursor) container.appendChild(document.createTextNode(text.slice(cursor, match.index)));
        const token = match[0];
        if (token.startsWith('[[')) {
            const target = token.slice(2, -2).trim();
            const link = document.createElement('a');
            link.href = '#';
            link.className = 'internal-note-link';
            link.dataset.noteRef = target;
            link.textContent = target;
            link.contentEditable = 'false';
            container.appendChild(link);
        } else if (token.startsWith('[')) {
            const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
            const link = document.createElement('a');
            link.href = parts[2];
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = parts[1];
            link.contentEditable = 'false';
            container.appendChild(link);
        } else if (token.startsWith('`')) {
            const code = document.createElement('code');
            code.textContent = token.slice(1, -1);
            container.appendChild(code);
        } else {
            const strong = document.createElement('strong');
            strong.textContent = token.slice(2, -2);
            container.appendChild(strong);
        }
        cursor = match.index + token.length;
    }
    if (cursor < text.length) container.appendChild(document.createTextNode(text.slice(cursor)));
}

function renderMarkdownInto(element, markdown) {
    element.replaceChildren();
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    let codeBlock = null;
    lines.forEach(line => {
        if (line.startsWith('```')) {
            if (codeBlock) {
                element.appendChild(codeBlock);
                codeBlock = null;
            } else {
                codeBlock = document.createElement('pre');
                codeBlock.appendChild(document.createElement('code'));
            }
            return;
        }
        if (codeBlock) {
            const code = codeBlock.querySelector('code');
            code.textContent += `${code.textContent ? '\n' : ''}${line}`;
            return;
        }

        let block;
        const heading = line.match(/^(#{1,4})\s+(.+)$/);
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);
        const quote = line.match(/^>\s?(.*)$/);
        if (heading) {
            block = document.createElement(`h${heading[1].length}`);
            appendInlineMarkdown(block, heading[2]);
        } else if (bullet) {
            block = document.createElement('div');
            block.className = 'markdown-list-item';
            block.append('• ');
            appendInlineMarkdown(block, bullet[1]);
        } else if (numbered) {
            block = document.createElement('div');
            block.className = 'markdown-list-item';
            block.append(`${numbered[1]}. `);
            appendInlineMarkdown(block, numbered[2]);
        } else if (quote) {
            block = document.createElement('blockquote');
            appendInlineMarkdown(block, quote[1]);
        } else if (!line) {
            block = document.createElement('br');
        } else {
            block = document.createElement('div');
            appendInlineMarkdown(block, line);
        }
        element.appendChild(block);
    });
    if (codeBlock) element.appendChild(codeBlock);
    element.classList.add('markdown-preview');
}

async function openInternalNoteLink(reference) {
    const allGroups = await getAllGroupsDB();
    const allNotes = normalizeBackupPayload({ notes: await getAllNotesDB_Full(), groups: allGroups }).notes;
    const normalizedReference = String(reference).trim().toLocaleLowerCase();
    const target = allNotes.find(note => note.id === reference)
        || allNotes.find(note => normalizeNoteTitle(note.title).toLocaleLowerCase() === normalizedReference);
    if (!target) {
        showToast(`Note not found: ${reference}`);
        return;
    }
    if (target.groupId !== currentGroupId) await switchGroup(target.groupId);
    const targetElement = workspace.querySelector(`[data-id='${target.id}']`);
    if (targetElement) {
        targetElement.classList.add('linked-note-highlight');
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        setTimeout(() => targetElement.classList.remove('linked-note-highlight'), 1800);
    }
}

function setupMarkdownEditor(element, note, onInput = null) {
    element.contentEditable = 'true';
    element.spellcheck = false;
    renderMarkdownInto(element, note.content);
    let originalContent = note.content;

    element.addEventListener('focus', () => {
        if (!element.classList.contains('markdown-preview')) return;
        originalContent = note.content;
        element.classList.remove('markdown-preview');
        element.textContent = note.content;
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    });
    element.addEventListener('input', () => {
        note.content = getEditablePlainText(element);
        if (onInput) onInput();
    });
    element.addEventListener('blur', async () => {
        note.content = getEditablePlainText(element);
        if (note.content !== originalContent) touchNote(note);
        await updateNoteDB(note);
        renderMarkdownInto(element, note.content);
        await flushPendingExternalSync();
    });
    element.addEventListener('mousedown', e => {
        const link = e.target.closest('.internal-note-link');
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        openInternalNoteLink(link.dataset.noteRef);
    });
    element.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            element.blur();
        }
    });
}

function attachNoteSelection(noteElement, headerElement, note) {
    noteElement.classList.toggle('note-selected', selectedNoteIds.has(note.id));
    headerElement.addEventListener('click', e => {
        if (!(e.metaKey || e.ctrlKey) || e.target.closest('button, .color-swatch, a')) return;
        e.preventDefault();
        e.stopPropagation();
        if (selectedNoteIds.has(note.id)) selectedNoteIds.delete(note.id);
        else selectedNoteIds.add(note.id);
        noteElement.classList.toggle('note-selected', selectedNoteIds.has(note.id));
        updateContextExportButton();
    });
}

function toggleNoteSelection(noteId) {
    if (selectedNoteIds.has(noteId)) selectedNoteIds.delete(noteId);
    else selectedNoteIds.add(noteId);
    workspace.querySelector(`[data-id='${noteId}']`)?.classList.toggle('note-selected', selectedNoteIds.has(noteId));
    updateContextExportButton();
}

function createSelectionButton(note) {
    const button = document.createElement('button');
    button.className = 'btn note-select-button';
    button.title = 'Select for Context Export';
    button.innerHTML = `<span class="material-symbols-outlined">${selectedNoteIds.has(note.id) ? 'check_box' : 'check_box_outline_blank'}</span>`;
    button.addEventListener('click', e => {
        e.stopPropagation();
        toggleNoteSelection(note.id);
        button.querySelector('.material-symbols-outlined').textContent = selectedNoteIds.has(note.id) ? 'check_box' : 'check_box_outline_blank';
    });
    return button;
}

function updateContextExportButton() {
    const button = document.getElementById('context-export-button');
    if (!button) return;
    const label = button.querySelector('.btn-text');
    if (label) label.textContent = selectedNoteIds.size ? `Context (${selectedNoteIds.size})` : 'Context';
}

const EDITABLE_BLOCK_TAG_NAMES = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5',
    'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
    'TABLE', 'UL'
]);

function getEditablePlainText(element) {
    let text = '';

    const appendNewline = () => {
        if (!text.endsWith('\n')) text += '\n';
    };

    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue.replace(/\r\n?/g, '\n');
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tagName = node.tagName;
        if (tagName === 'BR') {
            text += '\n';
            return;
        }

        const isBlock = node !== element && EDITABLE_BLOCK_TAG_NAMES.has(tagName);
        if (isBlock && text && !text.endsWith('\n')) appendNewline();

        node.childNodes.forEach(walk);

        if (isBlock && text) appendNewline();
    };

    element.childNodes.forEach(walk);
    return text.replace(/\u00a0/g, ' ').replace(/\n$/, '');
}

function applyZoom() {
    uiZoomPercent = clampZoomPercent(uiZoomPercent);
    const zoomScale = getZoomScale();
    document.documentElement.style.setProperty('--ui-zoom-scale', String(zoomScale));
    document.body.style.zoom = String(zoomScale);
    localStorage.setItem('uiZoomPercent', String(uiZoomPercent));
    updateZoomUI();
}

function changeZoom(delta) {
    uiZoomPercent = clampZoomPercent(uiZoomPercent + delta);
    applyZoom();
}

function resetZoom() {
    uiZoomPercent = 100;
    applyZoom();
}

// initialize button state
updateGridToggleButton();
applyZoom();

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

document.addEventListener('keydown', (event) => {
    const hasShortcutModifier = event.metaKey || event.ctrlKey;
    if (!hasShortcutModifier || event.altKey) return;

    if (event.key === '+' || event.key === '=' || event.key === 'Add') {
        event.preventDefault();
        changeZoom(10);
        return;
    }

    if (event.key === '-' || event.key === '_' || event.key === 'Subtract') {
        event.preventDefault();
        changeZoom(-10);
        return;
    }

    if (event.key === '0') {
        event.preventDefault();
        resetZoom();
    }
});

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

function cloneKanbanColumns(columns) {
    return columns.map(col => ({ ...col }));
}

function cloneDefaultKanbanMiddleColumns() {
    return cloneKanbanColumns(DEFAULT_KANBAN_MIDDLE_COLUMNS);
}

function buildKanbanColumns(middleColumns = cloneDefaultKanbanMiddleColumns()) {
    return [
        { ...DEFAULT_KANBAN_TODO_COLUMN },
        ...cloneKanbanColumns(Array.isArray(middleColumns) ? middleColumns : []),
        { ...DEFAULT_KANBAN_DONE_COLUMN }
    ];
}

function cloneDefaultKanbanColumns() {
    return cloneKanbanColumns(DEFAULT_KANBAN_COLUMNS);
}

function normalizeKanbanColumns(columns) {
    if (!Array.isArray(columns) || columns.length === 0) {
        return cloneDefaultKanbanColumns();
    }

    const sourceColumns = columns
        .map(rawCol => rawCol && typeof rawCol === 'object' ? rawCol : null)
        .filter(Boolean);

    if (sourceColumns.length === 0) {
        return cloneDefaultKanbanColumns();
    }

    const hasFixedEdges =
        sourceColumns.length >= 2
        && sourceColumns[0].id === DEFAULT_KANBAN_TODO_COLUMN.id
        && sourceColumns[sourceColumns.length - 1].id === DEFAULT_KANBAN_DONE_COLUMN.id;

    const middleSources = hasFixedEdges
        ? sourceColumns.slice(1, -1)
        : sourceColumns.filter(source => source.id !== DEFAULT_KANBAN_TODO_COLUMN.id && source.id !== DEFAULT_KANBAN_DONE_COLUMN.id);

    const normalizedMiddle = [];
    const usedIds = new Set([DEFAULT_KANBAN_TODO_COLUMN.id, DEFAULT_KANBAN_DONE_COLUMN.id]);

    for (const rawCol of middleSources) {
        const source = rawCol && typeof rawCol === 'object' ? rawCol : {};
        const name = typeof source.name === 'string' && source.name.trim()
            ? source.name.trim()
            : `Step ${normalizedMiddle.length + 1}`;
        let id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : generateId();

        if (id === DEFAULT_KANBAN_TODO_COLUMN.id || id === DEFAULT_KANBAN_DONE_COLUMN.id) {
            id = generateId();
        }

        while (usedIds.has(id)) {
            id = generateId();
        }
        usedIds.add(id);
        normalizedMiddle.push({ id, name });
    }

    return buildKanbanColumns(normalizedMiddle);
}

function getKanbanMiddleColumns(columns) {
    return normalizeKanbanColumns(columns).slice(1, -1);
}

function createKanbanMiddleColumn(name = '') {
    return {
        id: generateId(),
        name
    };
}

function getKanbanColumnRole(index, totalColumns) {
    if (index === 0) return 'todo';
    if (index === totalColumns - 1) return 'done';
    return 'progress';
}

function getReassignedKanbanColumnId(previousColumns, removedIndex, nextColumnIdSet) {
    for (let index = removedIndex - 1; index >= 0; index -= 1) {
        const candidate = previousColumns[index];
        if (candidate && nextColumnIdSet.has(candidate.id)) {
            return candidate.id;
        }
    }

    return previousColumns[0]?.id || DEFAULT_KANBAN_TODO_COLUMN.id;
}

function getKanbanColumnReassignmentMap(previousColumns, nextColumns) {
    const nextColumnIdSet = new Set(nextColumns.map(column => column.id));
    const reassignmentMap = new Map();

    previousColumns.forEach((column, index) => {
        if (nextColumnIdSet.has(column.id)) return;
        reassignmentMap.set(column.id, getReassignedKanbanColumnId(previousColumns, index, nextColumnIdSet));
    });

    return reassignmentMap;
}

function normalizeGroupSchema(group) {
    const source = group && typeof group === 'object' ? group : {};
    const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : generateId();
    const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : 'Untitled';
    const viewMode = source.viewMode === 'kanban' ? 'kanban' : 'canvas';
    const kanbanColumns = normalizeKanbanColumns(source.kanbanColumns);
    const parentId = typeof source.parentId === 'string' && source.parentId.trim() ? source.parentId.trim() : null;
    const order = Number.isFinite(source.order) ? source.order : Number.MAX_SAFE_INTEGER;

    return { ...source, id, name, viewMode, kanbanColumns, parentId, order };
}

function getDefaultGroup() {
    return {
        id: DEFAULT_GROUP_ID,
        name: 'Default',
        viewMode: 'canvas',
        kanbanColumns: cloneDefaultKanbanColumns(),
        parentId: null,
        order: 0
    };
}

function normalizeGroupHierarchy(groupItems) {
    const normalized = groupItems.map((group, index) => ({
        ...normalizeGroupSchema(group),
        _sourceIndex: index
    }));
    const ids = new Set(normalized.map(group => group.id));

    normalized.forEach(group => {
        if (!group.parentId || group.parentId === group.id || !ids.has(group.parentId)) {
            group.parentId = null;
        }
        const visited = new Set([group.id]);
        let parentId = group.parentId;
        while (parentId) {
            if (visited.has(parentId)) {
                group.parentId = null;
                break;
            }
            visited.add(parentId);
            parentId = normalized.find(candidate => candidate.id === parentId)?.parentId || null;
        }
    });

    const siblings = new Map();
    normalized.forEach(group => {
        const key = group.parentId || '';
        const list = siblings.get(key) || [];
        list.push(group);
        siblings.set(key, list);
    });
    siblings.forEach(list => {
        list.sort((a, b) => a.order - b.order || a._sourceIndex - b._sourceIndex);
        list.forEach((group, index) => {
            group.order = index;
            delete group._sourceIndex;
        });
    });
    return normalized;
}

function normalizeBackupPayload(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const rawNotes = Array.isArray(source.notes) ? source.notes : (Array.isArray(source) ? source : []);
    const rawGroups = Array.isArray(source.groups) ? source.groups : [];

    let normalizedGroups = normalizeGroupHierarchy(rawGroups);
    if (!normalizedGroups.some(group => group.id === DEFAULT_GROUP_ID)) {
        normalizedGroups.push(getDefaultGroup());
    }
    normalizedGroups = normalizeGroupHierarchy(normalizedGroups);

    const groupMap = new Map(normalizedGroups.map(group => [group.id, group]));
    const fallbackGroup = groupMap.get(DEFAULT_GROUP_ID) || normalizedGroups[0] || getDefaultGroup();
    const orderMap = new Map();

    const normalizedNotes = rawNotes.map(rawNote => {
        const sourceNote = rawNote && typeof rawNote === 'object' ? rawNote : {};
        const note = { ...sourceNote };

        note.id = typeof note.id === 'string' && note.id.trim() ? note.id.trim() : generateId();
        note.groupId = typeof note.groupId === 'string' && groupMap.has(note.groupId) ? note.groupId : fallbackGroup.id;
        note.type = note.type === 'image' ? 'image' : 'text';
        note.title = normalizeNoteTitle(note.title);
        note.content = typeof note.content === 'string' ? note.content : '';
        note.tags = Array.isArray(note.tags)
            ? [...new Set(note.tags.map(tag => String(tag).trim()).filter(Boolean))]
            : [];
        note.createdAt = typeof note.createdAt === 'string' && note.createdAt ? note.createdAt : null;
        note.updatedAt = typeof note.updatedAt === 'string' && note.updatedAt ? note.updatedAt : note.createdAt;
        note.source = note.source && typeof note.source === 'object'
            ? {
                type: typeof note.source.type === 'string' && note.source.type ? note.source.type : 'manual',
                url: typeof note.source.url === 'string' && note.source.url ? note.source.url : null
            }
            : { type: 'manual', url: null };

        const presentation = note.presentation && typeof note.presentation === 'object' ? note.presentation : {};
        // Runtime updates use the top-level presentation fields. Stored Markdown
        // snapshots only have the nested presentation object, so use it as fallback.
        note.x = Number.isFinite(note.x) ? note.x : (Number.isFinite(presentation.x) ? presentation.x : 10);
        note.y = Number.isFinite(note.y) ? note.y : (Number.isFinite(presentation.y) ? presentation.y : 10);
        note.width = Number.isFinite(note.width) ? note.width : (Number.isFinite(presentation.width) ? presentation.width : (note.type === 'image' ? 200 : 250));
        note.height = Number.isFinite(note.height) ? note.height : (Number.isFinite(presentation.height) ? presentation.height : 200);
        const presentationColor = note.color || presentation.color;
        note.color = COLORS.some(color => color.name === presentationColor) ? presentationColor : defaultNoteColor;
        note.zIndex = Number.isFinite(note.zIndex) ? note.zIndex : (Number.isFinite(presentation.zIndex) ? presentation.zIndex : 100);
        note.presentation = {
            x: note.x,
            y: note.y,
            width: note.width,
            height: note.height,
            color: note.color,
            zIndex: note.zIndex
        };

        const group = groupMap.get(note.groupId) || fallbackGroup;
        const columns = normalizeKanbanColumns(group.kanbanColumns);
        const columnIdSet = new Set(columns.map(column => column.id));

        note.kanbanColumnId =
            typeof note.kanbanColumnId === 'string' && (columnIdSet.has(note.kanbanColumnId) || note.kanbanColumnId === KANBAN_FREE_CANVAS_ID)
                ? note.kanbanColumnId
                : columns[0].id;

        const orderKey = `${note.groupId}:${note.kanbanColumnId}`;
        const nextOrder = orderMap.get(orderKey) || 0;
        note.kanbanOrder = Number.isFinite(note.kanbanOrder) ? note.kanbanOrder : nextOrder;
        orderMap.set(orderKey, Math.max(nextOrder + 1, note.kanbanOrder + 1));

        return note;
    });

    return { notes: normalizedNotes, groups: normalizedGroups };
}

function serializeNoteForStorage(note) {
    const normalized = note;
    const stored = { ...note };
    stored.presentation = {
        x: normalized.x,
        y: normalized.y,
        width: normalized.width,
        height: normalized.height,
        color: normalized.color,
        zIndex: normalized.zIndex
    };
    delete stored.x;
    delete stored.y;
    delete stored.width;
    delete stored.height;
    delete stored.color;
    delete stored.zIndex;
    return stored;
}

function touchNote(note) {
    note.updatedAt = new Date().toISOString();
}

function normalizeNoteTitle(title) {
    return typeof title === 'string' ? title.trim() : '';
}

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

    const groupsReq = groupStore.getAll();
    groupsReq.onsuccess = () => {
        const allGroups = groupsReq.result || [];
        const notesReq = noteStore.getAll();

        notesReq.onsuccess = () => {
            const allNotes = notesReq.result || [];
            const normalized = normalizeBackupPayload({ notes: allNotes, groups: allGroups });

            normalized.groups.forEach(group => groupStore.put(group));
            normalized.notes.forEach(note => noteStore.put(serializeNoteForStorage(note)));
        };
    };
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
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
    const normalizedGroup = normalizeGroupSchema(group);
    const db = await dbPromise;
    const tx = db.transaction('groups', 'readwrite');
    tx.objectStore('groups').add(normalizedGroup);
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}

async function updateGroupDB(group) {
    const normalizedGroup = normalizeGroupSchema(group);
    const db = await dbPromise;
    const tx = db.transaction('groups', 'readwrite');
    tx.objectStore('groups').put(normalizedGroup);
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}

async function updateGroupsBatchDB(groupItems) {
    const db = await dbPromise;
    const tx = db.transaction('groups', 'readwrite');
    const store = tx.objectStore('groups');
    groupItems.map(normalizeGroupSchema).forEach(group => store.put(group));
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
    const now = new Date().toISOString();
    note.createdAt = note.createdAt || now;
    note.updatedAt = note.updatedAt || note.createdAt;
    const normalizedNote = normalizeBackupPayload({ notes: [note], groups }).notes[0] || note;
    Object.assign(note, normalizedNote);
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').add(serializeNoteForStorage(normalizedNote));
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}
async function updateNoteDB(note) {
    const normalizedNote = normalizeBackupPayload({ notes: [note], groups }).notes[0] || note;
    Object.assign(note, normalizedNote);
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put(serializeNoteForStorage(normalizedNote));
    return new Promise((res, rej) => {
        tx.oncomplete = async () => {
            await syncToExternalIfNeeded();
            res();
        };
        tx.onerror = () => rej(tx.error);
    });
}

async function updateNotesBatchDB(notesToUpdate) {
    const uniqueNotes = Array.from(new Map(notesToUpdate.map(note => [note.id, note])).values());
    if (uniqueNotes.length === 0) return;

    const normalizedNotes = normalizeBackupPayload({ notes: uniqueNotes, groups }).notes;
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    const store = tx.objectStore('notes');

    normalizedNotes.forEach(note => {
        store.put(serializeNoteForStorage(note));
    });

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
    const changedNotes = [];
    for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        const keyId = numToKeyId(i + 1);
        if (note.keyId !== keyId) {
            note.keyId = keyId;
            changedNotes.push(note);
        }
        const noteEl = workspace.querySelector(`[data-id='${note.id}']`);
        if (noteEl) {
            const idEl = noteEl.querySelector('.note-id');
            if (idEl) {
                idEl.textContent = `${keyId}`;
                idEl.title = `ショートカットキー: ${keyId}`;
            }
        }
    }
    await updateNotesBatchDB(changedNotes);
}

// --- Export / Import ---
async function handleExport() {
    const allNotes = await getAllNotesDB_Full();
    const allGroups = await getAllGroupsDB();
    const data = { notes: allNotes, groups: allGroups, version: DATA_FORMAT_VERSION, source: 'memable' };

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

function getDescendantGroupIds(rootId, groupItems) {
    const result = new Set([rootId]);
    let changed = true;
    while (changed) {
        changed = false;
        groupItems.forEach(group => {
            if (group.parentId && result.has(group.parentId) && !result.has(group.id)) {
                result.add(group.id);
                changed = true;
            }
        });
    }
    return result;
}

function getNoteStatusName(note, group) {
    return normalizeKanbanColumns(group?.kanbanColumns).find(column => column.id === note.kanbanColumnId)?.name
        || note.kanbanColumnId
        || 'ToDo';
}

function buildContextMarkdown(noteItems, groupItems, options = {}) {
    const instruction = options.instruction?.trim();
    const lines = [];
    if (instruction) lines.push('# Instruction', '', instruction, '');
    lines.push('# Memable Context', '', `Exported: ${new Date().toISOString()}`, '');

    const orderedGroups = normalizeGroupHierarchy(groupItems);
    orderedGroups.forEach(group => {
        const groupNotes = noteItems.filter(note => note.groupId === group.id);
        if (groupNotes.length === 0) return;
        lines.push(`## ${group.name}`, '');
        const columns = normalizeKanbanColumns(group.kanbanColumns);
        columns.forEach(column => {
            const columnNotes = groupNotes
                .filter(note => note.kanbanColumnId === column.id)
                .sort((a, b) => (a.kanbanOrder || 0) - (b.kanbanOrder || 0));
            if (!columnNotes.length || (!options.includeDone && column.id === columns.at(-1)?.id)) return;
            lines.push(`### ${column.name}`, '');
            columnNotes.forEach(note => {
                lines.push(`#### ${note.title || `Untitled (${note.id})`}`);
                lines.push(`- ID: ${note.id}`);
                if (note.tags?.length) lines.push(`- Tags: ${note.tags.join(', ')}`);
                lines.push(`- Updated: ${note.updatedAt || '-'}`);
                if (note.source?.url) lines.push(`- Source: ${note.source.url}`);
                lines.push('');
                if (note.type === 'image') {
                    lines.push(options.includeImages ? note.content : '[Image note omitted]');
                } else {
                    lines.push(note.content || '');
                }
                lines.push('');
            });
        });
        const freeNotes = groupNotes.filter(note => note.kanbanColumnId === KANBAN_FREE_CANVAS_ID);
        if (freeNotes.length) {
            lines.push('### Canvas', '');
            freeNotes.forEach(note => {
                lines.push(`#### ${note.title || `Untitled (${note.id})`}`, '');
                if (note.tags?.length) lines.push(`Tags: ${note.tags.join(', ')}`, '');
                lines.push(note.type === 'image' ? (options.includeImages ? note.content : '[Image note omitted]') : note.content, '');
            });
        }
    });
    return `${lines.join('\n').trim()}\n`;
}

async function getContextExportData() {
    const allGroups = normalizeGroupHierarchy(await getAllGroupsDB());
    const allNotes = normalizeBackupPayload({ notes: await getAllNotesDB_Full(), groups: allGroups }).notes;
    if (selectedNoteIds.size) {
        return {
            notes: allNotes.filter(note => selectedNoteIds.has(note.id)),
            groups: allGroups,
            scope: `${selectedNoteIds.size} selected note(s)`
        };
    }
    const includeChildren = document.getElementById('context-include-children')?.checked;
    const groupIds = includeChildren ? getDescendantGroupIds(currentGroupId, allGroups) : new Set([currentGroupId]);
    return {
        notes: allNotes.filter(note => groupIds.has(note.groupId)),
        groups: allGroups,
        scope: includeChildren ? 'Current group and child groups' : 'Current group'
    };
}

async function refreshContextExportPreview() {
    const data = await getContextExportData();
    const options = {
        includeDone: document.getElementById('context-include-done').checked,
        includeImages: document.getElementById('context-include-images').checked,
        instruction: document.getElementById('context-instruction').value
    };
    document.getElementById('context-export-scope').textContent = `${data.scope} · ${data.notes.length} note(s)`;
    document.getElementById('context-export-preview').value = buildContextMarkdown(data.notes, data.groups, options);
}

async function openContextExportModal() {
    await refreshContextExportPreview();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('contextExportModal')).show();
}

async function copyContextMarkdown() {
    const preview = document.getElementById('context-export-preview');
    await navigator.clipboard.writeText(preview.value);
    showToast('Context Markdown copied');
}

function downloadContextMarkdown() {
    const content = document.getElementById('context-export-preview').value;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `memable_context_${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
}

async function handleImport(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            const normalized = normalizeBackupPayload(data);
            if (normalized.notes.length === 0 && normalized.groups.length === 0) {
                throw new Error('Invalid data format');
            }

            if (confirm('Importing will clear current data. Continue?')) {
                const db = await dbPromise;
                const tx = db.transaction(['notes', 'groups'], 'readwrite');
                tx.objectStore('notes').clear();
                tx.objectStore('groups').clear();

                for (const g of normalized.groups) tx.objectStore('groups').add(g);
                for (const n of normalized.notes) tx.objectStore('notes').add(serializeNoteForStorage(n));

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
 * @param {{ allowEmpty?: boolean, placeholder?: string }} options 入力オプション
 * @returns {Promise<string|null>} 保存された名前、またはキャンセル時は null
 */
function showGroupModal(title, defaultValue = '', options = {}) {
    const modalEl = document.getElementById('groupModal');
    const titleEl = document.getElementById('groupModalTitle');
    const inputEl = document.getElementById('group-name-input');
    const saveBtn = document.getElementById('group-modal-save');
    const { allowEmpty = false, placeholder = 'Enter name...' } = options;

    if (!groupModalInstance) {
        groupModalInstance = new bootstrap.Modal(modalEl);
    }

    titleEl.textContent = title;
    inputEl.value = defaultValue;
    inputEl.placeholder = placeholder;

    return new Promise((resolve) => {
        const handleSave = () => {
            const name = inputEl.value.trim();
            if (allowEmpty || name) {
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

let kanbanColumnsModalInstance = null;

function showKanbanColumnsModal(group) {
    const modalEl = document.getElementById('kanbanColumnsModal');
    const editorEl = document.getElementById('kanban-columns-editor');
    const addBtn = document.getElementById('add-kanban-step-button');
    const saveBtn = document.getElementById('kanban-columns-modal-save');
    const middleColumns = getKanbanMiddleColumns(group.kanbanColumns).map(column => ({ ...column }));

    if (!kanbanColumnsModalInstance) {
        kanbanColumnsModalInstance = new bootstrap.Modal(modalEl);
    }

    return new Promise((resolve) => {
        const focusLastInput = () => {
            const inputs = editorEl.querySelectorAll('.kanban-step-input');
            const lastInput = inputs[inputs.length - 1];
            if (lastInput) {
                lastInput.focus();
                lastInput.select();
            }
        };

        const renderEditor = () => {
            editorEl.innerHTML = '';

            if (middleColumns.length === 0) {
                const emptyEl = document.createElement('p');
                emptyEl.className = 'kanban-step-empty';
                emptyEl.textContent = '中間ステップなし。ToDo から Done へ直接移動します。';
                editorEl.appendChild(emptyEl);
                return;
            }

            middleColumns.forEach((column, index) => {
                const rowEl = document.createElement('div');
                rowEl.className = 'kanban-step-row';

                const inputEl = document.createElement('input');
                inputEl.type = 'text';
                inputEl.className = 'form-control m3-input kanban-step-input';
                inputEl.value = column.name;
                inputEl.placeholder = `Step ${index + 1}`;
                inputEl.addEventListener('input', () => {
                    column.name = inputEl.value;
                });

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'btn btn-sm m3-button-tonal';
                removeBtn.textContent = 'Remove';
                removeBtn.addEventListener('click', () => {
                    middleColumns.splice(index, 1);
                    renderEditor();
                });

                rowEl.appendChild(inputEl);
                rowEl.appendChild(removeBtn);
                editorEl.appendChild(rowEl);
            });
        };

        const cleanup = () => {
            addBtn.removeEventListener('click', handleAdd);
            saveBtn.removeEventListener('click', handleSave);
            modalEl.removeEventListener('hidden.bs.modal', handleCancel);
        };

        const handleAdd = () => {
            middleColumns.push(createKanbanMiddleColumn(`Step ${middleColumns.length + 1}`));
            renderEditor();
            window.requestAnimationFrame(focusLastInput);
        };

        const handleSave = () => {
            const nextMiddleColumns = middleColumns.map((column, index) => ({
                id: typeof column.id === 'string' && column.id.trim() ? column.id.trim() : generateId(),
                name: typeof column.name === 'string' && column.name.trim() ? column.name.trim() : `Step ${index + 1}`
            }));

            cleanup();
            kanbanColumnsModalInstance.hide();
            resolve(buildKanbanColumns(nextMiddleColumns));
        };

        const handleCancel = () => {
            cleanup();
            resolve(null);
        };

        addBtn.addEventListener('click', handleAdd);
        saveBtn.addEventListener('click', handleSave);
        modalEl.addEventListener('hidden.bs.modal', handleCancel);

        renderEditor();
        kanbanColumnsModalInstance.show();
    });
}

function normalizeKanbanOrderIndexes(groupId) {
    const groupNotes = notes.filter(note => note.groupId === groupId && !isKanbanFreeCanvasNote(note));
    const groupedNotes = new Map();
    const changedNotes = [];

    groupNotes.forEach(note => {
        const columnNotes = groupedNotes.get(note.kanbanColumnId) || [];
        columnNotes.push(note);
        groupedNotes.set(note.kanbanColumnId, columnNotes);
    });

    groupedNotes.forEach(columnNotes => {
        columnNotes
            .sort((a, b) => (a.kanbanOrder || 0) - (b.kanbanOrder || 0))
            .forEach((note, index) => {
                if (note.kanbanOrder !== index) {
                    note.kanbanOrder = index;
                    changedNotes.push(note);
                }
            });
    });

    return changedNotes;
}

async function updateGroupKanbanColumns(group, nextColumns) {
    const previousColumns = normalizeKanbanColumns(group.kanbanColumns);
    const normalizedNextColumns = normalizeKanbanColumns(nextColumns);
    const reassignmentMap = getKanbanColumnReassignmentMap(previousColumns, normalizedNextColumns);
    const nextColumnIdSet = new Set(normalizedNextColumns.map(column => column.id));
    const nextOrderByColumn = new Map(normalizedNextColumns.map(column => [column.id, 0]));
    const changedNotes = [];

    notes
        .filter(note => note.groupId === group.id && !isKanbanFreeCanvasNote(note))
        .forEach(note => {
            if (nextColumnIdSet.has(note.kanbanColumnId) && !reassignmentMap.has(note.kanbanColumnId)) {
                const nextOrder = Math.max(nextOrderByColumn.get(note.kanbanColumnId) || 0, (note.kanbanOrder || 0) + 1);
                nextOrderByColumn.set(note.kanbanColumnId, nextOrder);
            }
        });

    group.kanbanColumns = normalizedNextColumns;
    await updateGroupDB(group);

    notes
        .filter(note => note.groupId === group.id && !isKanbanFreeCanvasNote(note))
        .forEach(note => {
            const fallbackColumnId = reassignmentMap.get(note.kanbanColumnId);
            const targetColumnId = fallbackColumnId || (nextColumnIdSet.has(note.kanbanColumnId) ? note.kanbanColumnId : normalizedNextColumns[0].id);

            if (note.kanbanColumnId !== targetColumnId) {
                note.kanbanColumnId = targetColumnId;
                note.kanbanOrder = nextOrderByColumn.get(targetColumnId) || 0;
                touchNote(note);
                nextOrderByColumn.set(targetColumnId, note.kanbanOrder + 1);
                changedNotes.push(note);
            }
        });

    await updateNotesBatchDB([...changedNotes, ...normalizeKanbanOrderIndexes(group.id)]);
}

async function editGroupKanbanColumns(groupId) {
    const group = groups.find(candidate => candidate.id === groupId);
    if (!group) return;

    const previousColumns = normalizeKanbanColumns(group.kanbanColumns);
    const nextColumns = await showKanbanColumnsModal(group);
    if (!nextColumns) return;

    const normalizedNextColumns = normalizeKanbanColumns(nextColumns);
    if (JSON.stringify(previousColumns) === JSON.stringify(normalizedNextColumns)) {
        return;
    }

    await updateGroupKanbanColumns(group, normalizedNextColumns);

    if (group.id === currentGroupId) {
        renderWorkspace();
    }

    showToast('Kanban steps updated');
}

async function editNoteTitle(note) {
    const currentTitle = normalizeNoteTitle(note.title);
    const nextTitle = await showGroupModal('Edit Note Title', currentTitle, {
        allowEmpty: true,
        placeholder: 'Leave blank to show number only'
    });

    if (nextTitle === null) return;

    const normalizedTitle = normalizeNoteTitle(nextTitle);
    if (normalizedTitle === currentTitle) return;

    note.title = normalizedTitle;
    touchNote(note);
    await updateNoteDB(note);
    renderWorkspace();
    await assignNoteIds();
}

function showNoteMetadataModal(note) {
    const modalElement = document.getElementById('noteMetadataModal');
    const titleInput = document.getElementById('note-metadata-title');
    const tagsInput = document.getElementById('note-metadata-tags');
    const sourceInput = document.getElementById('note-metadata-source-url');
    const datesElement = document.getElementById('note-metadata-dates');
    const saveButton = document.getElementById('note-metadata-save');
    const modal = bootstrap.Modal.getOrCreateInstance(modalElement);

    titleInput.value = note.title || '';
    tagsInput.value = (note.tags || []).join(', ');
    sourceInput.value = note.source?.url || '';
    datesElement.textContent = `Created: ${note.createdAt || '-'} · Updated: ${note.updatedAt || '-'}`;

    const save = async () => {
        note.title = normalizeNoteTitle(titleInput.value);
        note.tags = [...new Set(tagsInput.value.split(',').map(tag => tag.trim()).filter(Boolean))];
        const sourceUrl = sourceInput.value.trim();
        note.source = { type: sourceUrl ? 'url' : 'manual', url: sourceUrl || null };
        touchNote(note);
        await updateNoteDB(note);
        saveButton.removeEventListener('click', save);
        modal.hide();
        renderWorkspace();
        await assignNoteIds();
    };
    saveButton.addEventListener('click', save, { once: true });
    modalElement.addEventListener('hidden.bs.modal', () => saveButton.removeEventListener('click', save), { once: true });
    modal.show();
}

function createMetadataButton(note) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.innerHTML = '<span class="material-symbols-outlined">label</span>';
    button.title = note.tags?.length ? `Tags: ${note.tags.join(', ')}` : 'Edit title, tags, and source';
    button.addEventListener('click', e => {
        e.stopPropagation();
        showNoteMetadataModal(note);
    });
    return button;
}

function createNoteTitleElement(note) {
    const titleEl = document.createElement('span');
    const title = normalizeNoteTitle(note.title);

    titleEl.className = 'note-title';
    if (!title) {
        titleEl.classList.add('is-empty');
    }

    titleEl.textContent = title;
    titleEl.title = title || 'Double click to add a title';

    titleEl.addEventListener('mousedown', (e) => {
        e.stopPropagation();
    });

    titleEl.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        await editNoteTitle(note);
    });

    return titleEl;
}

async function loadGroups() {
    groups = normalizeGroupHierarchy(await getAllGroupsDB());

    if (groups.length > 0) {
        const db = await dbPromise;
        const tx = db.transaction('groups', 'readwrite');
        const groupStore = tx.objectStore('groups');
        groups.forEach(group => groupStore.put(group));
    }

    if (groups.length === 0) {
        const defaultGroup = getDefaultGroup();
        await addGroupDB(defaultGroup);
        groups = [defaultGroup];
    }

    if (!groups.some(group => group.id === currentGroupId)) {
        currentGroupId = DEFAULT_GROUP_ID;
        localStorage.setItem('currentGroupId', currentGroupId);
    }

    renderGroups();
}

function renderGroups() {
    groupList.innerHTML = '';
    const collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]'));
    const childrenByParent = new Map();
    groups.forEach(group => {
        const key = group.parentId || '';
        const children = childrenByParent.get(key) || [];
        children.push(group);
        childrenByParent.set(key, children);
    });
    childrenByParent.forEach(children => children.sort((a, b) => a.order - b.order));

    const visibleGroups = [];
    const appendVisible = (parentId = null, depth = 0) => {
        (childrenByParent.get(parentId || '') || []).forEach(group => {
            visibleGroups.push({ group, depth });
            if (!collapsedGroups.has(group.id)) appendVisible(group.id, depth + 1);
        });
    };
    appendVisible();

    visibleGroups.forEach(({ group, depth }) => {
        const groupEl = document.createElement('div');
        groupEl.className = `group-item ${group.id === currentGroupId ? 'active' : ''}`;
        groupEl.dataset.id = group.id;
        groupEl.draggable = true;
        groupEl.style.setProperty('--group-depth', String(depth));

        const hasChildren = (childrenByParent.get(group.id) || []).length > 0;
        const expanderEl = document.createElement('button');
        expanderEl.className = `group-expander material-symbols-outlined${hasChildren ? '' : ' placeholder'}`;
        expanderEl.textContent = collapsedGroups.has(group.id) ? 'chevron_right' : 'expand_more';
        expanderEl.title = collapsedGroups.has(group.id) ? 'Expand group' : 'Collapse group';
        expanderEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!hasChildren) return;
            if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
            else collapsedGroups.add(group.id);
            localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups]));
            renderGroups();
        });

        const dragHandleEl = document.createElement('span');
        dragHandleEl.className = 'group-drag-handle material-symbols-outlined';
        dragHandleEl.textContent = 'drag_indicator';
        dragHandleEl.title = 'Drag to reorder or nest';

        const nameEl = document.createElement('span');
        nameEl.className = 'group-name';
        nameEl.textContent = group.name;
        nameEl.title = 'Double click to rename';

        const actionsEl = document.createElement('div');
        actionsEl.className = 'group-actions';

        const columnsBtn = document.createElement('button');
        columnsBtn.className = 'group-action-btn material-symbols-outlined';
        columnsBtn.textContent = 'tune';
        columnsBtn.title = 'Customize kanban steps';
        columnsBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await editGroupKanbanColumns(group.id);
        });
        actionsEl.appendChild(columnsBtn);

        const modeBtn = document.createElement('button');
        modeBtn.className = 'group-action-btn material-symbols-outlined';
        if (group.viewMode === 'kanban') {
            modeBtn.classList.add('mode-kanban');
        }
        modeBtn.textContent = group.viewMode === 'kanban' ? 'view_kanban' : 'sticky_note_2';
        modeBtn.title = group.viewMode === 'kanban' ? 'Switch to Canvas mode' : 'Switch to Kanban mode';
        modeBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            group.viewMode = group.viewMode === 'kanban' ? 'canvas' : 'kanban';
            await updateGroupDB(group);
            renderGroups();
            if (group.id === currentGroupId) {
                renderWorkspace();
            }
        });
        actionsEl.appendChild(modeBtn);

        if (group.id !== DEFAULT_GROUP_ID) {
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

        groupEl.appendChild(expanderEl);
        groupEl.appendChild(dragHandleEl);
        groupEl.appendChild(nameEl);
        groupEl.appendChild(actionsEl);

        groupEl.addEventListener('click', () => {
            if (!groupDragState.didDrop) switchGroup(group.id);
        });

        groupEl.addEventListener('dblclick', async (e) => {
            e.stopPropagation();
            const newName = await showGroupModal('Rename Group', group.name);
            if (newName && newName !== group.name) {
                renameGroup(group.id, newName);
            }
        });

        groupEl.addEventListener('dragstart', (e) => {
            groupDragState.draggedId = group.id;
            groupDragState.didDrop = false;
            groupEl.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/x-memable-group', group.id);
        });
        groupEl.addEventListener('dragend', () => {
            groupEl.classList.remove('dragging');
            clearGroupDropIndicators();
            groupDragState.draggedId = null;
            setTimeout(() => { groupDragState.didDrop = false; }, 0);
        });
        groupEl.addEventListener('dragover', (e) => {
            const draggedId = groupDragState.draggedId;
            if (!draggedId || draggedId === group.id || isGroupDescendant(group.id, draggedId)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            clearGroupDropIndicators();
            groupEl.classList.add(`drop-${getGroupDropPosition(e, groupEl)}`);
        });
        groupEl.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const draggedId = groupDragState.draggedId || e.dataTransfer.getData('text/x-memable-group');
            if (!draggedId || draggedId === group.id || isGroupDescendant(group.id, draggedId)) return;
            groupDragState.didDrop = true;
            await moveGroup(draggedId, group.id, getGroupDropPosition(e, groupEl));
        });

        groupList.appendChild(groupEl);
    });
}

const groupDragState = { draggedId: null, didDrop: false };

function clearGroupDropIndicators() {
    groupList.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach(element => {
        element.classList.remove('drop-before', 'drop-after', 'drop-inside');
    });
}

function getGroupDropPosition(event, element) {
    const rect = element.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    if (ratio < 0.25) return 'before';
    if (ratio > 0.75) return 'after';
    return 'inside';
}

function isGroupDescendant(candidateId, ancestorId) {
    let current = groups.find(group => group.id === candidateId);
    const visited = new Set();
    while (current?.parentId && !visited.has(current.parentId)) {
        if (current.parentId === ancestorId) return true;
        visited.add(current.parentId);
        current = groups.find(group => group.id === current.parentId);
    }
    return false;
}

function reindexGroupSiblings(parentId) {
    groups
        .filter(group => (group.parentId || null) === (parentId || null))
        .sort((a, b) => a.order - b.order)
        .forEach((group, index) => { group.order = index; });
}

async function moveGroup(draggedId, targetId, position) {
    const dragged = groups.find(group => group.id === draggedId);
    const target = groups.find(group => group.id === targetId);
    if (!dragged || !target) return;

    const oldParentId = dragged.parentId;
    const nextParentId = position === 'inside' ? target.id : target.parentId;
    const siblings = groups
        .filter(group => group.id !== dragged.id && (group.parentId || null) === (nextParentId || null))
        .sort((a, b) => a.order - b.order);
    const targetIndex = position === 'inside'
        ? siblings.length
        : Math.max(0, siblings.findIndex(group => group.id === target.id) + (position === 'after' ? 1 : 0));

    dragged.parentId = nextParentId || null;
    siblings.splice(targetIndex, 0, dragged);
    siblings.forEach((group, index) => { group.order = index; });
    reindexGroupSiblings(oldParentId);

    if (position === 'inside') {
        const collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]'));
        collapsedGroups.delete(target.id);
        localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups]));
    }
    await updateGroupsBatchDB(groups);
    renderGroups();
}

async function switchGroup(groupId) {
    if (currentGroupId === groupId) return;
    selectedNoteIds.clear();
    updateContextExportButton();
    currentGroupId = groupId;
    localStorage.setItem('currentGroupId', currentGroupId);

    renderGroups();

    cleanupNoteObservers();
    workspace.innerHTML = '';
    notes = [];
    await loadNotes();
}

function getCurrentGroup() {
    return groups.find(group => group.id === currentGroupId) || getDefaultGroup();
}

function isCurrentGroupKanban() {
    return getCurrentGroup().viewMode === 'kanban';
}

function getNotesForCurrentMode() {
    if (!isCurrentGroupKanban()) return notes;

    return [...notes].sort((a, b) => {
        const colA = a.kanbanColumnId || '';
        const colB = b.kanbanColumnId || '';
        if (colA !== colB) return colA.localeCompare(colB);
        return (a.kanbanOrder || 0) - (b.kanbanOrder || 0);
    });
}

function isKanbanFreeCanvasNote(note) {
    return note.kanbanColumnId === KANBAN_FREE_CANVAS_ID;
}

function renderWorkspace() {
    cleanupNoteObservers();
    workspace.innerHTML = '';
    workspace.ondragover = null;
    workspace.ondrop = null;
    workspace.ondragleave = null;
    workspace.classList.toggle('kanban-mode', isCurrentGroupKanban());
    updateContextExportButton();

    if (isCurrentGroupKanban()) {
        renderKanbanBoard();
    } else {
        notes.forEach(renderNote);
    }
}

function renderKanbanBoard() {
    const group = getCurrentGroup();
    const columns = normalizeKanbanColumns(group.kanbanColumns);

    const boardEl = document.createElement('div');
    boardEl.className = 'kanban-board';
    boardEl.style.setProperty('--kanban-column-count', String(columns.length));

    columns.forEach((column, index) => {
        const columnEl = document.createElement('section');
        columnEl.className = 'kanban-column';
        columnEl.dataset.columnId = column.id;
        columnEl.dataset.columnRole = getKanbanColumnRole(index, columns.length);

        const headerEl = document.createElement('div');
        headerEl.className = 'kanban-column-header';
        headerEl.textContent = column.name;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'kanban-column-body';
        bodyEl.dataset.columnId = column.id;

        bodyEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            bodyEl.classList.add('drag-over');
        });
        bodyEl.addEventListener('dragleave', () => {
            bodyEl.classList.remove('drag-over');
        });
        bodyEl.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            bodyEl.classList.remove('drag-over');
            const noteId = e.dataTransfer.getData('text/plain');
            if (!noteId) return;

            const note = notes.find(n => n.id === noteId);
            if (!note) return;

            note.kanbanColumnId = column.id;
            const maxOrder = notes
                .filter(n => n.groupId === currentGroupId && n.kanbanColumnId === column.id)
                .reduce((acc, n) => Math.max(acc, Number.isFinite(n.kanbanOrder) ? n.kanbanOrder : 0), -1);
            note.kanbanOrder = maxOrder + 1;
            touchNote(note);
            await updateNoteDB(note);
            renderWorkspace();
            await assignNoteIds();
        });

        columnEl.appendChild(headerEl);
        columnEl.appendChild(bodyEl);
        boardEl.appendChild(columnEl);
    });

    workspace.appendChild(boardEl);

    workspace.ondragover = (e) => {
        const isOnColumnBody = e.target.closest('.kanban-column-body');
        if (isOnColumnBody) return;
        if (e.dataTransfer && e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault();
        }
    };

    workspace.ondrop = async (e) => {
        const isOnColumnBody = e.target.closest('.kanban-column-body');
        if (isOnColumnBody) return;

        const noteId = e.dataTransfer.getData('text/plain');
        if (!noteId) return;
        e.preventDefault();

        const note = notes.find(n => n.id === noteId);
        if (!note) return;

        const rect = workspace.getBoundingClientRect();
        const baseWidth = Number.isFinite(note.width) ? note.width : 250;
        const baseHeight = Number.isFinite(note.height) ? note.height : 200;
        const rawX = convertViewportDeltaToWorkspace(e.clientX - rect.left) + workspace.scrollLeft - (baseWidth / 2);
        const rawY = convertViewportDeltaToWorkspace(e.clientY - rect.top) + workspace.scrollTop - 18;

        note.kanbanColumnId = KANBAN_FREE_CANVAS_ID;
        note.x = snap(Math.max(0, rawX));
        note.y = snap(Math.max(0, rawY));
        note.kanbanOrder = 0;
        touchNote(note);
        await updateNoteDB(note);
        renderWorkspace();
        await assignNoteIds();
    };

    const notesForRender = getNotesForCurrentMode();
    notesForRender.filter(note => !isKanbanFreeCanvasNote(note)).forEach(note => renderKanbanCard(note));
    notesForRender
        .filter(note => isKanbanFreeCanvasNote(note))
        .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0))
        .forEach(note => renderNote(note));
}

function renderKanbanCard(note) {
    const targetColumn = workspace.querySelector(`.kanban-column-body[data-column-id='${note.kanbanColumnId}']`)
        || workspace.querySelector('.kanban-column-body');
    if (!targetColumn) return;

    const cardEl = document.createElement('article');
    cardEl.className = 'kanban-card';
    cardEl.dataset.id = note.id;
    cardEl.draggable = true;
    cardEl.style.backgroundColor = COLORS.find(c => c.name === note.color)?.hex || COLORS[0].hex;

    cardEl.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', note.id);
        cardEl.classList.add('dragging');
    });
    cardEl.addEventListener('dragend', () => {
        cardEl.classList.remove('dragging');
    });

    const headerEl = document.createElement('div');
    headerEl.className = 'kanban-card-header';

    const headerMainEl = document.createElement('div');
    headerMainEl.className = 'note-header-main';

    const idEl = document.createElement('span');
    idEl.className = 'note-id';
    idEl.textContent = note.keyId || '';
    idEl.title = 'ショートカットキー';

    const titleEl = createNoteTitleElement(note);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'kanban-card-actions';

    const colorPanel = document.createElement('div');
    colorPanel.className = 'color-panel kanban-color-panel';
    COLORS.forEach(c => {
        const sw = document.createElement('div');
        sw.className = 'color-swatch';
        sw.style.backgroundColor = c.hex;
        sw.dataset.color = c.name;
        if (c.name === note.color) sw.classList.add('selected');
        sw.addEventListener('click', async (e) => {
            e.stopPropagation();
            note.color = c.name;
            defaultNoteColor = c.name;
            localStorage.setItem('defaultNoteColor', defaultNoteColor);

            cardEl.style.backgroundColor = c.hex;
            colorPanel.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('selected'));
            sw.classList.add('selected');
            await updateNoteDB(note);
        });
        colorPanel.appendChild(sw);
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.dataset.action = 'copy';
    copyBtn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';
    copyBtn.title = 'コピー';
    copyBtn.addEventListener('click', async () => {
        await handleCopy(note, copyBtn);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn text-danger';
    deleteBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
    deleteBtn.title = '削除';
    deleteBtn.addEventListener('click', async () => {
        lastDeletedNote = { ...note };
        selectedNoteIds.delete(note.id);
        updateContextExportButton();
        notes = notes.filter(n => n.id !== note.id);
        await deleteNoteDB(note.id);
        renderWorkspace();
        updateNoteCount();
        await assignNoteIds();
        showToast('Note deleted. Press Ctrl+Z to undo.');
    });

    const selectBtn = createSelectionButton(note);
    const metadataBtn = createMetadataButton(note);
    actionsEl.appendChild(colorPanel);
    actionsEl.appendChild(selectBtn);
    actionsEl.appendChild(metadataBtn);
    actionsEl.appendChild(copyBtn);
    actionsEl.appendChild(deleteBtn);
    headerMainEl.appendChild(idEl);
    headerMainEl.appendChild(titleEl);
    headerEl.appendChild(headerMainEl);
    headerEl.appendChild(actionsEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'kanban-card-content';
    if (note.type === 'text') {
        setupMarkdownEditor(contentEl, note);
    } else {
        const img = document.createElement('img');
        img.src = note.content;
        img.alt = 'note image';
        contentEl.appendChild(img);
    }

    cardEl.appendChild(headerEl);
    cardEl.appendChild(contentEl);
    attachNoteSelection(cardEl, headerEl, note);
    targetColumn.appendChild(cardEl);
}

async function createNewGroup() {
    const name = await showGroupModal('New Group');
    if (!name) return;
    const id = generateId();
    const newGroup = {
        id,
        name,
        viewMode: 'canvas',
        kanbanColumns: cloneDefaultKanbanColumns(),
        parentId: null,
        order: groups.filter(group => !group.parentId).length
    };
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
    const deletedGroup = groups.find(group => group.id === id);
    if (!deletedGroup) return;
    const replacementParentId = deletedGroup.parentId || null;
    const children = groups
        .filter(group => group.parentId === id)
        .sort((a, b) => a.order - b.order);
    children.forEach(child => { child.parentId = replacementParentId; });
    groups = groups.filter(g => g.id !== id);
    const promotedIds = new Set(children.map(child => child.id));
    const replacementSiblings = groups
        .filter(group => (group.parentId || null) === replacementParentId && !promotedIds.has(group.id))
        .sort((a, b) => a.order - b.order);
    replacementSiblings.splice(Math.min(deletedGroup.order, replacementSiblings.length), 0, ...children);
    replacementSiblings.forEach((group, index) => { group.order = index; });
    await updateGroupsBatchDB(groups);
    await deleteGroupDB(id);
    if (currentGroupId === id) {
        await switchGroup(DEFAULT_GROUP_ID);
    } else {
        renderGroups();
    }
}

function getPrimaryKanbanColumnId(groupId) {
    const group = groups.find(g => g.id === groupId) || groups.find(g => g.id === DEFAULT_GROUP_ID);
    const columns = normalizeKanbanColumns(group ? group.kanbanColumns : null);
    return columns[0].id;
}

if (addGroupButton) {
    addGroupButton.addEventListener('click', createNewGroup);
}

// load notes from IndexedDB
async function loadNotes() {
    await migrateLegacyNotes();
    await loadGroups();
    notes = normalizeBackupPayload({ notes: await getAllNotesDB(currentGroupId), groups }).notes;
    renderWorkspace();
    updateNoteCount();
    await assignNoteIds();
}

// update note count display
function updateNoteCount() {
    const counter = document.getElementById('number_of_memo');
    if (counter) counter.textContent = notes.length;
}

// Align notes to grid
async function alignNotes() {
    if (isCurrentGroupKanban()) {
        showToast('Align is available in Canvas mode only');
        return;
    }

    if (notes.length === 0) return;

    // Sort notes by updated time
    const sortedNotes = [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const MARGIN = 40;
    const SPACING = 20;
    const workspaceWidth = workspace.clientWidth;

    let currentX = MARGIN;
    let currentY = MARGIN;
    let maxHeightInRow = 0;

    const db = await dbPromise;
    const transaction = db.transaction(['notes'], 'readwrite');
    const store = transaction.objectStore('notes');
    const updates = [];

    for (const note of sortedNotes) {
        // Prefer stored dimensions over DOM measurement to avoid drifting/rounding issues
        const w = note.width || 250;
        const h = note.height || 150;

        // If note exceeds workspace width, move to next row (if not the first item in row)
        if (currentX + w + MARGIN > workspaceWidth && currentX > MARGIN) {
            currentX = MARGIN;
            currentY += maxHeightInRow + SPACING;
            maxHeightInRow = 0;
        }

        note.x = currentX;
        note.y = currentY;

        const request = store.put(serializeNoteForStorage(note));
        updates.push(new Promise((resolve, reject) => {
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        }));

        currentX += w + SPACING;
        maxHeightInRow = Math.max(maxHeightInRow, h);
    }

    try {
        await Promise.all(updates);
        await syncToExternalIfNeeded();

        // Refresh UI
        renderWorkspace();
        showToast('Notes aligned to grid');
    } catch (err) {
        console.error('Alignment failed:', err);
        showToast('Failed to align notes', 'danger');
    }
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
function showIconFeedback(note, copyButton = null) {
    const noteEl = workspace.querySelector(`[data-id='${note.id}']`);
    const resolvedCopyButton = copyButton || (noteEl ? noteEl.querySelector("button[data-action='copy']") : null);
    const iconSpan = resolvedCopyButton ? resolvedCopyButton.querySelector('.material-symbols-outlined') : null;
    if (iconSpan) {
        const originalIcon = iconSpan.textContent;
        iconSpan.textContent = 'check';
        setTimeout(() => {
            iconSpan.textContent = originalIcon;
        }, 3000);
    }
}

// ノートをコピーする共通関数
async function handleCopy(note, copyButton = null) {
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
    showIconFeedback(note, copyButton);
}

// 内容が収まらない場合だけノートの高さを広げる
function autoResizeNote(noteEl, note) {
    if (note.type !== 'text') return;
    const content = noteEl.querySelector('.note-content');
    if (!content) return;

    const overflowHeight = content.scrollHeight - content.clientHeight;
    if (overflowHeight <= 1) return;

    const currentHeight = noteEl.offsetHeight;
    const requiredHeight = currentHeight + overflowHeight;
    const finalHeight = isGridSnap
        ? Math.ceil(requiredHeight / 25) * 25
        : Math.ceil(requiredHeight);

    if (finalHeight <= currentHeight) return;

    noteEl.style.height = finalHeight + 'px';
    note.height = finalHeight;
    updateNoteDB(note);
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

    const headerMain = document.createElement('div');
    headerMain.className = 'note-header-main';

    // ID Container
    const idContainer = document.createElement('div');
    idContainer.className = 'note-id-container';
    const idLabel = document.createElement('div');
    idLabel.className = 'note-id';
    idLabel.textContent = note.keyId || '';
    idLabel.title = 'ショートカットキー';
    idContainer.appendChild(idLabel);

    const titleEl = createNoteTitleElement(note);

    headerMain.appendChild(idContainer);
    headerMain.appendChild(titleEl);
    header.appendChild(headerMain);

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

    if (isCurrentGroupKanban() && isKanbanFreeCanvasNote(note)) {
        const moveToKanbanBtn = document.createElement('button');
        moveToKanbanBtn.className = 'btn';
        moveToKanbanBtn.innerHTML = '<span class="material-symbols-outlined">view_kanban</span>';
        moveToKanbanBtn.title = 'ToDo列へ戻す';
        moveToKanbanBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const targetColumnId = getPrimaryKanbanColumnId(currentGroupId);
            const maxOrder = notes
                .filter(n => n.groupId === currentGroupId && n.kanbanColumnId === targetColumnId)
                .reduce((acc, n) => Math.max(acc, Number.isFinite(n.kanbanOrder) ? n.kanbanOrder : 0), -1);

            note.kanbanColumnId = targetColumnId;
            note.kanbanOrder = maxOrder + 1;
            touchNote(note);
            await updateNoteDB(note);
            renderWorkspace();
            await assignNoteIds();
        });
        actions.appendChild(moveToKanbanBtn);
    }

    const selectBtn = createSelectionButton(note);
    actions.appendChild(selectBtn);
    const metadataBtn = createMetadataButton(note);
    actions.appendChild(metadataBtn);

    // copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.dataset.action = 'copy';
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
        setupMarkdownEditor(content, note, () => {
            autoResizeNote(noteEl, note);
            const currentSizeEl = noteEl.querySelector('.note-size');
            if (currentSizeEl) currentSizeEl.textContent = formatNoteSize(note.content);
        });
    } else if (note.type === 'image') {
        const img = document.createElement('img');
        img.src = note.content;
        content.appendChild(img);
    }
    noteEl.appendChild(content);


    // size indicator
    const sizeEl = document.createElement('span');
    sizeEl.className = 'note-size';
    sizeEl.textContent = formatNoteSize(note.content);
    noteEl.appendChild(sizeEl);

    workspace.appendChild(noteEl);
    attachNoteSelection(noteEl, header, note);



    // events
    // drag
    let isDragging = false;
    let offsetX, offsetY;
    const isKanbanFreeCanvas = isCurrentGroupKanban() && isKanbanFreeCanvasNote(note);
    let hoveredDropColumnBody = null;

    const clearKanbanDropHoverFeedback = () => {
        if (hoveredDropColumnBody) {
            hoveredDropColumnBody.classList.remove('drag-over');
            hoveredDropColumnBody = null;
        }
        document.body.classList.remove('kanban-drop-copy-cursor');
    };

    const isInteractiveDragTarget = (target) => {
        if (!(target instanceof Element)) return false;
        return Boolean(target.closest('.header-actions, .color-panel, .color-swatch, .btn, .note-content, [contenteditable="true"], input, textarea, select, button, a'));
    };

    const isOnNativeResizeHandle = (event) => {
        if (!isKanbanFreeCanvas) return false;
        const rect = noteEl.getBoundingClientRect();
        const handleSize = 18;
        return event.clientX >= rect.right - handleSize && event.clientY >= rect.bottom - handleSize;
    };

    const dragHandle = isKanbanFreeCanvas ? noteEl : header;
    dragHandle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (isKanbanFreeCanvas && isInteractiveDragTarget(e.target)) return;
        if (isOnNativeResizeHandle(e)) return;
        isDragging = true;
        const noteRect = noteEl.getBoundingClientRect();
        offsetX = convertViewportDeltaToWorkspace(e.clientX - noteRect.left);
        offsetY = convertViewportDeltaToWorkspace(e.clientY - noteRect.top);
    });

    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        const workspaceRect = workspace.getBoundingClientRect();
        const rawX = convertViewportDeltaToWorkspace(e.clientX - workspaceRect.left) + workspace.scrollLeft - offsetX;
        const rawY = convertViewportDeltaToWorkspace(e.clientY - workspaceRect.top) + workspace.scrollTop - offsetY;
        noteEl.style.left = snap(rawX) + 'px';
        noteEl.style.top = snap(rawY) + 'px';

        if (isKanbanFreeCanvas) {
            const originalVisibility = noteEl.style.visibility;
            noteEl.style.visibility = 'hidden';
            let dropTarget = null;
            try {
                dropTarget = document.elementFromPoint(e.clientX, e.clientY);
            } finally {
                noteEl.style.visibility = originalVisibility;
            }

            const nextColumnBody = dropTarget && dropTarget.closest
                ? dropTarget.closest('.kanban-column-body')
                : null;

            if (hoveredDropColumnBody && hoveredDropColumnBody !== nextColumnBody) {
                hoveredDropColumnBody.classList.remove('drag-over');
            }

            hoveredDropColumnBody = nextColumnBody || null;
            if (hoveredDropColumnBody) {
                hoveredDropColumnBody.classList.add('drag-over');
                document.body.classList.add('kanban-drop-copy-cursor');
            } else {
                document.body.classList.remove('kanban-drop-copy-cursor');
            }
        }
    });

    document.addEventListener('mouseup', async e => {
        if (isDragging) {
            isDragging = false;

            // 通常の移動として位置を保存
            const id = noteEl.dataset.id;
            const idx = notes.findIndex(n => n.id === id);
            if (idx > -1) {
                if (isKanbanFreeCanvas) {
                    // Custom drag uses absolute note movement; detect underlying kanban column on drop.
                    const targetColumnBody = hoveredDropColumnBody;
                    clearKanbanDropHoverFeedback();

                    if (targetColumnBody && targetColumnBody.dataset.columnId) {
                        const targetColumnId = targetColumnBody.dataset.columnId;
                        const maxOrder = notes
                            .filter(n => n.groupId === currentGroupId && n.kanbanColumnId === targetColumnId)
                            .reduce((acc, n) => Math.max(acc, Number.isFinite(n.kanbanOrder) ? n.kanbanOrder : 0), -1);

                        notes[idx].kanbanColumnId = targetColumnId;
                        notes[idx].kanbanOrder = maxOrder + 1;
                        touchNote(notes[idx]);
                        await updateNoteDB(notes[idx]);
                        renderWorkspace();
                        await assignNoteIds();
                        return;
                    }
                }

                notes[idx].x = noteEl.offsetLeft;
                notes[idx].y = noteEl.offsetTop;
                await updateNoteDB(notes[idx]);
            }
            clearKanbanDropHoverFeedback();
        }
    });

    disconnectNoteObserver(note.id);
    // リサイズ処理: ResizeObserver でリサイズ後をDBに保存
    const resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
            // 外側の幅・高さを取得（padding/borderを含む）
            // 整数値に丸めることで、微細な端数によるループ保存やリサイズ誤差を防ぐ
            const rect = noteEl.getBoundingClientRect();
            const width = Math.round(convertViewportDeltaToWorkspace(rect.width));
            const height = Math.round(convertViewportDeltaToWorkspace(rect.height));
            const id = noteEl.dataset.id;
            const idx = notes.findIndex(n => n.id === id);
            if (idx > -1) {
                // 値が実際に変わった場合のみ更新
                if (notes[idx].width !== width || notes[idx].height !== height) {
                    notes[idx].width = width;
                    notes[idx].height = height;
                    updateNoteDB(notes[idx]);
                }
            }
        }
    });
    resizeObserver.observe(noteEl);
    noteResizeObservers.set(note.id, resizeObserver);

    // copy
    copyBtn.addEventListener('click', async () => {
        await handleCopy(note, copyBtn);
    });

    // delete
    deleteBtn.addEventListener('click', async () => {
        // 保存（1つ分のみ）
        lastDeletedNote = { ...note };
        selectedNoteIds.delete(note.id);
        updateContextExportButton();

        disconnectNoteObserver(note.id);
        workspace.removeChild(noteEl);
        notes = notes.filter(n => n.id !== note.id);
        await deleteNoteDB(note.id);
        updateNoteCount();
        await assignNoteIds();

        showToast('Note deleted. Press Ctrl+Z to undo.');
    });

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
async function createNewNote(text, x = snap(10), y = snap(10), targetColumnId = null) {
    const defaultColumnId = targetColumnId || getPrimaryKanbanColumnId(currentGroupId);
    const note = {
        id: generateId(),
        groupId: currentGroupId,
        type: 'text',
        title: '',
        content: text,
        x: x,
        y: y,
        width: DEFAULT_TEXT_NOTE_WIDTH,
        height: DEFAULT_TEXT_NOTE_HEIGHT,
        color: defaultNoteColor,
        zIndex: maxZIndex++, // 新規作成時も zIndex を保存
        kanbanColumnId: defaultColumnId,
        kanbanOrder: notes.filter(n => n.groupId === currentGroupId && n.kanbanColumnId === defaultColumnId).length
    };
    await addNoteDB(note);
    notes.push(note);
    let newNoteEl;
    if (isCurrentGroupKanban()) {
        renderWorkspace();
    } else {
        renderNote(note);
        newNoteEl = workspace.querySelector(`[data-id='${note.id}']`);
        if (note.type === 'text' && newNoteEl) {
            autoResizeNote(newNoteEl, note);
        }
    }
    updateNoteCount();
    await assignNoteIds();
}

// ダブルクリックで新規メモ作成
workspace.addEventListener('dblclick', async (e) => {
    if (isCurrentGroupKanban()) {
        const columnBody = e.target.closest('.kanban-column-body');
        if (columnBody) {
            await createNewNote('New Note', snap(10), snap(10), columnBody.dataset.columnId);

            const lastNote = notes[notes.length - 1];
            const cardEl = workspace.querySelector(`[data-id='${lastNote.id}']`);
            if (cardEl) {
                const contentEl = cardEl.querySelector('.kanban-card-content');
                if (contentEl) {
                    contentEl.focus();
                    const range = document.createRange();
                    const sel = window.getSelection();
                    range.selectNodeContents(contentEl);
                    range.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
            return;
        }

        if (e.target.closest('.kanban-card') || e.target.closest('.note')) return;

        const point = getWorkspacePointFromPointer(e);
        const x = snap(point.x);
        const y = snap(point.y);

        await createNewNote('New Note', x, y, KANBAN_FREE_CANVAS_ID);

        const lastNote = notes[notes.length - 1];
        const noteEl = workspace.querySelector(`[data-id='${lastNote.id}']`);
        if (noteEl) {
            const contentEl = noteEl.querySelector('.note-content');
            if (contentEl) {
                contentEl.focus();
                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(contentEl);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
        return;
    }

    // ノート自体やノート内の要素をクリックした場合は何もしない
    if (e.target !== workspace) return;

    // 拡大率を補正したクリック位置を取得し、スクロール分を加えてスナップ
    const point = getWorkspacePointFromPointer(e);
    const x = snap(point.x);
    const y = snap(point.y);

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
    // contentEditable 要素（ノート内）でのペースト処理
    if (e.target.isContentEditable) {
        // 画像が含まれていない（テキストのみの）場合はプレーンテキストとして貼り付ける
        const items = Array.from(e.clipboardData.items);
        const hasFile = items.some(item => item.kind === 'file');

        if (!hasFile) {
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
            return;
        }
        // 画像が含まれる場合はデフォルトの挙動（または特定の処理）に任せるか、必要に応じて制限する
        return;
    }

    // 入力要素（textarea等）でのペーストは無視
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;

    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file && file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = async () => {
                    const dataUrl = reader.result;
                    // 画面中央付近に配置（スクロール分を加算）
                    const x = snap((window.innerWidth - 200) / 2 + workspace.scrollLeft);
                    const y = snap((window.innerHeight - 200) / 2 + workspace.scrollTop);
                    const defaultColumnId = getPrimaryKanbanColumnId(currentGroupId);
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
                        zIndex: maxZIndex++, // paste時も zIndex を保存
                        kanbanColumnId: defaultColumnId,
                        kanbanOrder: notes.filter(n => n.groupId === currentGroupId && n.kanbanColumnId === defaultColumnId).length
                    };
                    await addNoteDB(note);
                    notes.push(note);
                    renderWorkspace();
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
                // 画面中央に配置（スクロール分を加算）
                const baseX = (window.innerWidth - 200) / 2 + workspace.scrollLeft;
                const baseY = (window.innerHeight - 200) / 2 + workspace.scrollTop;
                const defaultColumnId = getPrimaryKanbanColumnId(currentGroupId);
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
                    zIndex: maxZIndex++,
                    kanbanColumnId: defaultColumnId,
                    kanbanOrder: notes.filter(n => n.groupId === currentGroupId && n.kanbanColumnId === defaultColumnId).length
                };
                await addNoteDB(note);
                notes.push(note);
                renderWorkspace();
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
        selectedNoteIds.clear();
        updateContextExportButton();
        await clearAllNotesDB(currentGroupId);
        notes = [];
        cleanupNoteObservers();
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
        }, 500);
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
        const zoomScale = getZoomScale();
        canvasHint.style.left = ((e.clientX + 8) / zoomScale) + 'px';
        canvasHint.style.top = ((e.clientY + 8) / zoomScale) + 'px';
    } else {
        canvasHint.classList.remove('visible');
    }
});

workspace.addEventListener('mouseleave', () => {
    canvasHint.classList.remove('visible');
});

// init
(async () => {
    await initSettings();
    await syncFromExternalIfNeeded();
    await loadNotes().then(() => {
        // レンダラー側のメモ配列をメインプロセスから参照可能に
        window.getNotes = () => notes;
    });

    // UI events for settings
    const settingsBtn = document.getElementById('settings-button');
    const helpBtn = document.getElementById('help-button');
    const zoomOutBtn = document.getElementById('zoom-out-button');
    const zoomResetBtn = document.getElementById('zoom-reset-button');
    const zoomInBtn = document.getElementById('zoom-in-button');
    const contextExportBtn = document.getElementById('context-export-button');
    const changeStorageBtn = document.getElementById('change-storage-button');
    const exportBtn = document.getElementById('export-button');
    const importInput = document.getElementById('import-input');
    const toggleSidebarBtn = document.getElementById('toggle-sidebar-button');
    const sidebar = document.getElementById('sidebar');
    const sidebarResizer = document.getElementById('sidebar-resizer');

    if (contextExportBtn) contextExportBtn.addEventListener('click', openContextExportModal);
    document.getElementById('context-copy-button')?.addEventListener('click', copyContextMarkdown);
    document.getElementById('context-download-button')?.addEventListener('click', downloadContextMarkdown);
    ['context-include-children', 'context-include-done', 'context-include-images', 'context-instruction']
        .forEach(id => document.getElementById(id)?.addEventListener('input', refreshContextExportPreview));

    const savedSidebarWidth = Number(localStorage.getItem('sidebarWidth'));
    const initialSidebarWidth = Number.isFinite(savedSidebarWidth)
        ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, savedSidebarWidth))
        : DEFAULT_SIDEBAR_WIDTH;
    document.documentElement.style.setProperty('--sidebar-width', `${initialSidebarWidth}px`);

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

    if (sidebarResizer && sidebar) {
        sidebarResizer.addEventListener('pointerdown', (e) => {
            if (sidebar.classList.contains('collapsed')) return;
            e.preventDefault();
            sidebarResizer.setPointerCapture(e.pointerId);
            sidebar.classList.add('resizing');
            const startX = e.clientX;
            const startWidth = sidebar.getBoundingClientRect().width / getZoomScale();

            const handleMove = (moveEvent) => {
                const width = Math.min(
                    MAX_SIDEBAR_WIDTH,
                    Math.max(MIN_SIDEBAR_WIDTH, startWidth + convertViewportDeltaToWorkspace(moveEvent.clientX - startX))
                );
                document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
            };
            const handleEnd = () => {
                sidebar.classList.remove('resizing');
                sidebarResizer.removeEventListener('pointermove', handleMove);
                sidebarResizer.removeEventListener('pointerup', handleEnd);
                sidebarResizer.removeEventListener('pointercancel', handleEnd);
                const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'));
                localStorage.setItem('sidebarWidth', String(Math.round(width)));
            };
            sidebarResizer.addEventListener('pointermove', handleMove);
            sidebarResizer.addEventListener('pointerup', handleEnd);
            sidebarResizer.addEventListener('pointercancel', handleEnd);
        });
        sidebarResizer.addEventListener('dblclick', () => {
            document.documentElement.style.setProperty('--sidebar-width', `${DEFAULT_SIDEBAR_WIDTH}px`);
            localStorage.setItem('sidebarWidth', String(DEFAULT_SIDEBAR_WIDTH));
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

    const alignBtn = document.getElementById('align-notes');
    if (alignBtn) {
        alignBtn.addEventListener('click', alignNotes);
    }

    if (zoomOutBtn) {
        zoomOutBtn.addEventListener('click', () => changeZoom(-10));
    }

    if (zoomResetBtn) {
        zoomResetBtn.addEventListener('click', resetZoom);
    }

    if (zoomInBtn) {
        zoomInBtn.addEventListener('click', () => changeZoom(10));
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

    // 外部ファイルの変更検知ハンドラ
    if (window.electronAPI && window.electronAPI.onExternalDataChanged) {
        window.electronAPI.onExternalDataChanged(async () => {
            if (isSyncing || isNoteEditorActive()) {
                pendingExternalSync = true;
                return;
            }
            await applyExternalDataChange();
        });
    }
})();
