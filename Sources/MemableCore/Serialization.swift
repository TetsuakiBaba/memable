import Foundation

/// JSON representations shared by backups and library folders.
public enum JSONCoding {
    static func optional(_ value: Any?) -> Any { value ?? NSNull() }

    public static func presentation(of note: Note) -> [String: Any] {
        [
            "x": note.x,
            "y": note.y,
            "width": note.width,
            "height": note.height,
            "color": note.color.rawValue,
            "zIndex": note.zIndex
        ]
    }

    public static func noteObject(_ note: Note, keyId: String? = nil) -> [String: Any] {
        var object: [String: Any] = [
            "id": note.id,
            "groupId": note.groupId,
            "type": note.type.rawValue,
            "title": note.title,
            "content": note.type == .image ? (note.imageDataURL ?? "") : note.content,
            "tags": note.tags,
            "createdAt": optional(note.createdAt),
            "updatedAt": optional(note.updatedAt),
            "source": ["type": note.source.type, "url": optional(note.source.url)],
            "kanbanColumnId": note.kanbanColumnId,
            "kanbanOrder": note.kanbanOrder,
            "presentation": presentation(of: note)
        ]
        if let keyId { object["keyId"] = keyId }
        return object
    }

    public static func groupObject(_ group: NoteGroup) -> [String: Any] {
        [
            "id": group.id,
            "name": group.name,
            "viewMode": group.viewMode.rawValue,
            "kanbanColumns": group.kanbanColumns.map { ["id": $0.id, "name": $0.name] },
            "parentId": optional(group.parentId),
            "order": group.order
        ]
    }

    public static func prettyData(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    }

    /// Compact single-value JSON (used for frontmatter values).
    public static func compactString(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys, .withoutEscapingSlashes]) else {
            return "null"
        }
        return String(decoding: data, as: UTF8.self)
    }
}

/// `memable_backup.json` import / export.
public enum BackupCodec {
    public static func export(notes: [Note], groups: [NoteGroup]) throws -> Data {
        let payload: [String: Any] = [
            "notes": notes.map { JSONCoding.noteObject($0) },
            "groups": groups.map(JSONCoding.groupObject),
            "version": MemableConstants.dataFormatVersion,
            "source": "memable"
        ]
        return try JSONCoding.prettyData(payload)
    }

    public enum ImportError: LocalizedError {
        case invalidFormat
        public var errorDescription: String? { "Invalid data format" }
    }

    public static func `import`(_ data: Data, defaultColor: NoteColor = .yellow) throws -> (notes: [Note], groups: [NoteGroup]) {
        let object = try JSONSerialization.jsonObject(with: data)
        guard object is [String: Any] || object is [Any] else { throw ImportError.invalidFormat }
        return Normalizer.normalizePayload(object, defaultColor: defaultColor)
    }
}

/// One Markdown file per note with a JSON-valued YAML-style frontmatter.
public enum NoteFileFormat {
    public static func fileName(for id: String) -> String {
        sanitize(id) + ".md"
    }

    public static func sanitize(_ id: String) -> String {
        String(id.unicodeScalars.map { scalar -> Character in
            let allowed = CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII
            return allowed || scalar == "." || scalar == "_" || scalar == "-" ? Character(scalar) : "_"
        })
    }

    public static func serialize(_ note: Note, assetPath: String?) -> String {
        let fields: [(String, Any)] = [
            ("id", note.id),
            ("title", note.title),
            ("group", note.groupId),
            ("type", note.type.rawValue),
            ("status", note.kanbanColumnId),
            ("order", note.kanbanOrder),
            ("tags", note.tags),
            ("created_at", JSONCoding.optional(note.createdAt)),
            ("updated_at", JSONCoding.optional(note.updatedAt)),
            ("source", ["type": note.source.type, "url": JSONCoding.optional(note.source.url)]),
            ("asset", JSONCoding.optional(assetPath))
        ]
        let frontmatter = fields.map { "\($0.0): \(JSONCoding.compactString($0.1))" }.joined(separator: "\n")
        let body: String
        if note.type == .image {
            body = assetPath.map { "![\(note.title.isEmpty ? "image" : note.title)](\($0))" } ?? ""
        } else {
            body = note.content
        }
        return "---\n\(frontmatter)\n---\n\n\(body)\n"
    }

    public static func parse(_ markdown: String) -> (metadata: [String: Any], body: String)? {
        let text = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        guard text.hasPrefix("---\n") else { return nil }
        let afterOpen = text.index(text.startIndex, offsetBy: 4)
        // Closing fence: the first "\n---" that ends a line (allow empty frontmatter "---\n---").
        let closing: Range<String.Index>
        if text[afterOpen...].hasPrefix("---") {
            closing = afterOpen..<text.index(afterOpen, offsetBy: 3)
        } else if let range = text.range(of: "\n---", range: afterOpen..<text.endIndex) {
            closing = range
        } else {
            return nil
        }
        let afterClose = closing.upperBound
        guard afterClose == text.endIndex || text[afterClose] == "\n" else { return nil }

        let header = text[afterOpen..<closing.lowerBound]
        var metadata: [String: Any] = [:]
        for line in header.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces)
            let rawValue = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if let data = rawValue.data(using: .utf8),
               let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) {
                metadata[key] = value
            } else {
                metadata[key] = rawValue
            }
        }

        var body = afterClose == text.endIndex ? "" : String(text[text.index(after: afterClose)...])
        if body.hasPrefix("\n") { body.removeFirst() }
        if body.hasSuffix("\n") { body.removeLast() }
        return (metadata, body)
    }
}
