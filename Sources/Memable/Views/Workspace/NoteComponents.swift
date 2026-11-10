import AppKit
import MemableCore
import SwiftUI
import UniformTypeIdentifiers

enum NoteLayout {
    static let headerHeight: CGFloat = 36
    static let minWidth: Double = 230
    static let minHeight: Double = 100
    static let textFont = NSFont.systemFont(ofSize: 13)
    static let textInset = NSSize(width: 8, height: 10)
}

/// Header shared by canvas notes and Kanban cards: key badge, title, colors and actions.
struct NoteHeaderView: View {
    @Environment(MemableStore.self) private var store
    @Environment(\.undoManager) private var undoManager
    let note: Note
    /// Width of the note/card; narrow headers collapse the color swatches into a menu.
    var width: CGFloat
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            if let key = store.keyIdsByNoteId[note.id] {
                Text(key)
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.black.opacity(0.1)))
                    .fixedSize()
                    .help("Shortcut key: \(key)")
            }
            Text(note.title.isEmpty ? " " : note.title)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { store.activeSheet = .noteTitle(note.id) }
                .help(note.title.isEmpty ? "Double-click to add a title" : note.title)

            HStack(spacing: 6) {
                if width >= (compact ? 320 : 360) { colorSwatches } else { colorMenu }
                actionButtons
            }
            .fixedSize()
        }
        .padding(.horizontal, 10)
        .frame(height: NoteLayout.headerHeight)
        .background(Color.black.opacity(0.05))
        .foregroundStyle(Theme.noteText)
    }

    private var colorSwatches: some View {
        HStack(spacing: 3) {
            ForEach(NoteColor.allCases) { color in
                Circle()
                    .fill(color.swiftUIColor)
                    .overlay(Circle().stroke(Color.black.opacity(color == note.color ? 0.7 : 0.2), lineWidth: color == note.color ? 1.5 : 0.5))
                    .frame(width: compact ? 11 : 13, height: compact ? 11 : 13)
                    .contentShape(Circle())
                    .onTapGesture { store.setColor(note.id, color) }
                    .help(color.rawValue.capitalized)
            }
        }
    }

    private var colorMenu: some View {
        Menu {
            ForEach(NoteColor.allCases) { color in
                Button(color.rawValue.capitalized) { store.setColor(note.id, color) }
            }
        } label: {
            Circle().fill(note.color.swiftUIColor)
                .overlay(Circle().stroke(Color.black.opacity(0.5), lineWidth: 1))
                .frame(width: 13, height: 13)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
        .help("Color")
    }

    private var actionButtons: some View {
        HStack(spacing: 2) {
            if store.isKanban && note.isFreeCanvasInKanban {
                iconButton("rectangle.split.3x1", help: "Move back to the ToDo column") {
                    store.moveNoteToColumn(note.id, columnId: store.primaryColumnId(for: note.groupId))
                }
            }
            iconButton(store.selectedNoteIds.contains(note.id) ? "checkmark.square.fill" : "square",
                       help: "Select for Context Export (or ⌘-click the header)") {
                store.toggleSelection(note.id)
            }
            iconButton("tag", help: note.tags.isEmpty ? "Edit title, tags, and source" : "Tags: \(note.tags.joined(separator: ", "))") {
                store.activeSheet = .noteMetadata(note.id)
            }
            iconButton(store.copiedNoteIds.contains(note.id) ? "checkmark" : "doc.on.doc", help: "Copy") {
                store.copyNote(note.id)
            }
            iconButton("trash", help: "Delete (⌘Z to undo)", tint: Color(hex: 0xB3261E)) {
                store.deleteNote(note.id, undoManager: undoManager)
            }
        }
    }

    private func iconButton(_ systemName: String, help: String, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 12))
                .foregroundStyle(tint ?? Theme.noteText)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// Markdown preview that turns into a plain-text editor on click.
struct NoteTextBody: View {
    @Environment(MemableStore.self) private var store
    let note: Note
    /// Canvas notes fill their frame and grow taller while typing; Kanban cards size to content.
    var fillsFrame: Bool
    var contentWidth: CGFloat = 300

