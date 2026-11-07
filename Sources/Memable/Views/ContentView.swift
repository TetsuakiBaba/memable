import AppKit
import MemableCore
import SwiftUI

struct ContentView: View {
    @Environment(MemableStore.self) private var store
    @Environment(\.undoManager) private var undoManager

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 160, ideal: 210, max: 480)
        } detail: {
            WorkspaceView()
                .background(Theme.surface)
        }
        .navigationTitle(store.currentGroup.name)
        .navigationSubtitle(store.currentGroup.viewMode == .kanban ? "Kanban" : "Canvas")
        .toolbar { toolbarContent }
        .sheet(item: $store.activeSheet) { sheet in
            sheetView(sheet)
                .environment(store)
        }
        .overlay(alignment: .bottom) {
            if let toast = store.toast {
                Text(toast.message)
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .shadow(radius: 4, y: 2)
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .id(toast.id)
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeOut(duration: 0.2), value: store.toast)
        .background(WindowAccessor { window in store.mainWindow = window })
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        @Bindable var store = store
        ToolbarItemGroup(placement: .principal) {
            Picker("Mode", selection: Binding(
                get: { store.currentGroup.viewMode },
                set: { mode in if mode != store.currentGroup.viewMode { store.toggleViewMode(store.currentGroupId) } }
            )) {
                Label("Canvas", systemImage: "note.text").tag(ViewMode.canvas)
                Label("Kanban", systemImage: "rectangle.split.3x1").tag(ViewMode.kanban)
            }
            .pickerStyle(.segmented)
            .help("Switch between free canvas and Kanban board")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Toggle(isOn: $store.isGridSnap) {
                Label("Grid", systemImage: "grid")
            }
            .help("Grid Snap (\(store.isGridSnap ? "ON" : "OFF"))")

            Button { store.alignNotes() } label: {
                Label("Align Notes", systemImage: "square.grid.2x2")
            }
            .help("Align Notes")
            .disabled(store.isKanban)

            ControlGroup {
                Button { store.zoomPercent = max(50, store.zoomPercent - 10) } label: {
                    Label("Zoom Out", systemImage: "minus.magnifyingglass")
                }
                .help("Zoom Out (⌘-)")
                Button { store.zoomPercent = 100 } label: {
                    Text("\(store.zoomPercent)%").monospacedDigit().frame(minWidth: 40)
                }
                .help("Actual Size (⌘0)")
                Button { store.zoomPercent = min(200, store.zoomPercent + 10) } label: {
                    Label("Zoom In", systemImage: "plus.magnifyingglass")
                }
                .help("Zoom In (⌘+)")
            }

            Button { store.activeSheet = .contextExport } label: {
                Label(store.selectedNoteIds.isEmpty ? "Context" : "Context (\(store.selectedNoteIds.count))",
                      systemImage: "sparkles")
                    .labelStyle(.titleAndIcon)
            }
            .help("Export LLM Context (⇧⌘E)")

            Button { store.activeSheet = .help } label: {
                Label("Help", systemImage: "questionmark.circle")
            }
            .help("Manual / Help")

            SettingsLink {
                Label("Settings", systemImage: "gearshape")
            }
            .help("Settings (⌘,)")

            Button(role: .destructive) { store.clearCurrentGroup(undoManager: undoManager) } label: {
                Label("Clear All (\(store.currentNotes.count))", systemImage: "trash")
                    .labelStyle(.titleAndIcon)
            }
            .help("Delete all notes in this group")
            .disabled(store.currentNotes.isEmpty)
        }
    }

    @ViewBuilder
    private func sheetView(_ sheet: ActiveSheet) -> some View {
        switch sheet {
        case .newGroup:
            TextPromptSheet(title: "New Group", initialValue: "", placeholder: "Enter name…", allowEmpty: false) { name in
                store.createGroup(named: name)
            }
        case .renameGroup(let id):
            TextPromptSheet(title: "Rename Group", initialValue: store.group(id)?.name ?? "", placeholder: "Enter name…",
                            allowEmpty: false) { name in
                store.renameGroup(id, to: name)
            }
        case .noteTitle(let id):
            TextPromptSheet(title: "Edit Note Title", initialValue: store.note(id)?.title ?? "",
                            placeholder: "Leave blank to show number only", allowEmpty: true) { title in
                store.updateNote(id, touch: true) { $0.title = Normalizer.normalizeTitle(title) }
            }
        case .noteMetadata(let id):
            NoteMetadataSheet(noteId: id)
        case .kanbanSteps(let id):
            KanbanStepsSheet(groupId: id)
        case .contextExport:
            ContextExportSheet()
        case .imagePreview(let id):
            ImagePreviewSheet(noteId: id)
        case .help:
            HelpView()
        }
    }
}

/// Gives the store access to the hosting NSWindow (used for key handling).
struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow?) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { onWindow(view.window) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { onWindow(nsView.window) }
    }
}
