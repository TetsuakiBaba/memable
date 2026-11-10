import XCTest
@testable import MemableCore

final class NormalizationTests: XCTestCase {
    func testDefaultGroupIsAddedAndNotesFallBack() {
        let result = Normalizer.normalizePayload(["notes": [["id": "a", "groupId": "missing", "content": "hi"]], "groups": []])
        XCTAssertEqual(result.groups.map(\.id), ["default"])
        XCTAssertEqual(result.notes.first?.groupId, "default")
        XCTAssertEqual(result.notes.first?.kanbanColumnId, "todo")
        XCTAssertEqual(result.notes.first?.width, 250)
    }

    func testPresentationFallbackAndTopLevelPriority() {
        let result = Normalizer.normalizePayload(["notes": [
            ["id": "a", "x": 5, "presentation": ["x": 50, "y": 60, "color": "blue", "zIndex": 120]]
        ]])
        let note = result.notes[0]
        XCTAssertEqual(note.x, 5)
        XCTAssertEqual(note.y, 60)
        XCTAssertEqual(note.color, .blue)
        XCTAssertEqual(note.zIndex, 120)
    }

    func testCyclicParentsAreBroken() {
        let groups = Normalizer.normalizeHierarchy([
            NoteGroup(id: "a", name: "A", parentId: "b"),
            NoteGroup(id: "b", name: "B", parentId: "a"),
            NoteGroup(id: "c", name: "C", parentId: "c")
        ])
        XCTAssertNil(groups.first { $0.id == "c" }?.parentId)
        XCTAssertTrue(groups.contains { $0.parentId == nil && ["a", "b"].contains($0.id) })
    }

    func testKanbanColumnsKeepFixedEdges() {
        let columns = Kanban.normalize(raw: [["id": "x", "name": " Review "], ["id": "done", "name": "Finished"]])
        XCTAssertEqual(columns.map(\.id), ["todo", "x", "done"])
        XCTAssertEqual(columns[1].name, "Review")
        XCTAssertEqual(Kanban.normalize(raw: nil).map(\.id), ["todo", "doing", "done"])
    }

    func testReassignmentMovesToPrecedingColumn() {
        let previous = Kanban.build(middle: [KanbanColumn(id: "a", name: "A"), KanbanColumn(id: "b", name: "B")])
        let next = Kanban.build(middle: [KanbanColumn(id: "a", name: "A")])
        XCTAssertEqual(Kanban.reassignmentMap(previous: previous, next: next), ["b": "a"])
    }

    func testKeyIds() {
        XCTAssertEqual(KeyIds.keyId(forPosition: 1), "1")
        XCTAssertEqual(KeyIds.keyId(forPosition: 10), "0")
        XCTAssertEqual(KeyIds.keyId(forPosition: 11), "a")
        XCTAssertEqual(KeyIds.keyId(forPosition: 36), "z")
        XCTAssertNil(KeyIds.keyId(forPosition: 37))
    }
}

final class FileFormatTests: XCTestCase {
    func testNoteMarkdownRoundTrip() throws {
        var note = Note(id: "n1", groupId: "g", title: "Hello", content: "# Title\n\n- item\n---\nend")
        note.tags = ["a", "b"]
        note.createdAt = "2026-01-01T00:00:00.000Z"
        let markdown = NoteFileFormat.serialize(note, assetPath: nil)
        XCTAssertTrue(markdown.hasPrefix("---\nid: \"n1\"\ntitle: \"Hello\"\ngroup: \"g\"\ntype: \"text\"\nstatus: \"todo\"\norder: 0\ntags: [\"a\",\"b\"]\n"))
        XCTAssertTrue(markdown.contains("source: {\"type\":\"manual\",\"url\":null}"))
        let parsed = try XCTUnwrap(NoteFileFormat.parse(markdown))
        XCTAssertEqual(parsed.body, note.content)
        XCTAssertEqual(parsed.metadata["tags"] as? [String], ["a", "b"])
        XCTAssertTrue(parsed.metadata["asset"] is NSNull)
    }

    func testParsesElectronWrittenFile() throws {
        let text = "---\nid: \"x\"\ntitle: \"\"\ngroup: \"default\"\ntype: \"text\"\nstatus: \"todo\"\norder: 3\ntags: []\ncreated_at: null\nupdated_at: null\nsource: {\"type\":\"manual\",\"url\":null}\nasset: null\n---\n\nbody line\n"
        let parsed = try XCTUnwrap(NoteFileFormat.parse(text))
        XCTAssertEqual(parsed.body, "body line")
        XCTAssertEqual(parsed.metadata["order"] as? Int, 3)
    }

