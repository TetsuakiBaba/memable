import Foundation

/// Builds LLM-ready Markdown from notes (port of `buildContextMarkdown`).
public enum ContextExporter {
    public struct Options: Equatable, Sendable {
        public var includeDone: Bool
        public var includeImages: Bool
        public var instruction: String

        public init(includeDone: Bool = true, includeImages: Bool = false, instruction: String = "") {
            self.includeDone = includeDone
            self.includeImages = includeImages
            self.instruction = instruction
        }
    }

    public static func markdown(notes: [Note], groups: [NoteGroup], options: Options, exportedAt: Date = Date()) -> String {
        var lines: [String] = []
        let instruction = options.instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        if !instruction.isEmpty {
            lines += ["# Instruction", "", instruction, ""]
        }
        lines += ["# Memable Context", "", "Exported: \(ISOTime.string(from: exportedAt))", ""]

        func imageText(_ note: Note) -> String {
            options.includeImages ? (note.imageDataURL ?? "") : "[Image note omitted]"
        }

        for (group, _) in Normalizer.treeOrder(Normalizer.normalizeHierarchy(groups)) {
            let groupNotes = notes.filter { $0.groupId == group.id }
            guard !groupNotes.isEmpty else { continue }
            lines += ["## \(group.name)", ""]
            let columns = Kanban.normalize(group.kanbanColumns)
            for column in columns {
                let columnNotes = groupNotes
                    .filter { $0.kanbanColumnId == column.id }
                    .sorted { $0.kanbanOrder < $1.kanbanOrder }
                if columnNotes.isEmpty || (!options.includeDone && column.id == columns.last?.id) { continue }
                lines += ["### \(column.name)", ""]
                for note in columnNotes {
                    lines.append("#### \(note.displayTitle)")
                    lines.append("- ID: \(note.id)")
                    if !note.tags.isEmpty { lines.append("- Tags: \(note.tags.joined(separator: ", "))") }
                    lines.append("- Updated: \(note.updatedAt ?? "-")")
                    if let url = note.source.url { lines.append("- Source: \(url)") }
                    lines.append("")
                    lines.append(note.type == .image ? imageText(note) : note.content)
                    lines.append("")
                }
            }
            let freeNotes = groupNotes.filter(\.isFreeCanvasInKanban)
            if !freeNotes.isEmpty {
                lines += ["### Canvas", ""]
                for note in freeNotes {
                    lines += ["#### \(note.displayTitle)", ""]
                    if !note.tags.isEmpty { lines += ["Tags: \(note.tags.joined(separator: ", "))", ""] }
                    lines += [note.type == .image ? imageText(note) : note.content, ""]
                }
            }
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
    }
}
