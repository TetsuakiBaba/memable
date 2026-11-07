import AppKit
import MemableCore
import SwiftUI
import UniformTypeIdentifiers

/// Single text field prompt (new group, rename group, note title).
struct TextPromptSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let initialValue: String
    let placeholder: String
    let allowEmpty: Bool
    let onSave: (String) -> Void
    @State private var value = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.headline)
            TextField(placeholder, text: $value)
                .textFieldStyle(.roundedBorder)
                .frame(width: 300)
                .onSubmit(save)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save", action: save)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!allowEmpty && trimmed.isEmpty)
            }
        }
        .padding(20)
        .onAppear { value = initialValue }
    }

    private var trimmed: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func save() {
        guard allowEmpty || !trimmed.isEmpty else { return }
        onSave(trimmed)
        dismiss()
    }
}

struct NoteMetadataSheet: View {
    @Environment(MemableStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let noteId: String
    @State private var title = ""
    @State private var tags = ""
    @State private var sourceURL = ""

    var body: some View {
        let note = store.note(noteId)
        VStack(alignment: .leading, spacing: 14) {
            Text("Note Metadata").font(.headline)
            Form {
                TextField("Title", text: $title)
                TextField("Tags", text: $tags, prompt: Text("project, idea, important"))
                TextField("Source URL", text: $sourceURL, prompt: Text("https://example.com"))
            }
            .frame(width: 380)
            Text("Created: \(note?.createdAt ?? "-") · Updated: \(note?.updatedAt ?? "-")")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            Text("Tags are comma separated. ID: \(noteId)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    let url = sourceURL.trimmingCharacters(in: .whitespacesAndNewlines)
                    store.updateNote(noteId, touch: true) {
                        $0.title = Normalizer.normalizeTitle(title)
                        $0.tags = Normalizer.normalizeTags(tags.components(separatedBy: ","))
                        $0.source = NoteSource(type: url.isEmpty ? "manual" : "url", url: url.isEmpty ? nil : url)
                    }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .onAppear {
            title = note?.title ?? ""
            tags = note?.tags.joined(separator: ", ") ?? ""
            sourceURL = note?.source.url ?? ""
        }
    }
}

struct KanbanStepsSheet: View {
    @Environment(MemableStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let groupId: String
    @State private var steps: [KanbanColumn] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Kanban Steps").font(.headline)
            Text("ToDo と Done は固定です。中間ステップだけ名称変更と追加・削除ができます。")
                .font(.callout)
                .foregroundStyle(.secondary)
            fixedStage("ToDo")
            if steps.isEmpty {
                Text("中間ステップなし。ToDo から Done へ直接移動します。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(10)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(style: StrokeStyle(lineWidth: 1, dash: [4])).foregroundStyle(.secondary))
            }
            ForEach($steps) { $step in
                HStack {
                    TextField("Step", text: $step.name)
                        .textFieldStyle(.roundedBorder)
                    Button("Remove") { steps.removeAll { $0.id == step.id } }
                }
            }
            Button {
                steps.append(KanbanColumn(id: IDGenerator.make(), name: "Step \(steps.count + 1)"))
            } label: {
                Label("Add Step", systemImage: "plus")
            }
            fixedStage("Done")
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save") {
                    let middle = steps.enumerated().map { index, step in
                        KanbanColumn(id: step.id, name: step.name.trimmingCharacters(in: .whitespaces).isEmpty
                                     ? "Step \(index + 1)" : step.name.trimmingCharacters(in: .whitespaces))
                    }
                    store.updateKanbanColumns(groupId: groupId, columns: Kanban.build(middle: middle))
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 400)
        .onAppear { steps = Kanban.middle(of: store.group(groupId)?.kanbanColumns ?? Kanban.defaultColumns()) }
    }

    private func fixedStage(_ name: String) -> some View {
        Text(name)
            .font(.callout.weight(.semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Theme.secondaryContainer, in: Capsule())
    }
}

struct ContextExportSheet: View {
    @Environment(MemableStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var includeChildren = false
    @State private var includeDone = true
    @State private var includeImages = false
    @State private var instruction = ""

    var body: some View {
        let result = store.contextExport(includeChildren: includeChildren,
                                         options: .init(includeDone: includeDone, includeImages: includeImages, instruction: instruction))
        VStack(alignment: .leading, spacing: 12) {
            Text("Export LLM Context").font(.headline)
            Text("\(result.scope) · \(result.count) note(s)")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack(spacing: 18) {
                Toggle("Include child groups", isOn: $includeChildren)
                    .disabled(!store.selectedNoteIds.isEmpty)
                Toggle("Include Done", isOn: $includeDone)
                Toggle("Include image data", isOn: $includeImages)
            }
            .toggleStyle(.checkbox)
            VStack(alignment: .leading, spacing: 4) {
                Text("Instruction (optional)").font(.callout)
                TextField("Summarize decisions and extract open questions.", text: $instruction, axis: .vertical)
                    .lineLimit(2...4)
                    .textFieldStyle(.roundedBorder)
            }
            ScrollView {
                Text(result.markdown)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(8)
            }
            .frame(minHeight: 320)
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
            HStack {
                if !store.selectedNoteIds.isEmpty {
                    Button("Clear Selection") { store.selectedNoteIds = [] }
                }
                Spacer()
                Button("Close", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save .md…") { save(result.markdown) }
                Button("Copy Markdown") {
                    Clipboard.write(text: result.markdown)
                    store.showToast("Context Markdown copied")
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 720, height: 620)
        .onExitCommand { dismiss() } // Escape, even while the multi-line field has focus
    }

    private func save(_ markdown: String) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = "memable_context_\(ISOTime.now().prefix(10)).md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try Data(markdown.utf8).write(to: url, options: .atomic)
            store.showToast("Saved \(url.lastPathComponent)")
        } catch {
            Alerts.info("Save failed", message: error.localizedDescription)
        }
    }
}

struct ImagePreviewSheet: View {
    @Environment(MemableStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let noteId: String

    var body: some View {
        VStack(spacing: 0) {
            if let note = store.note(noteId), let image = ImageCache.shared.image(for: note) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: min(image.size.width, 1200), maxHeight: min(image.size.height, 800))
                    .padding(12)
            } else {
                Text("Image unavailable").padding(40)
            }
            HStack {
                Spacer()
                Button("Copy") { store.copyNote(noteId) }
                Button("Close") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding([.horizontal, .bottom], 12)
        }
        .frame(minWidth: 320, minHeight: 240)
        .onTapGesture { dismiss() }
    }
}

struct HelpView: View {
    @Environment(\.dismiss) private var dismiss

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading) {
                    Text("memable").font(.title2.weight(.semibold))
                    Text("v\(version)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Link(destination: URL(string: "https://github.com/TetsuakiBaba/memable")!) {
                    Label("GitHub", systemImage: "chevron.left.forwardslash.chevron.right")
                }
            }
            .padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    section("Basic Operations", [
                        ("Create Note", "Double-click on the background, or ⌘N"),
                        ("Move", "Drag the note header"),
                        ("Resize", "Drag the bottom-right corner"),
                        ("Edit", "Click the note text. Click outside or press Esc to preview Markdown"),
                        ("Add Images / Text", "Drag & drop, or paste with ⌘V while not editing"),
                        ("Undo Delete", "⌘Z restores deleted notes"),
                        ("Metadata", "Tag icon: title, tags and source URL; double-click the header title to rename")
                    ])
                    section("Markdown", [
                        ("Supported", "# headings, - / 1. lists, > quotes, ``` code, `inline`, **bold**, [links](https://…)"),
                        ("Internal links", "[[Note Title]] or [[note-id]] jumps to the note")
                    ])
                    section("Keyboard Shortcuts", [
                        ("[1-0], [a-z]", "Copy the note with that key (when not editing)"),
                        ("⌘ + / − / 0", "Zoom in / out / reset"),
                        ("⌥⌘G / ⌥⌘L / ⌥⌘K", "Grid snap / Align notes / Canvas ⇄ Kanban"),
                        ("⌘⌥ [1-0 / a-z]", "Global Quick Paste: copy the note and paste into the frontmost app (enable in Settings)")
                    ])
                    section("Groups", [
                        ("Rename", "Double-click a group in the sidebar"),
                        ("Reorder / Nest", "Drag a group above, below, or onto another group"),
                        ("Kanban Steps", "Slider icon on a group (or right-click) to rename / add intermediate steps"),
                        ("Kanban", "Drag cards by their header between columns; drop outside the columns to place a free note")
                    ])
                    section("LLM Context Export", [
                        ("Context", "Exports the current group, or only the notes selected with their checkbox (⌘-click a header)"),
                        ("Options", "Child groups, Done column, image data and an instruction for the receiving LLM")
                    ])
                    section("Sync", [
                        ("External folder", "Settings → Storage: choose a Dropbox / iCloud folder. Notes are saved as one Markdown file each and changes from other Macs are picked up live")
                    ])
                }
                .padding(20)
            }
            Divider()
            HStack {
                Spacer()
                Button("Close") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .frame(width: 620, height: 600)
    }

    private func section(_ title: String, _ rows: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            ForEach(rows, id: \.0) { row in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(row.0).fontWeight(.semibold).frame(width: 150, alignment: .leading)
                    Text(row.1).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                .font(.callout)
            }
        }
    }
}

struct SettingsView: View {
    @Environment(MemableStore.self) private var store
    @State private var accessibilityTrusted = SystemPaste.isTrusted

    var body: some View {
        @Bindable var store = store
        Form {
            Section("Appearance") {
                Picker("Theme", selection: $store.appearance) {
                    ForEach(AppearanceMode.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            Section {
                Toggle("Global Quick Paste (⌘⌥ + [1-0 / a-z])", isOn: $store.globalShortcutsEnabled)
                HStack {
                    Image(systemName: accessibilityTrusted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(accessibilityTrusted ? .green : .orange)
                    Text(accessibilityTrusted ? "Accessibility access granted" : "Accessibility access is needed to paste automatically")
                    Spacer()
                    if !accessibilityTrusted {
                        Button("Grant…") {
                            SystemPaste.requestAccess()
                            SystemPaste.openAccessibilitySettings()
                        }
                    }
                }
                .font(.callout)
            } header: {
                Text("Shortcuts")
            } footer: {
                Text("Copies the note content to the clipboard and pastes it at the cursor of the frontmost app.")
            }
            Section {
                LabeledContent("Location") {
                    Text(store.storageDescription)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                HStack {
                    Button("Choose Sync Folder…") { store.chooseExternalFolder() }
                    if store.externalPath != nil {
                        Button("Stop Syncing") { store.useLocalStorage() }
                    }
                    Spacer()
                    Button("Show in Finder") { store.revealStorageFolder() }
                }
            } header: {
                Text("Storage")
            } footer: {
                Text("Sync with an external folder (Dropbox, iCloud Drive …). Each note is a Markdown file in notes/, images go to assets/, and layout.json keeps positions.")
            }
            Section("Data Backup") {
                HStack {
                    Button("Export JSON…") { store.exportJSON() }
                    Button("Import JSON…") { store.importJSON() }
                }
            }
            Section {
                Button("Reset to Default…", role: .destructive) { store.resetEverything() }
            } header: {
                Text("Initialization")
            } footer: {
                Text("Clears all local notes and settings.")
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            accessibilityTrusted = SystemPaste.isTrusted
        }
    }
}