    @State private var isEditing = false
    @State private var originalContent = ""
    @State private var isFileDropTargeted = false

    var body: some View {
        Group {
            if isEditing {
                PlainTextEditor(
                    text: Binding(get: { store.note(note.id)?.content ?? "" },
                                  set: { store.setContent(note.id, $0); didChange($0) }),
                    onEndEditing: endEditing,
                    onDropFiles: { urls, insert in store.importAttachments(urls) { insert($0.joined(separator: "\n")) } }
                )
                .frame(height: fillsFrame ? nil : editorHeight)
            } else if fillsFrame {
                ScrollView(.vertical) { preview }
                    .scrollIndicators(.automatic)
                    .modifier(fileDrop)
            } else {
                preview
                    .frame(maxHeight: 240, alignment: .top)
                    .clipped()
                    .modifier(fileDrop)
            }
        }
        .onAppear { if store.focusRequestNoteId == note.id { beginEditing() } }
        .onChange(of: store.focusRequestNoteId) { _, id in if id == note.id { beginEditing() } }
    }

    private var preview: some View {
        MarkdownPreview(markdown: note.content)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .contentShape(Rectangle())
            .onTapGesture {
                // Let a link click (handled by OpenURLAction) win over entering edit mode.
                let clickTime = Date()
                DispatchQueue.main.async {
                    if store.lastLinkOpen.map({ clickTime.timeIntervalSince($0) < 0.5 }) != true { beginEditing() }
                }
            }
    }

    /// Dropping files on the preview saves them to `files/` and appends Markdown links.
    private var fileDrop: FileDropModifier {
        FileDropModifier(isTargeted: $isFileDropTargeted) { urls in store.attachFiles(urls, to: note.id) }
    }

    private var editorHeight: CGFloat {
        min(240, max(60, textHeight(store.note(note.id)?.content ?? "", width: contentWidth) + NoteLayout.textInset.height * 2 + 4))
    }

    private func textHeight(_ text: String, width: CGFloat) -> CGFloat {
        let measured = (text.isEmpty ? " " : text + (text.hasSuffix("\n") ? " " : "")) as NSString
        return ceil(measured.boundingRect(with: NSSize(width: max(40, width), height: .greatestFiniteMagnitude),
                                          options: [.usesLineFragmentOrigin, .usesFontLeading],
                                          attributes: [.font: NoteLayout.textFont]).height)
    }

    private func beginEditing() {
        guard !isEditing else { return }
        originalContent = note.content
        isEditing = true
        store.editingNoteId = note.id
        if store.focusRequestNoteId == note.id { store.focusRequestNoteId = nil }
    }

    private func endEditing() {
        guard isEditing else { return }
        isEditing = false
        if (store.note(note.id)?.content ?? "") != originalContent {
            store.updateNote(note.id, touch: true) { _ in }
        }
        if store.editingNoteId == note.id { store.editingNoteId = nil }
    }

    /// Grows a canvas note when its text no longer fits (never shrinks it).
    private func didChange(_ text: String) {
        guard fillsFrame, let current = store.note(note.id) else { return }
        let width = current.width - NoteLayout.textInset.width * 2 - 18
        let required = Double(NoteLayout.headerHeight + textHeight(text, width: width) + NoteLayout.textInset.height * 2 + 22)
        guard required > current.height + 1 else { return }
        let height = store.isGridSnap ? ceil(required / MemableConstants.gridSize) * MemableConstants.gridSize : ceil(required)
        store.updateNote(note.id) { $0.height = height }
    }
}

/// Renders the note Markdown subset as styled text with clickable links.
struct MarkdownPreview: View {
    @Environment(MemableStore.self) private var store
    let markdown: String

