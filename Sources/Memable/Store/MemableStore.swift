import AppKit
import MemableCore
import Observation
import SwiftUI
import UniformTypeIdentifiers

enum ActiveSheet: Identifiable {
    case newGroup
    case renameGroup(String)
    case noteTitle(String)
    case noteMetadata(String)
    case kanbanSteps(String)
    case contextExport
    case imagePreview(String)
    case help

    var id: String {
        switch self {
        case .newGroup: return "newGroup"
        case .renameGroup(let id): return "renameGroup:\(id)"
        case .noteTitle(let id): return "noteTitle:\(id)"
        case .noteMetadata(let id): return "noteMetadata:\(id)"
        case .kanbanSteps(let id): return "kanbanSteps:\(id)"
        case .contextExport: return "contextExport"
        case .imagePreview(let id): return "imagePreview:\(id)"
        case .help: return "help"
        }
    }
}

enum GroupDropPosition {
    case before, inside, after
}

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct Toast: Equatable, Identifiable {
    let id = UUID()
    let message: String
}

/// Single source of truth: notes, groups, preferences, persistence and sync.
@MainActor
@Observable
final class MemableStore {
    static let shared = MemableStore()

    // MARK: Data
    private(set) var notes: [Note] = []
    private(set) var groups: [NoteGroup] = [.makeDefault()]
    var currentGroupId: String = MemableConstants.defaultGroupId {
        didSet { defaults.set(currentGroupId, forKey: Keys.currentGroupId) }
    }
    var selectedNoteIds: Set<String> = []

    // MARK: Preferences
    var isGridSnap = false { didSet { defaults.set(isGridSnap, forKey: Keys.gridSnap) } }
    var zoomPercent = 100 { didSet { defaults.set(zoomPercent, forKey: Keys.zoom) } }
    var defaultNoteColor: NoteColor = .yellow { didSet { defaults.set(defaultNoteColor.rawValue, forKey: Keys.defaultColor) } }
    var collapsedGroupIds: Set<String> = [] { didSet { defaults.set(Array(collapsedGroupIds), forKey: Keys.collapsedGroups) } }
    var appearance: AppearanceMode = .system {
        didSet {
            defaults.set(appearance.rawValue, forKey: Keys.appearance)
            applyAppearance()
        }
    }
    var globalShortcutsEnabled = false {
        didSet {
            defaults.set(globalShortcutsEnabled, forKey: Keys.globalShortcuts)
            HotKeyManager.shared.setEnabled(globalShortcutsEnabled, keys: KeyIds.all)
        }
    }
    private(set) var externalPath: String?

    // MARK: Transient UI state
    var activeSheet: ActiveSheet?
    var toast: Toast?
    var copiedNoteIds: Set<String> = []
    var highlightedNoteId: String?
    var scrollRequestNoteId: String?
    var focusRequestNoteId: String?
    var editingNoteId: String? {
        didSet { if editingNoteId == nil { flushPendingExternalReload() } }
    }
    var draggingGroupId: String?
    @ObservationIgnored var canvasViewportWidth: Double = 1000
    @ObservationIgnored var lastPointerLocation: CGPoint?
    @ObservationIgnored var lastLinkOpen: Date?
    @ObservationIgnored weak var mainWindow: NSWindow?

    // MARK: Persistence internals
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var library: LibraryFolder
    @ObservationIgnored private var watcher: FolderWatcher?
    @ObservationIgnored private var lastKnownFingerprint: String?
    @ObservationIgnored private var saveWorkItem: DispatchWorkItem?
    @ObservationIgnored private var pendingExternalReload = false
    @ObservationIgnored private var maxZIndex: Double = 100
    @ObservationIgnored private var didStart = false

    private enum Keys {
        static let currentGroupId = "currentGroupId"
        static let gridSnap = "gridSnapEnabled"
        static let zoom = "uiZoomPercent"
        static let defaultColor = "defaultNoteColor"
        static let collapsedGroups = "collapsedGroups"
        static let appearance = "appearance"
        static let globalShortcuts = "globalShortcutsEnabled"
        static let externalPath = "externalPath"
        static let didMigrateElectron = "didMigrateElectronConfig"
    }