    func testFileNameSanitizing() {
        XCTAssertEqual(NoteFileFormat.fileName(for: "a/b c.d"), "a_b_c.d.md")
    }

    func testLibraryFolderRoundTripWithImage() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let folder = LibraryFolder(url: dir)
        let groups = [NoteGroup.makeDefault(), NoteGroup(id: "g2", name: "Second", viewMode: .kanban, parentId: "default")]
        var text = Note(id: "t1", groupId: "g2", title: "Text", content: "hello\nworld", x: 40, y: 50, color: .pink)
        text.kanbanColumnId = "done"
        let image = Note(id: "i1", groupId: "default", type: .image, imageData: Data([1, 2, 3]), imageMimeType: "image/png")
        XCTAssertTrue(try folder.save(notes: [text, image], groups: groups))
        let fingerprint = folder.fingerprint()
        XCTAssertFalse(try folder.save(notes: [text, image], groups: groups), "unchanged snapshot must not touch files")
        XCTAssertEqual(folder.fingerprint(), fingerprint)

        let loaded = try XCTUnwrap(folder.load())
        let loadedText = try XCTUnwrap(loaded.notes.first { $0.id == "t1" })
        XCTAssertEqual(loadedText.content, "hello\nworld")
        XCTAssertEqual(loadedText.x, 40)
        XCTAssertEqual(loadedText.color, .pink)
        XCTAssertEqual(loadedText.kanbanColumnId, "done")
        XCTAssertEqual(loaded.notes.first { $0.id == "i1" }?.imageData, Data([1, 2, 3]))
        XCTAssertEqual(loaded.groups.first { $0.id == "g2" }?.parentId, "default")

        XCTAssertTrue(try folder.save(notes: [text], groups: groups))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("notes/i1.md").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("assets/i1.png").path))
    }

    func testBackupRoundTrip() throws {
        let note = Note(id: "img", groupId: "default", type: .image, imageData: Data([9, 9]), imageMimeType: "image/jpeg")
        let data = try BackupCodec.export(notes: [note], groups: [.makeDefault()])
        let imported = try BackupCodec.import(data)
        XCTAssertEqual(imported.notes.first?.imageData, Data([9, 9]))
        XCTAssertEqual(imported.notes.first?.imageMimeType, "image/jpeg")
    }

    func testLegacySampleBackupImports() throws {
        let json = #"{"notes":[{"id":"sample-1","groupId":"default","type":"text","content":"Hi","x":50,"y":50,"width":250,"height":180,"color":"yellow","zIndex":100,"keyId":"1"}],"groups":[{"id":"default","name":"Default"}],"version":"1.2.0"}"#
        let imported = try BackupCodec.import(Data(json.utf8))
        XCTAssertEqual(imported.notes.first?.height, 180)
        XCTAssertEqual(imported.groups.first?.kanbanColumns.count, 3)
    }
}

final class ExportAndMarkdownTests: XCTestCase {
    func testContextMarkdown() {
        let group = NoteGroup.makeDefault()
        var todo = Note(id: "a", groupId: "default", title: "Plan", content: "Do it")
        todo.tags = ["x"]
        var done = Note(id: "b", groupId: "default", content: "Finished")
        done.kanbanColumnId = "done"
        let markdown = ContextExporter.markdown(notes: [todo, done], groups: [group],
                                                options: .init(includeDone: false, instruction: "Summarize"))
        XCTAssertTrue(markdown.hasPrefix("# Instruction\n\nSummarize\n\n# Memable Context"))
        XCTAssertTrue(markdown.contains("## Default\n\n### ToDo\n\n#### Plan\n- ID: a\n- Tags: x"))
        XCTAssertFalse(markdown.contains("Finished"))
    }

    func testMarkdownParsing() {
        let blocks = MarkdownParser.parse("# Head\n- **bold** and `code`\n1. see [[Other]]\n> quote [x](https://e.com)\n\n```\nlet a\n```")
        XCTAssertEqual(blocks[0], .heading(level: 1, [.text("Head")]))
        XCTAssertEqual(blocks[1], .bullet([.bold("bold"), .text(" and "), .code("code")]))
        XCTAssertEqual(blocks[2], .numbered("1", [.text("see "), .internalLink("Other")]))
        XCTAssertEqual(blocks[3], .quote([.text("quote "), .link(label: "x", url: "https://e.com")]))
        XCTAssertEqual(blocks[4], .blank)
        XCTAssertEqual(blocks[5], .code("let a"))
    }
}

