import Foundation

/// Kanban column helpers. ToDo and Done are fixed; only the middle steps are customizable.
public enum Kanban {
    public static func build(middle: [KanbanColumn]) -> [KanbanColumn] {
        [MemableConstants.todoColumn] + middle + [MemableConstants.doneColumn]
    }

    public static func defaultColumns() -> [KanbanColumn] {
        build(middle: MemableConstants.defaultMiddleColumns)
    }

    public static func middle(of columns: [KanbanColumn]) -> [KanbanColumn] {
        Array(normalize(columns).dropFirst().dropLast())
    }

    public static func normalize(_ columns: [KanbanColumn]) -> [KanbanColumn] {
        normalize(raw: columns.map { ["id": $0.id, "name": $0.name] })
    }

    /// Port of `normalizeKanbanColumns` from the web version.
    public static func normalize(raw: Any?) -> [KanbanColumn] {
        guard let array = raw as? [Any], !array.isEmpty else { return defaultColumns() }
        let sources = array.compactMap { $0 as? [String: Any] }
        guard !sources.isEmpty else { return defaultColumns() }

        let todoId = MemableConstants.todoColumn.id
        let doneId = MemableConstants.doneColumn.id
        let hasFixedEdges = sources.count >= 2
            && (sources.first?["id"] as? String) == todoId
            && (sources.last?["id"] as? String) == doneId
        let middleSources = hasFixedEdges
            ? Array(sources.dropFirst().dropLast())
            : sources.filter { ($0["id"] as? String) != todoId && ($0["id"] as? String) != doneId }

        var used: Set<String> = [todoId, doneId]
        var middle: [KanbanColumn] = []
        for source in middleSources {
            let name = Normalizer.trimmedString(source["name"]) ?? "Step \(middle.count + 1)"
            var id = Normalizer.trimmedString(source["id"]) ?? IDGenerator.make()
            while used.contains(id) { id = IDGenerator.make() }
            used.insert(id)
            middle.append(KanbanColumn(id: id, name: name))
        }
        return build(middle: middle)
    }

    /// When columns are removed, notes move to the nearest preceding surviving column.
    public static func reassignmentMap(previous: [KanbanColumn], next: [KanbanColumn]) -> [String: String] {
        let nextIds = Set(next.map(\.id))
        var map: [String: String] = [:]
        for (index, column) in previous.enumerated() where !nextIds.contains(column.id) {
            var target = previous.first?.id ?? MemableConstants.todoColumn.id
            if index > 0 {
                for candidate in previous[..<index].reversed() where nextIds.contains(candidate.id) {
                    target = candidate.id
                    break
                }
            }
            map[column.id] = target
        }
        return map
    }
}

/// Tolerant normalization of notes and groups coming from JSON backups, library folders
/// or older versions. Mirrors `normalizeBackupPayload` of the web version.
public enum Normalizer {
    static func trimmedString(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }

