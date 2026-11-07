import AppKit
import MemableCore
import SwiftUI

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

    var body: some View {
        Group {
            if isEditing {
                PlainTextEditor(
                    text: Binding(get: { store.note(note.id)?.content ?? "" },
                                  set: { store.setContent(note.id, $0); didChange($0) }),
                    onEndEditing: endEditing
                )
                .frame(height: fillsFrame ? nil : editorHeight)
            } else if fillsFrame {
                ScrollView(.vertical) { preview }
                    .scrollIndicators(.automatic)
            } else {
                preview
                    .frame(maxHeight: 240, alignment: .top)
                    .clipped()
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
            return .systemAction
        })
    }
}

enum MarkdownRenderer {
    static let internalScheme = "memable-note"

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

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
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