    var body: some View {
        Group {
            if markdown.isEmpty {
                Text("Empty note — click to edit")
                    .foregroundStyle(Theme.noteText.opacity(0.45))
                    .italic()
            } else {
                Text(MarkdownRenderer.attributedString(markdown))
                    .foregroundStyle(Theme.noteText)
                    .tint(Theme.internalLink)
            }
        }
        .font(.system(size: 13))
        .lineSpacing(2)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .environment(\.openURL, OpenURLAction { url in
            store.lastLinkOpen = Date()
            if url.scheme == MarkdownRenderer.internalScheme {
                let reference = url.host(percentEncoded: false) ?? url.path(percentEncoded: false)
                store.openInternalLink(reference.removingPercentEncoding ?? reference)
                return .handled
            }
            if url.scheme == MarkdownRenderer.fileScheme {
                store.openAttachment(String(url.absoluteString.dropFirst(MarkdownRenderer.fileScheme.count + 1)))
                return .handled
            }
            return .systemAction
        })
    }
}

enum MarkdownRenderer {
    static let internalScheme = "memable-note"
    /// `memable-file:<relative path>` wraps `../files/…` links so the store can resolve them.
    static let fileScheme = "memable-file"

    static func attributedString(_ markdown: String) -> AttributedString {
        var result = AttributedString()
        let blocks = MarkdownParser.parse(markdown)
        for (index, block) in blocks.enumerated() {
            if index > 0 { result += AttributedString("\n") }
            result += render(block)
        }
        return result
    }

    private static func render(_ block: MarkdownParser.Block) -> AttributedString {
        switch block {
        case .heading(let level, let inlines):
            var text = inline(inlines)
            text.font = .system(size: level <= 2 ? 15 : 14, weight: .bold)
            return text
        case .bullet(let inlines):
            return AttributedString("•  ") + inline(inlines)
        case .numbered(let number, let inlines):
            return AttributedString("\(number).  ") + inline(inlines)
        case .quote(let inlines):
            var bar = AttributedString("▍ ")
            bar.foregroundColor = Theme.noteText.opacity(0.35)
            var text = inline(inlines)
            text.foregroundColor = Theme.noteText.opacity(0.75)
            return bar + text
        case .code(let code):
            var text = AttributedString(code.isEmpty ? " " : code)
            text.font = .system(size: 12, design: .monospaced)
            text.backgroundColor = Color.black.opacity(0.08)
            return text
        case .blank:
            return AttributedString("")
        case .paragraph(let inlines):
            return inline(inlines)
        }
    }

    private static func inline(_ inlines: [MarkdownParser.Inline]) -> AttributedString {
        var result = AttributedString()
        for item in inlines {
            switch item {
            case .text(let text):
                result += AttributedString(text)
            case .bold(let text):
                var part = AttributedString(text)
                part.font = .system(size: 13, weight: .bold)
                result += part
            case .code(let text):
                var part = AttributedString(text)
                part.font = .system(size: 12, design: .monospaced)
                part.backgroundColor = Color.black.opacity(0.08)
                result += part
            case .link(let label, let url):
                var part = AttributedString(label)
                part.link = URL(string: url)
                part.underlineStyle = .single
                result += part
            case .fileLink(let label, let path):
                var part = AttributedString("📎 " + label)
                let encoded = (path.removingPercentEncoding ?? path).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
                part.link = URL(string: "\(fileScheme):\(encoded)")
                part.underlineStyle = .single
                result += part
            case .internalLink(let reference):
                var part = AttributedString(reference)
                var components = URLComponents()
                components.scheme = internalScheme
                components.host = reference
                part.link = components.url
                part.underlineStyle = .single
                result += part
            }
        }
        return result
    }
}

