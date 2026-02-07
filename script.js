// state
let notes = [];
const storageKey = 'memableNotes';

const workspace = document.getElementById('workspace');
// load grid snap state from localStorage
const savedGridSnap = localStorage.getItem('gridSnapEnabled');
let isGridSnap = savedGridSnap === 'true';
const gridToggle = document.getElementById('grid-toggle');
const clearAllButton = document.getElementById('clear-all-button');

// z-index 管理用
let maxZIndex = 1000;

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
    const req = indexedDB.open('memable-db', 1);
    req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

async function getAllNotesDB() {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readonly');
    const store = tx.objectStore('notes');
    return new Promise((res, rej) => {
        const r = store.getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
async function addNoteDB(note) {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').add(note);
    return tx.complete;
}
async function updateNoteDB(note) {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').put(note);
    return tx.complete;
}
async function deleteNoteDB(id) {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').delete(id);
    return tx.complete;
}
async function clearAllNotesDB() {
    const db = await dbPromise;
    const tx = db.transaction('notes', 'readwrite');
    tx.objectStore('notes').clear();
    return tx.complete;
}

// 数値をキーIDに変換
function numToKeyId(num) {
    if (num <= 9) return String(num);
    const code = 'a'.charCodeAt(0) + (num - 10);
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

// load notes from IndexedDB
async function loadNotes() {
    notes = await getAllNotesDB();
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
            // update position
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
        workspace.removeChild(noteEl);
        notes = notes.filter(n => n.id !== note.id);
        await deleteNoteDB(note.id);
        updateNoteCount();
        await assignNoteIds();
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
    // 入力要素（textarea等）でのペーストは無視（編集中のノートなど）
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;

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
                const note = { id: generateId(), type: 'image', content: dataUrl, x: snap(baseX), y: snap(baseY), width: 200, height: 200, color: defaultNoteColor };
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
    if (confirm('Are you sure you want to delete all notes?')) {
        await clearAllNotesDB();
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

        // 共通のコピー処理を実行（アイコン・通知フィードバック含む）
        await handleCopy(note);

        // フォーカス中の要素に直接貼り付け
        const active = document.activeElement;
        if (note.type === 'text' && active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /text|search|url|tel|password/.test(active.type)))) {
            const start = active.selectionStart;
            const end = active.selectionEnd;
            const val = active.value;
            active.value = val.slice(0, start) + note.content + val.slice(end);
            active.selectionStart = active.selectionEnd = start + note.content.length;
            active.focus();
        } else {
            document.execCommand('paste');
        }
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
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

    const key = e.key.toLowerCase();
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
        canvasHint.style.left = (e.clientX + 15) + 'px';
        canvasHint.style.top = (e.clientY + 15) + 'px';
    } else {
        canvasHint.classList.remove('visible');
    }
});

workspace.addEventListener('mouseleave', () => {
    canvasHint.classList.remove('visible');
});

// init
loadNotes().then(() => {
    // レンダラー側のメモ配列をメインプロセスから参照可能に
    window.getNotes = () => notes;
});