    public static func normalizeTitle(_ title: String?) -> String {
        (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func normalizeTags(_ tags: [String]) -> [String] {
        var seen = Set<String>()
        return tags
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    public static func group(from raw: Any?) -> NoteGroup {
        let source = raw as? [String: Any] ?? [:]
        let order: Int
        if let number = number(source["order"]), number >= Double(Int.min), number <= Double(Int.max) {
            order = Int(number)
        } else {
            order = Int.max
        }
        return NoteGroup(
            id: trimmedString(source["id"]) ?? IDGenerator.make(),
            name: trimmedString(source["name"]) ?? "Untitled",
            viewMode: (source["viewMode"] as? String) == "kanban" ? .kanban : .canvas,
            kanbanColumns: Kanban.normalize(raw: source["kanbanColumns"]),
            parentId: trimmedString(source["parentId"]),
            order: order
        )
    }

    /// Removes dangling or cyclic parents and reindexes sibling order (0...n).
    /// The returned array keeps the source order.
    public static func normalizeHierarchy(_ input: [NoteGroup]) -> [NoteGroup] {
        var groups = input.map { group -> NoteGroup in
            var copy = group
            copy.kanbanColumns = Kanban.normalize(group.kanbanColumns)
            return copy
        }
        let ids = Set(groups.map(\.id))
        let parentOf = Dictionary(groups.map { ($0.id, $0.parentId) }, uniquingKeysWith: { first, _ in first })

        for index in groups.indices {
            let group = groups[index]
            if let parent = group.parentId, parent == group.id || !ids.contains(parent) {
                groups[index].parentId = nil
                continue
            }
            var visited: Set<String> = [group.id]
            var parent = group.parentId
            while let current = parent {
                if visited.contains(current) {
                    groups[index].parentId = nil
                    break
                }
                visited.insert(current)
                parent = parentOf[current] ?? nil
            }
        }

        var siblings: [String: [Int]] = [:]
        for index in groups.indices {
            siblings[groups[index].parentId ?? "", default: []].append(index)
        }
        for (_, indexes) in siblings {
            let sorted = indexes.sorted { lhs, rhs in
                groups[lhs].order != groups[rhs].order ? groups[lhs].order < groups[rhs].order : lhs < rhs
            }
            for (order, index) in sorted.enumerated() {
                groups[index].order = order
            }
        }
        return groups
    }

    /// Groups in display order (depth-first by sibling order) with their depth.
    public static func treeOrder(_ groups: [NoteGroup]) -> [(group: NoteGroup, depth: Int)] {
        var children: [String: [NoteGroup]] = [:]
        for group in groups { children[group.parentId ?? "", default: []].append(group) }
        var result: [(NoteGroup, Int)] = []
        var visited = Set<String>()
        func visit(_ parent: String, _ depth: Int) {
            for group in (children[parent] ?? []).sorted(by: { $0.order < $1.order }) where visited.insert(group.id).inserted {
                result.append((group, depth))
                visit(group.id, depth + 1)
            }
        }
        visit("", 0)
        return result
    }

    public static func descendantIds(of rootId: String, in groups: [NoteGroup]) -> Set<String> {
        var result: Set<String> = [rootId]
        var changed = true
        while changed {
            changed = false
            for group in groups where group.parentId.map(result.contains) == true && !result.contains(group.id) {
                result.insert(group.id)
                changed = true
            }
        }
        return result
    }

    /// Normalizes a raw payload (`{notes, groups}` or a bare note array).
    /// Image notes accept either a `data:` URL in `content` or `_imageData`/`_imageMime` keys.
    public static func normalizePayload(_ payload: Any?, defaultColor: NoteColor = .yellow) -> (notes: [Note], groups: [NoteGroup]) {
        let object = payload as? [String: Any]
        let rawNotes = (object?["notes"] as? [Any]) ?? (payload as? [Any]) ?? []
        let rawGroups = (object?["groups"] as? [Any]) ?? []
        return normalize(rawNotes: rawNotes, groups: rawGroups.map(group(from:)), defaultColor: defaultColor)
    }

    public static func normalize(rawNotes: [Any], groups inputGroups: [NoteGroup], defaultColor: NoteColor = .yellow) -> (notes: [Note], groups: [NoteGroup]) {
        var groups = normalizeHierarchy(inputGroups)
        if !groups.contains(where: { $0.id == MemableConstants.defaultGroupId }) {
            groups.append(.makeDefault())
        }
        groups = normalizeHierarchy(groups)
        let groupMap = Dictionary(groups.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let fallback = groupMap[MemableConstants.defaultGroupId] ?? groups.first ?? .makeDefault()
        var orderMap: [String: Double] = [:]

        let notes = rawNotes.map { raw -> Note in
            let source = raw as? [String: Any] ?? [:]
            let presentation = source["presentation"] as? [String: Any] ?? [:]
            let type: NoteType = (source["type"] as? String) == "image" ? .image : .text
            let groupId = (source["groupId"] as? String).flatMap { groupMap[$0] != nil ? $0 : nil } ?? fallback.id

            var note = Note(id: trimmedString(source["id"]) ?? IDGenerator.make(), groupId: groupId, type: type)
            note.title = normalizeTitle(source["title"] as? String)
            let content = source["content"] as? String ?? ""
            if type == .image {
                if let data = source["_imageData"] as? Data {
                    note.imageData = data
                    note.imageMimeType = source["_imageMime"] as? String ?? "image/png"
                } else if let parsed = ImageMime.parseDataURL(content) {
                    note.imageData = parsed.data
                    note.imageMimeType = parsed.mime
                }
            } else {
                note.content = content
            }
            note.tags = normalizeTags((source["tags"] as? [Any] ?? []).map { "\($0)" })
            note.createdAt = (source["createdAt"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            note.updatedAt = (source["updatedAt"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? note.createdAt
            if let rawSource = source["source"] as? [String: Any] {
                note.source = NoteSource(
                    type: (rawSource["type"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "manual",
                    url: (rawSource["url"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                )
            }

            // Top-level fields win (runtime/legacy); the nested presentation object is the fallback.
            func value(_ key: String) -> Double? { number(source[key]) ?? number(presentation[key]) }
            note.x = value("x") ?? 10
            note.y = value("y") ?? 10
            note.width = value("width") ?? (type == .image ? 200 : 250)
            note.height = value("height") ?? 200
            let colorName = (source["color"] as? String) ?? (presentation["color"] as? String)
            note.color = colorName.flatMap(NoteColor.init(rawValue:)) ?? defaultColor
            note.zIndex = value("zIndex") ?? 100

            let columns = Kanban.normalize(groupMap[groupId]?.kanbanColumns ?? fallback.kanbanColumns)
            let columnId = source["kanbanColumnId"] as? String
            if let columnId, columnId == MemableConstants.freeCanvasColumnId || columns.contains(where: { $0.id == columnId }) {
                note.kanbanColumnId = columnId
            } else {
                note.kanbanColumnId = columns[0].id
            }
            let orderKey = "\(groupId):\(note.kanbanColumnId)"
            let nextOrder = orderMap[orderKey] ?? 0
            note.kanbanOrder = number(source["kanbanOrder"]) ?? nextOrder
            orderMap[orderKey] = max(nextOrder + 1, note.kanbanOrder + 1)
            return note
        }
        return (notes, groups)
    }
}