    static var localLibraryURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.tetsuakibaba.memable", isDirectory: true)
            .appendingPathComponent("library", isDirectory: true)
    }

    private init() {
        library = LibraryFolder(url: Self.localLibraryURL)
        loadPreferences()
    }

    /// Loads data and starts watching. Called once the app has finished launching.
    func start() {
        guard !didStart else { return }
        didStart = true
        migrateElectronConfigIfNeeded()
        if let externalPath {
            if FileManager.default.fileExists(atPath: externalPath) {
                library = LibraryFolder(url: URL(fileURLWithPath: externalPath))
            } else {
                showToast("External folder not found. Using local storage for now.")
            }
        }
        reloadFromDisk()
        startWatching()
        HotKeyManager.shared.onHotKey = { [weak self] key in self?.quickPaste(key: key) }
        HotKeyManager.shared.setEnabled(globalShortcutsEnabled, keys: KeyIds.all)
        applyAppearance()
    }

    private func loadPreferences() {
        currentGroupId = defaults.string(forKey: Keys.currentGroupId) ?? MemableConstants.defaultGroupId
        isGridSnap = defaults.bool(forKey: Keys.gridSnap)
        let zoom = defaults.integer(forKey: Keys.zoom)
        zoomPercent = zoom > 0 ? min(200, max(50, zoom)) : 100
        defaultNoteColor = defaults.string(forKey: Keys.defaultColor).flatMap(NoteColor.init(rawValue:)) ?? .yellow
        collapsedGroupIds = Set(defaults.stringArray(forKey: Keys.collapsedGroups) ?? [])
        appearance = defaults.string(forKey: Keys.appearance).flatMap(AppearanceMode.init(rawValue:)) ?? .system
        globalShortcutsEnabled = defaults.bool(forKey: Keys.globalShortcuts)
        externalPath = defaults.string(forKey: Keys.externalPath)
    }

    /// Adopts the sync folder and shortcut setting of the Electron app on first launch.
    private func migrateElectronConfigIfNeeded() {
        guard !defaults.bool(forKey: Keys.didMigrateElectron) else { return }
        defaults.set(true, forKey: Keys.didMigrateElectron)
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let configURL = base.appendingPathComponent("memable/config.json")
        guard externalPath == nil,
              let data = try? Data(contentsOf: configURL),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let path = config["externalPath"] as? String, FileManager.default.fileExists(atPath: path) {
            setExternalPath(path)
        }
        if let enabled = config["globalShortcutsEnabled"] as? Bool, enabled {
            globalShortcutsEnabled = true
        }
    }

    private func setExternalPath(_ path: String?) {
        externalPath = path
        defaults.set(path, forKey: Keys.externalPath)
    }

    private func applyAppearance() {
        switch appearance {
        case .system: NSApp?.appearance = nil
        case .light: NSApp?.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp?.appearance = NSAppearance(named: .darkAqua)
        }
    }

    // MARK: - Queries

    var currentGroup: NoteGroup {
        groups.first { $0.id == currentGroupId } ?? groups.first ?? .makeDefault()
    }

    var isKanban: Bool { currentGroup.viewMode == .kanban }

    /// Notes of the current group in shortcut order.
    var currentNotes: [Note] {
        notes.filter { $0.groupId == currentGroupId }.sorted { $0.id < $1.id }
    }

    var keyIdsByNoteId: [String: String] {
        var result: [String: String] = [:]
        for (index, note) in currentNotes.enumerated() {
            if let key = KeyIds.keyId(forPosition: index + 1) { result[note.id] = key }
        }
        return result
    }

    func note(_ id: String) -> Note? {
        notes.first { $0.id == id }
    }

    func note(forKey key: String) -> Note? {
        guard let position = KeyIds.all.firstIndex(of: key) else { return nil }
        let current = currentNotes
        return position < current.count ? current[position] : nil
    }

    func group(_ id: String) -> NoteGroup? {
        groups.first { $0.id == id }
    }

    var groupTree: [(group: NoteGroup, depth: Int)] {
        Normalizer.treeOrder(groups)
    }

    func hasChildren(_ groupId: String) -> Bool {
        groups.contains { $0.parentId == groupId }
    }

    func snap(_ value: Double) -> Double {
        isGridSnap ? (value / MemableConstants.gridSize).rounded() * MemableConstants.gridSize : value
    }

    // MARK: - Persistence

    private func scheduleSave() {
        saveWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.saveNow() }
        saveWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: item)
    }

    var hasPendingSave: Bool { saveWorkItem != nil }

    func saveNow() {
        saveWorkItem?.cancel()
        saveWorkItem = nil
        do {
            try library.save(notes: notes.sorted { $0.id < $1.id }, groups: groups)
            lastKnownFingerprint = library.fingerprint()
        } catch {
            showToast("Failed to save: \(error.localizedDescription)")
        }
        if pendingExternalReload { flushPendingExternalReload() }
    }

    private func reloadFromDisk() {
        let loaded = library.load(defaultColor: defaultNoteColor) ?? Normalizer.normalize(rawNotes: [], groups: [])
        notes = loaded.notes
        groups = loaded.groups.isEmpty ? [.makeDefault()] : loaded.groups
        if !groups.contains(where: { $0.id == currentGroupId }) {
            currentGroupId = MemableConstants.defaultGroupId
        }
        selectedNoteIds = selectedNoteIds.intersection(notes.map(\.id))
        maxZIndex = max(100, (notes.map(\.zIndex).max() ?? 99) + 1)
        lastKnownFingerprint = library.fingerprint()
    }

    private func startWatching() {
        watcher = FolderWatcher(url: library.url) { [weak self] in
            MainActor.assumeIsolated { self?.handleFolderChange() }
        }
    }

    private func handleFolderChange() {
        guard let fingerprint = library.fingerprint(), fingerprint != lastKnownFingerprint else { return }
        if editingNoteId != nil || hasPendingSave {
            pendingExternalReload = true
            return
        }
        applyExternalChange()
    }

    private func flushPendingExternalReload() {
        guard pendingExternalReload, editingNoteId == nil, !hasPendingSave else { return }
        pendingExternalReload = false
        if library.fingerprint() != lastKnownFingerprint { applyExternalChange() }
    }

    private func applyExternalChange() {
        reloadFromDisk()
        showToast("Sync updated from external storage")
    }

    // MARK: - Storage settings

    var storageDescription: String {
        externalPath ?? "Local (\(Self.localLibraryURL.path))"
    }

    func chooseExternalFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Use Folder"
        panel.message = "Choose a folder to sync notes (e.g. ~/Dropbox/Apps/memable)."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        saveNow()

        let folder = LibraryFolder(url: url)
        if folder.containsLibrary {
            let alert = NSAlert()
            alert.messageText = "This folder already contains memable notes."
            alert.informativeText = "Load the notes from the folder, or overwrite the folder with the notes currently open?"
            alert.addButton(withTitle: "Load Folder Notes")
            alert.addButton(withTitle: "Overwrite Folder")
            alert.addButton(withTitle: "Cancel")
            switch alert.runModal() {
            case .alertFirstButtonReturn:
                library = folder
                reloadFromDisk()
            case .alertSecondButtonReturn:
                library = folder
                saveNow()
            default:
                return
            }
        } else {
            library = folder
            saveNow()
        }
        setExternalPath(url.path)
        startWatching()
        showToast("External sync active")
    }

    /// Stops external sync and keeps the current notes in local storage.
    func useLocalStorage() {
        guard externalPath != nil else { return }
        saveNow()
        library = LibraryFolder(url: Self.localLibraryURL)
        setExternalPath(nil)
        saveNow()
        startWatching()
        showToast("Using local storage")
    }

    func revealStorageFolder() {
        NSWorkspace.shared.activateFileViewerSelecting([library.url])
    }

    // MARK: - Backup

    func exportJSON() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "memable_backup_\(ISOTime.now().prefix(10)).json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try BackupCodec.export(notes: notes.sorted { $0.id < $1.id }, groups: groups).write(to: url, options: .atomic)
            showToast("Export successful!")
        } catch {
            Alerts.info("Export failed", message: error.localizedDescription)
        }
    }

    func importJSON() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let imported = try BackupCodec.import(Data(contentsOf: url), defaultColor: defaultNoteColor)
            guard Alerts.confirm("Import notes?", message: "Importing will replace all current notes and groups.",
                                 confirmTitle: "Import", destructive: true) else { return }
            notes = imported.notes
            groups = imported.groups
            selectedNoteIds = []
            if !groups.contains(where: { $0.id == currentGroupId }) { currentGroupId = MemableConstants.defaultGroupId }
            maxZIndex = max(100, (notes.map(\.zIndex).max() ?? 99) + 1)
            saveNow()
            showToast("Import successful!")
        } catch {
            Alerts.info("Failed to import", message: error.localizedDescription)
        }
    }

    func resetEverything() {
        guard Alerts.confirm("Reset everything?",
                             message: "This deletes all local notes, groups and settings. Files in an external sync folder are kept. This cannot be undone.",
                             confirmTitle: "Reset", destructive: true) else { return }
        saveWorkItem?.cancel()
        saveWorkItem = nil
        let local = LibraryFolder(url: Self.localLibraryURL)
        local.removeLibraryFiles()
        if let domain = Bundle.main.bundleIdentifier {
            defaults.removePersistentDomain(forName: domain)
        }
        defaults.set(true, forKey: Keys.didMigrateElectron)
        library = local
        externalPath = nil
        loadPreferences()
        globalShortcutsEnabled = false
        notes = []
        groups = [.makeDefault()]
        selectedNoteIds = []
        currentGroupId = MemableConstants.defaultGroupId
        saveNow()
        startWatching()
        showToast("App has been reset")
    }

    // MARK: - Feedback

    func showToast(_ message: String) {
        let toast = Toast(message: message)
        self.toast = toast
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            if self?.toast == toast { self?.toast = nil }
        }
    }

    private func markCopied(_ id: String) {
        copiedNoteIds.insert(id)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.copiedNoteIds.remove(id)
        }
    }

    // MARK: - Notes

    private func nextZIndex() -> Double {
        defer { maxZIndex += 1 }
        return maxZIndex
    }

    func primaryColumnId(for groupId: String) -> String {
        Kanban.normalize((group(groupId) ?? currentGroup).kanbanColumns)[0].id
    }

    private func nextKanbanOrder(groupId: String, columnId: String) -> Double {
        (notes.filter { $0.groupId == groupId && $0.kanbanColumnId == columnId }.map(\.kanbanOrder).max() ?? -1) + 1
    }

    private func defaultInsertionPoint() -> CGPoint {
        if let point = lastPointerLocation { return point }
        let offset = Double(currentNotes.count % 10) * 25
        return CGPoint(x: 40 + offset, y: 40 + offset)
    }

    @discardableResult
    func createTextNote(at point: CGPoint? = nil, columnId: String? = nil, content: String = "", focus: Bool = true) -> String {
        let column = columnId ?? primaryColumnId(for: currentGroupId)
        let location = point ?? defaultInsertionPoint()
        let now = ISOTime.now()
        let note = Note(groupId: currentGroupId, content: content, createdAt: now, updatedAt: now,
                        x: snap(max(0, location.x)), y: snap(max(0, location.y)),
                        color: defaultNoteColor, zIndex: nextZIndex(),
                        kanbanColumnId: column, kanbanOrder: nextKanbanOrder(groupId: currentGroupId, columnId: column))
        notes.append(note)
        if focus { focusRequestNoteId = note.id }
        scheduleSave()
        return note.id
    }

    func createImageNote(_ payload: ImageImport.Payload, at point: CGPoint? = nil, columnId: String? = nil) {
        let column = columnId ?? (isKanban && point != nil ? MemableConstants.freeCanvasColumnId : primaryColumnId(for: currentGroupId))
        let location = point ?? defaultInsertionPoint()
        var width = 240.0
        var height = 200.0
        if let image = NSImage(data: payload.data), image.size.width > 0 {
            let size = image.size
            width = min(360.0, max(200.0, Double(size.width)))
            let aspect = Double(size.height) / Double(size.width)
            height = min(480.0, max(120.0, width * aspect + 40.0))
        }
        let now = ISOTime.now()
        let note = Note(groupId: currentGroupId, type: .image, imageData: payload.data, imageMimeType: payload.mime,
                        createdAt: now, updatedAt: now,
                        x: snap(max(0, location.x)), y: snap(max(0, location.y)), width: width, height: height,
                        color: defaultNoteColor, zIndex: nextZIndex(),
                        kanbanColumnId: column, kanbanOrder: nextKanbanOrder(groupId: currentGroupId, columnId: column))
        notes.append(note)
        scheduleSave()
    }

    func updateNote(_ id: String, touch: Bool = false, _ change: (inout Note) -> Void) {
        guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
        var note = notes[index]
        change(&note)
        if touch { note.touch() }
        guard note != notes[index] else { return }
        notes[index] = note
        scheduleSave()
    }

    func setContent(_ id: String, _ content: String) {
        updateNote(id) { $0.content = content }
    }

    func bringToFront(_ id: String) {
        guard let note = note(id), note.zIndex < maxZIndex - 1 else { return }
        let z = nextZIndex()
        updateNote(id) { $0.zIndex = z }
    }

    func setColor(_ id: String, _ color: NoteColor) {
        defaultNoteColor = color
        updateNote(id) { $0.color = color }
    }

    func deleteNote(_ id: String, undoManager: UndoManager?) {
        guard let note = note(id) else { return }
        notes.removeAll { $0.id == id }
        selectedNoteIds.remove(id)
        scheduleSave()
        undoManager?.registerUndo(withTarget: self) { store in
            MainActor.assumeIsolated { store.restoreNotes([note], undoManager: undoManager) }
        }
        undoManager?.setActionName("Delete Note")
        showToast("Note deleted. Press ⌘Z to undo.")
    }

    func restoreNotes(_ restored: [Note], undoManager: UndoManager?) {
        let existing = Set(notes.map(\.id))
        let toAdd = restored.filter { !existing.contains($0.id) }
        guard !toAdd.isEmpty else { return }
        notes.append(contentsOf: toAdd)
        scheduleSave()
        undoManager?.registerUndo(withTarget: self) { store in
            MainActor.assumeIsolated {
                let ids = Set(toAdd.map(\.id))
                store.notes.removeAll { ids.contains($0.id) }
                store.scheduleSave()
            }
        }
        showToast(toAdd.count == 1 ? "Note restored!" : "\(toAdd.count) notes restored!")
    }

    func clearCurrentGroup(undoManager: UndoManager?) {
        let removed = notes.filter { $0.groupId == currentGroupId }
        guard !removed.isEmpty,
              Alerts.confirm("Delete all notes in “\(currentGroup.name)”?", confirmTitle: "Delete All", destructive: true) else { return }
        notes.removeAll { $0.groupId == currentGroupId }
        selectedNoteIds = []
        scheduleSave()
        undoManager?.registerUndo(withTarget: self) { store in
            MainActor.assumeIsolated { store.restoreNotes(removed, undoManager: undoManager) }
        }
        undoManager?.setActionName("Clear All")
    }

    func toggleSelection(_ id: String) {
        if selectedNoteIds.contains(id) { selectedNoteIds.remove(id) } else { selectedNoteIds.insert(id) }
    }

    func copyNote(_ id: String) {
        guard let note = note(id) else { return }
        Clipboard.write(note)
        markCopied(id)
        showToast("Copied!")
    }

    /// In-window single-key shortcut. Returns true if a note was copied.
    @discardableResult
    func copyNote(forKey key: String) -> Bool {
        guard let note = note(forKey: key) else { return false }
        copyNote(note.id)
        return true
    }

    /// Global ⌘⌥key: copy the note, then paste into the frontmost app.
    func quickPaste(key: String) {
        guard let note = note(forKey: key) else { return }
        Clipboard.write(note)
        markCopied(note.id)
        guard SystemPaste.isTrusted else {
            SystemPaste.requestAccess()
            showToast("Copied. Allow memable in Accessibility settings to paste automatically.")
            return
        }
        // Give the user time to release ⌘⌥ so the target app receives a clean ⌘V.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            SystemPaste.pasteToFrontmostApp()
        }
    }

    /// ⌘V on the canvas: image → image note, text → text note.
    @discardableResult
    func pasteFromPasteboard() -> Bool {
        let pasteboard = NSPasteboard.general
        if let image = ImageImport.fromPasteboard(pasteboard) {
            createImageNote(image, at: lastPointerLocation)
            return true
        }
        if let text = pasteboard.string(forType: .string), !text.isEmpty {
            createTextNote(at: lastPointerLocation, columnId: isKanban ? primaryColumnId(for: currentGroupId) : nil,
                           content: text, focus: false)
            return true
        }
        return false
    }

    /// Handles files, images, plain text and in-app note drags dropped on the canvas.
    func handleDrop(_ providers: [NSItemProvider], at location: CGPoint) -> Bool {
        var handled = false
        for (index, provider) in providers.enumerated() {
            let point = CGPoint(x: location.x + Double(index) * 25, y: location.y + Double(index) * 25)
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                || provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                handled = true
                ImageImport.load(from: provider) { payload in
                    DispatchQueue.main.async {
                        guard let payload else { return }
                        MemableStore.shared.createImageNote(payload, at: point)
                    }
                }
            } else if provider.canLoadObject(ofClass: NSString.self) {
                handled = true
                _ = provider.loadObject(ofClass: NSString.self) { object, _ in
                    guard let text = object as? String else { return }
                    DispatchQueue.main.async {
                        let store = MemableStore.shared
                        if let noteId = NoteDragPayload.noteId(from: text) {
                            store.moveNoteToFreeCanvas(noteId, at: point)
                        } else if !text.isEmpty {
                            store.createTextNote(at: point, columnId: store.isKanban ? MemableConstants.freeCanvasColumnId : nil,
                                                 content: text, focus: false)
                        }
                    }
                }
            }
        }
        return handled
    }

    func alignNotes() {
        guard !isKanban else {
            showToast("Align is available in Canvas mode only")
            return
        }
        let sorted = currentNotes.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
        guard !sorted.isEmpty else { return }
        let margin = 40.0
        let spacing = 20.0
        var x = margin
        var y = margin
        var rowHeight = 0.0
        var positions: [String: (Double, Double)] = [:]
        for note in sorted {
            if x + note.width + margin > canvasViewportWidth && x > margin {
                x = margin
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions[note.id] = (x, y)
            x += note.width + spacing
            rowHeight = max(rowHeight, note.height)
        }
        for index in notes.indices {
            if let position = positions[notes[index].id] {
                notes[index].x = position.0
                notes[index].y = position.1
            }
        }
        scheduleSave()
        showToast("Notes aligned to grid")
    }

    // MARK: - Kanban

    func moveNoteToColumn(_ id: String, columnId: String) {
        guard let note = note(id) else { return }
        let order = nextKanbanOrder(groupId: note.groupId, columnId: columnId)
        updateNote(id, touch: true) {
            $0.kanbanColumnId = columnId
            $0.kanbanOrder = order
        }
    }

    func moveNoteToFreeCanvas(_ id: String, at point: CGPoint) {
        guard let note = note(id) else { return }
        let x = snap(max(0, point.x - note.width / 2))
        let y = snap(max(0, point.y - 18))
        let z = nextZIndex()
        updateNote(id, touch: true) {
            $0.kanbanColumnId = MemableConstants.freeCanvasColumnId
            $0.x = x
            $0.y = y
            $0.kanbanOrder = 0
            $0.zIndex = z
        }
    }

    func cardsInColumn(_ columnId: String) -> [Note] {
        currentNotes.filter { $0.kanbanColumnId == columnId }.sorted { $0.kanbanOrder < $1.kanbanOrder }
    }

    func updateKanbanColumns(groupId: String, columns nextColumns: [KanbanColumn]) {
        guard let groupIndex = groups.firstIndex(where: { $0.id == groupId }) else { return }
        let previous = Kanban.normalize(groups[groupIndex].kanbanColumns)
        let next = Kanban.normalize(nextColumns)
        guard previous != next else { return }
        let reassignment = Kanban.reassignmentMap(previous: previous, next: next)
        let nextIds = Set(next.map(\.id))
        groups[groupIndex].kanbanColumns = next

        var nextOrder: [String: Double] = [:]
        for note in notes where note.groupId == groupId && !note.isFreeCanvasInKanban
            && nextIds.contains(note.kanbanColumnId) && reassignment[note.kanbanColumnId] == nil {
            nextOrder[note.kanbanColumnId] = max(nextOrder[note.kanbanColumnId] ?? 0, note.kanbanOrder + 1)
        }
        let now = ISOTime.now()
        for index in notes.indices where notes[index].groupId == groupId && !notes[index].isFreeCanvasInKanban {
            let current = notes[index].kanbanColumnId
            let target = reassignment[current] ?? (nextIds.contains(current) ? current : next[0].id)
            if target != current {
                notes[index].kanbanColumnId = target
                notes[index].kanbanOrder = nextOrder[target] ?? 0
                notes[index].updatedAt = now
                nextOrder[target] = notes[index].kanbanOrder + 1
            }
        }
        // Compact order indexes per column.
        var byColumn: [String: [Int]] = [:]
        for index in notes.indices where notes[index].groupId == groupId && !notes[index].isFreeCanvasInKanban {
            byColumn[notes[index].kanbanColumnId, default: []].append(index)
        }
        for (_, indexes) in byColumn {
            for (order, index) in indexes.sorted(by: { notes[$0].kanbanOrder < notes[$1].kanbanOrder }).enumerated() {
                notes[index].kanbanOrder = Double(order)
            }
        }
        scheduleSave()
        showToast("Kanban steps updated")
    }

    // MARK: - Groups

    func switchGroup(_ id: String) {
        guard id != currentGroupId, group(id) != nil else { return }
        NSApp.keyWindow?.makeFirstResponder(nil)
        selectedNoteIds = []
        currentGroupId = id
    }

    func createGroup(named name: String) {
        let group = NoteGroup(id: IDGenerator.make(), name: name, order: groups.filter { $0.parentId == nil }.count)
        groups.append(group)
        scheduleSave()
        switchGroup(group.id)
    }

    func renameGroup(_ id: String, to name: String) {
        guard let index = groups.firstIndex(where: { $0.id == id }), !name.isEmpty else { return }
        groups[index].name = name
        scheduleSave()
    }

    func toggleViewMode(_ id: String) {
        guard let index = groups.firstIndex(where: { $0.id == id }) else { return }
        groups[index].viewMode = groups[index].viewMode == .kanban ? .canvas : .kanban
        scheduleSave()
    }

    func toggleCollapsed(_ id: String) {
        if collapsedGroupIds.contains(id) { collapsedGroupIds.remove(id) } else { collapsedGroupIds.insert(id) }
    }

    func deleteGroup(_ id: String) {
        guard id != MemableConstants.defaultGroupId, let deleted = group(id),
              Alerts.confirm("Delete group “\(deleted.name)” and all its notes?", message: "Child groups are kept and moved up one level.",
                             confirmTitle: "Delete", destructive: true) else { return }
        let replacementParent = deleted.parentId
        let children = groups.filter { $0.parentId == id }.sorted { $0.order < $1.order }
        let childIds = Set(children.map(\.id))
        groups.removeAll { $0.id == id }
        var siblings = groups.filter { $0.parentId == replacementParent && !childIds.contains($0.id) }.sorted { $0.order < $1.order }
        var promoted = children
        for index in promoted.indices { promoted[index].parentId = replacementParent }
        siblings.insert(contentsOf: promoted, at: min(deleted.order, siblings.count))
        for (order, sibling) in siblings.enumerated() {
            if let index = groups.firstIndex(where: { $0.id == sibling.id }) {
                groups[index].parentId = replacementParent
                groups[index].order = order
            }
        }
        notes.removeAll { $0.groupId == id }
        selectedNoteIds = selectedNoteIds.intersection(notes.map(\.id))
        if currentGroupId == id { currentGroupId = MemableConstants.defaultGroupId }
        scheduleSave()
    }

    func isDescendant(_ candidateId: String, of ancestorId: String) -> Bool {
        var current = group(candidateId)
        var visited = Set<String>()
        while let parent = current?.parentId, visited.insert(parent).inserted {
            if parent == ancestorId { return true }
            current = group(parent)
        }
        return false
    }

    func canDropGroup(_ draggedId: String, on targetId: String) -> Bool {
        draggedId != targetId && !isDescendant(targetId, of: draggedId)
    }

    func moveGroup(_ draggedId: String, onto targetId: String, position: GroupDropPosition) {
        guard canDropGroup(draggedId, on: targetId), let dragged = group(draggedId), let target = group(targetId) else { return }
        let oldParent = dragged.parentId
        let newParent = position == .inside ? target.id : target.parentId
        var siblings = groups.filter { $0.id != draggedId && $0.parentId == newParent }.sorted { $0.order < $1.order }
        let targetIndex: Int
        switch position {
        case .inside: targetIndex = siblings.count
        case .before: targetIndex = siblings.firstIndex { $0.id == targetId } ?? 0
        case .after: targetIndex = (siblings.firstIndex { $0.id == targetId } ?? siblings.count - 1) + 1
        }
        var moved = dragged
        moved.parentId = newParent
        siblings.insert(moved, at: max(0, min(targetIndex, siblings.count)))
        for (order, sibling) in siblings.enumerated() {
            if let index = groups.firstIndex(where: { $0.id == sibling.id }) {
                groups[index].parentId = newParent
                groups[index].order = order
            }
        }
        if oldParent != newParent {
            let oldSiblings = groups.filter { $0.parentId == oldParent }.sorted { $0.order < $1.order }
            for (order, sibling) in oldSiblings.enumerated() {
                if let index = groups.firstIndex(where: { $0.id == sibling.id }) { groups[index].order = order }
            }
        }
        if position == .inside { collapsedGroupIds.remove(targetId) }
        scheduleSave()
    }

    // MARK: - Links & context export

    func openInternalLink(_ reference: String) {
        let normalized = reference.trimmingCharacters(in: .whitespaces).lowercased()
        guard let target = notes.first(where: { $0.id == reference })
            ?? notes.first(where: { $0.title.lowercased() == normalized }) else {
            showToast("Note not found: \(reference)")
            return
        }
        if target.groupId != currentGroupId { switchGroup(target.groupId) }
        highlightedNoteId = target.id
        scrollRequestNoteId = target.id
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            if self?.highlightedNoteId == target.id { self?.highlightedNoteId = nil }
        }
    }

    func contextExport(includeChildren: Bool, options: ContextExporter.Options) -> (scope: String, count: Int, markdown: String) {
        let selected: [Note]
        let scope: String
        if !selectedNoteIds.isEmpty {
            selected = notes.filter { selectedNoteIds.contains($0.id) }
            scope = "\(selectedNoteIds.count) selected note(s)"
        } else {
            let ids = includeChildren ? Normalizer.descendantIds(of: currentGroupId, in: groups) : [currentGroupId]
            selected = notes.filter { ids.contains($0.groupId) }
            scope = includeChildren ? "Current group and child groups" : "Current group"
        }
        return (scope, selected.count, ContextExporter.markdown(notes: selected, groups: groups, options: options))
    }
}

/// String payload used when dragging notes inside the app.
enum NoteDragPayload {
    static func string(for id: String) -> String { "memable-note:\(id)" }

    static func noteId(from string: String) -> String? {
        string.hasPrefix("memable-note:") ? String(string.dropFirst("memable-note:".count)) : nil
    }
}