final class SyncFolderCompatibilityTests: XCTestCase {
    func testConflictCopiesAreIgnored() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let folder = LibraryFolder(url: dir)
        let alive = Note(id: "alive", groupId: "default", content: "current")
        let deleted = Note(id: "deleted", groupId: "default", content: "old")
        try folder.save(notes: [alive, deleted], groups: [.makeDefault()])
        let notesDir = dir.appendingPathComponent("notes")
        try FileManager.default.copyItem(at: notesDir.appendingPathComponent("alive.md"),
                                         to: notesDir.appendingPathComponent("alive (Mac の競合コピー 2026-08-29).md"))
        try FileManager.default.copyItem(at: notesDir.appendingPathComponent("deleted.md"),
                                         to: notesDir.appendingPathComponent("deleted (conflicted copy).md"))
        try folder.save(notes: [alive], groups: [.makeDefault()]) // removes deleted.md from disk and index

        let loaded = try XCTUnwrap(folder.load())
        XCTAssertEqual(loaded.notes.map(\.id), ["alive"])
    }

    /// Set MEMABLE_COMPAT_DIR to a copy of a real sync folder to check it loads cleanly.
    func testLoadsRealFolderCopy() throws {
        guard let path = ProcessInfo.processInfo.environment["MEMABLE_COMPAT_DIR"] else { throw XCTSkip("MEMABLE_COMPAT_DIR not set") }
        let folder = LibraryFolder(url: URL(fileURLWithPath: path))
        let loaded = try XCTUnwrap(folder.load())
        let ids = loaded.notes.map(\.id)
        XCTAssertEqual(ids.count, Set(ids).count, "duplicate note ids")
        let groupIds = Set(loaded.groups.map(\.id))
        XCTAssertTrue(loaded.notes.allSatisfy { groupIds.contains($0.groupId) })
        let images = loaded.notes.filter { $0.type == .image }
        XCTAssertTrue(images.allSatisfy { $0.imageData != nil }, "image asset missing")
        print("COMPAT: notes=\(ids.count) groups=\(loaded.groups.count) images=\(images.count) kanbanGroups=\(loaded.groups.filter { $0.viewMode == .kanban }.count)")

        // Saving the loaded snapshot back into a copy must not change any note file.
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: copy) }
        try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: copy)
        let before = try FileManager.default.contentsOfDirectory(atPath: copy.appendingPathComponent("notes").path).sorted()
        let canonical = before.filter { !$0.contains(" (") }
        let originals = try canonical.map { try String(contentsOf: copy.appendingPathComponent("notes/\($0)"), encoding: .utf8) }
        try LibraryFolder(url: copy).save(notes: loaded.notes.sorted { $0.id < $1.id }, groups: loaded.groups)
        for (name, original) in zip(canonical, originals) {
            let after = try? String(contentsOf: copy.appendingPathComponent("notes/\(name)"), encoding: .utf8)
            XCTAssertEqual(after, original, "\(name) changed after round trip")
        }
    }
}

final class AttachmentTests: XCTestCase {
    func testImportCopiesFileAndBuildsRelativeLink() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? fm.removeItem(at: dir) }
        let source = dir.appendingPathComponent("src/議事録 (draft).pdf")
        try fm.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("a".utf8).write(to: source)
        let folder = LibraryFolder(url: dir.appendingPathComponent("lib"))

        let link = try folder.importAttachment(from: source)
        XCTAssertEqual(link, "[議事録 (draft).pdf](../files/議事録%20%28draft%29.pdf)")
        XCTAssertTrue(fm.fileExists(atPath: dir.appendingPathComponent("lib/files/議事録 (draft).pdf").path))
        XCTAssertEqual(try folder.importAttachment(from: source), link, "identical file is reused")

        try Data("b".utf8).write(to: source)
        XCTAssertEqual(try folder.importAttachment(from: source), "[議事録 (draft) 2.pdf](../files/議事録%20%28draft%29%202.pdf)")

        let destination = try XCTUnwrap(MarkdownParser.parseInline(link).compactMap { inline -> String? in
            if case .fileLink(_, let path) = inline { return path }
            return nil
        }.first)
        XCTAssertEqual(folder.attachmentURL(forLink: destination)?.lastPathComponent, "議事録 (draft).pdf")
        XCTAssertNil(folder.attachmentURL(forLink: "../files/../index.json"))
    }

    func testFileLinkParsing() {
        XCTAssertEqual(MarkdownParser.parseInline("see [a.pdf](../files/a.pdf) and [b](https://e.com)"),
                       [.text("see "), .fileLink(label: "a.pdf", path: "../files/a.pdf"), .text(" and "), .link(label: "b", url: "https://e.com")])
        XCTAssertEqual(MarkdownParser.parseInline("[x](../other/a.pdf)"), [.text("[x](../other/a.pdf)")])
    }
}
