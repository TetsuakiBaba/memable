import Foundation

public enum MemableConstants {
    public static let defaultGroupId = "default"
    public static let todoColumn = KanbanColumn(id: "todo", name: "ToDo")
    public static let doneColumn = KanbanColumn(id: "done", name: "Done")
    public static let defaultMiddleColumns = [KanbanColumn(id: "doing", name: "Doing")]
    /// Notes placed freely on the board while their group is in Kanban mode.
    public static let freeCanvasColumnId = "__kanban_free_canvas__"
    public static let defaultTextNoteWidth: Double = 375
    public static let defaultTextNoteHeight: Double = 200
    public static let gridSize: Double = 25
    /// Version written to JSON backups.
    public static let dataFormatVersion = "2.0.0"
    /// Version written to `index.json` of a library folder.
    public static let noteFileVersion = 2
}

public enum NoteType: String, Sendable {
    case text
    case image
}

public enum NoteColor: String, CaseIterable, Sendable, Identifiable {
    case yellow, blue, green, red, gray, pink

    public var id: String { rawValue }

    public var hex: String {
        switch self {
        case .yellow: return "#F9E264"
        case .blue: return "#D0E4FF"
        case .green: return "#C4EBC1"
        case .red: return "#FFDAD6"
        case .gray: return "#E6E1E5"
        case .pink: return "#FFD8E4"
        }
    }

    /// sRGB components in 0...1.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let value = Int(hex.dropFirst(), radix: 16) ?? 0
        return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
    }
}

public enum ViewMode: String, Sendable {
    case canvas
    case kanban
}

public struct NoteSource: Equatable, Sendable {
    public var type: String
    public var url: String?

    public init(type: String = "manual", url: String? = nil) {
        self.type = type
        self.url = url
    }

    public static let manual = NoteSource()
}

public struct KanbanColumn: Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public enum KanbanColumnRole: Sendable {
    case todo, progress, done

    public static func role(index: Int, count: Int) -> KanbanColumnRole {
        if index == 0 { return .todo }
        if index == count - 1 { return .done }
        return .progress
    }
}

public struct NoteGroup: Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var viewMode: ViewMode
    public var kanbanColumns: [KanbanColumn]
    public var parentId: String?
    public var order: Int

    public init(
        id: String,
        name: String,
        viewMode: ViewMode = .canvas,
        kanbanColumns: [KanbanColumn] = Kanban.defaultColumns(),
        parentId: String? = nil,
        order: Int = 0
    ) {
        self.id = id
        self.name = name
        self.viewMode = viewMode
        self.kanbanColumns = kanbanColumns
        self.parentId = parentId
        self.order = order
    }

    public static func makeDefault() -> NoteGroup {
        NoteGroup(id: MemableConstants.defaultGroupId, name: "Default")
    }
}

public struct Note: Equatable, Identifiable, Sendable {
    public var id: String
    public var groupId: String
    public var type: NoteType
    public var title: String
    /// Markdown source for text notes. Empty for image notes.
    public var content: String
    /// Raw image bytes for image notes.
    public var imageData: Data?
    public var imageMimeType: String?
    public var tags: [String]
    public var createdAt: String?
    public var updatedAt: String?
    public var source: NoteSource
    // Presentation (stored separately in layout.json)
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var color: NoteColor
    public var zIndex: Double
    // Kanban
    public var kanbanColumnId: String
    public var kanbanOrder: Double

    public init(
        id: String = IDGenerator.make(),
        groupId: String,
        type: NoteType = .text,
        title: String = "",
        content: String = "",
        imageData: Data? = nil,
        imageMimeType: String? = nil,
        tags: [String] = [],
        createdAt: String? = nil,
        updatedAt: String? = nil,
        source: NoteSource = .manual,
        x: Double = 10,
        y: Double = 10,
        width: Double = MemableConstants.defaultTextNoteWidth,
        height: Double = MemableConstants.defaultTextNoteHeight,
        color: NoteColor = .yellow,
        zIndex: Double = 100,
        kanbanColumnId: String = MemableConstants.todoColumn.id,
        kanbanOrder: Double = 0
    ) {
        self.id = id
        self.groupId = groupId
        self.type = type
        self.title = title
        self.content = content
        self.imageData = imageData
        self.imageMimeType = imageMimeType
        self.tags = tags
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.source = source
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.color = color
        self.zIndex = zIndex
        self.kanbanColumnId = kanbanColumnId
        self.kanbanOrder = kanbanOrder
    }

    public var isFreeCanvasInKanban: Bool { kanbanColumnId == MemableConstants.freeCanvasColumnId }

    public var displayTitle: String { title.isEmpty ? "Untitled (\(id))" : title }

    /// `data:` URL for image notes (used by JSON backups and LLM context export).
    public var imageDataURL: String? {
        guard let imageData else { return nil }
        return "data:\(imageMimeType ?? "image/png");base64,\(imageData.base64EncodedString())"
    }

    public mutating func touch(now: String = ISOTime.now()) {
        updatedAt = now
    }
}

public enum IDGenerator {
    /// Same shape as the web version: base36 milliseconds + random base36 suffix.
    public static func make(date: Date = Date()) -> String {
        let millis = UInt64(date.timeIntervalSince1970 * 1000)
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")
        let suffix = String((0..<11).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })
        return String(millis, radix: 36) + suffix
    }
}

public enum ISOTime {
    public static func now() -> String { string(from: Date()) }

    public static func string(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    public static func date(from string: String?) -> Date? {
        guard let string else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: string)
    }
}

public enum KeyIds {
    /// Shortcut keys in assignment order: 1-9, 0, a-z.
    public static let all: [String] = (1...9).map(String.init) + ["0"] + (UInt8(ascii: "a")...UInt8(ascii: "z")).map { String(UnicodeScalar($0)) }

    /// 1-based position → key id, or nil when there are more notes than keys.
    public static func keyId(forPosition position: Int) -> String? {
        guard position >= 1, position <= all.count else { return nil }
        return all[position - 1]
    }
}

public enum ImageMime {
    public static let extensions: [String: String] = [
        "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"
    ]
    public static let mimeTypes: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"
    ]

    public static func parseDataURL(_ string: String) -> (mime: String, data: Data)? {
        guard string.hasPrefix("data:"), let comma = string.firstIndex(of: ",") else { return nil }
        let header = string[string.index(string.startIndex, offsetBy: 5)..<comma]
        guard header.hasSuffix(";base64") else { return nil }
        let mime = String(header.dropLast(";base64".count))
        guard !mime.isEmpty, let data = Data(base64Encoded: String(string[string.index(after: comma)...])) else { return nil }
        return (mime, data)
    }
}