/// Plain-text NSTextView: no rich text, no smart quotes/dashes, focuses itself on appear.
struct PlainTextEditor: NSViewRepresentable {
    @Binding var text: String
    var onEndEditing: () -> Void
    /// Files dropped into the editor; call the closure with the Markdown to insert at the drop point.
    var onDropFiles: (([URL], @escaping (String) -> Void) -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        let textView = FileDropTextView()
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        scrollView.documentView = textView
        textView.onDropFiles = { [weak coordinator = context.coordinator] urls, insert in
            coordinator?.parent.onDropFiles?(urls, insert) ?? insert(urls.map(\.path).joined(separator: "\n"))
        }
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticLinkDetectionEnabled = false
        textView.drawsBackground = false
        textView.font = NoteLayout.textFont
        textView.textColor = Theme.noteTextNS
        textView.insertionPointColor = Theme.noteTextNS
        textView.textContainerInset = NoteLayout.textInset
        textView.string = text
        textView.delegate = context.coordinator
        DispatchQueue.main.async {
            textView.window?.makeFirstResponder(textView)
            textView.setSelectedRange(NSRange(location: (textView.string as NSString).length, length: 0))
            textView.scrollRangeToVisible(textView.selectedRange())
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? NSTextView, textView.string != text else { return }
        let selection = textView.selectedRanges
        textView.string = text
        textView.selectedRanges = selection
    }

    /// NSTextView that hands dropped file URLs to `onDropFiles` instead of inserting their paths.
    final class FileDropTextView: NSTextView {
        var onDropFiles: (([URL], @escaping (String) -> Void) -> Void)?

        override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
            guard let onDropFiles,
                  let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                                   options: [.urlReadingFileURLsOnly: true]) as? [URL],
                  !urls.isEmpty else { return super.performDragOperation(sender) }
            let index = characterIndexForInsertion(at: convert(sender.draggingLocation, from: nil))
            window?.makeFirstResponder(self)
            onDropFiles(urls) { [weak self] markdown in
                guard let self else { return }
                let length = (self.string as NSString).length
                let location = min(max(0, index), length)
                let range = NSRange(location: location, length: 0)
                guard self.shouldChangeText(in: range, replacementString: markdown) else { return }
                self.replaceCharacters(in: range, with: markdown)
                self.didChangeText()
                self.setSelectedRange(NSRange(location: location + (markdown as NSString).length, length: 0))
            }
            return true
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: PlainTextEditor

        init(_ parent: PlainTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
        }

        func textDidEndEditing(_ notification: Notification) {
            parent.onEndEditing()
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            if selector == #selector(NSResponder.cancelOperation(_:)) {
                textView.window?.makeFirstResponder(nil)
                return true
            }
            return false
        }
    }
}

struct ImageNoteBody: View {
    @Environment(MemableStore.self) private var store
    let note: Note

    var body: some View {
        Group {
            if let image = ImageCache.shared.image(for: note) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Label("Image unavailable", systemImage: "photo")
                    .foregroundStyle(Theme.noteText.opacity(0.5))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(8)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { store.activeSheet = .imagePreview(note.id) }
        .help("Double-click to enlarge")
    }
}

extension Note {
    var sizeDescription: String {
        if type == .image { return "\(imageData?.count ?? 0) bytes" }
        return "\(content.count) chars / \(content.utf8.count) bytes"
    }
}

/// Accepts file drops from Finder (in-app note drags and plain text are left to the canvas).
struct FileDropModifier: ViewModifier {
    @Binding var isTargeted: Bool
    let onDrop: ([URL]) -> Void

    func body(content: Content) -> some View {
        content
            .onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
                let fileProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
                guard !fileProviders.isEmpty else { return false }
                let group = DispatchGroup()
                let lock = NSLock()
                var urls: [(Int, URL)] = []
                for (index, provider) in fileProviders.enumerated() {
                    group.enter()
                    _ = provider.loadObject(ofClass: URL.self) { url, _ in
                        if let url {
                            lock.lock()
                            urls.append((index, url))
                            lock.unlock()
                        }
                        group.leave()
                    }
                }
                group.notify(queue: .main) {
                    let sorted = urls.sorted { $0.0 < $1.0 }.map(\.1)
                    if !sorted.isEmpty { onDrop(sorted) }
                }
                return true
            }
            .overlay {
                if isTargeted {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Theme.primary, style: StrokeStyle(lineWidth: 2, dash: [5, 3]))
                        .background(Theme.primary.opacity(0.08))
                        .overlay(Label("Save file & insert link", systemImage: "paperclip")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.primary))
                        .padding(4)
                        .allowsHitTesting(false)
                }
            }
    }
}
