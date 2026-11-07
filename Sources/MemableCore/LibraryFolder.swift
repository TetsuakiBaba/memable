import CryptoKit
import Foundation

/// A folder that stores the whole library in an LLM-friendly layout:
///
/// ```
/// <folder>/
/// ├── notes/       one Markdown file per note (frontmatter + body)
/// ├── assets/      image-note files
/// ├── groups.json
/// ├── layout.json  positions, sizes, colors and stacking order
/// └── index.json
/// ```
///
/// Used both for local storage (Application Support) and for external sync (Dropbox, iCloud …).
/// Folders written by the Electron version are read and written as-is; legacy `notes.json`
/// folders are readable too.
public final class LibraryFolder {
    public let url: URL
    private let fileManager = FileManager.default

    public init(url: URL) {
        self.url = url
    }

    var notesURL: URL { url.appendingPathComponent("notes", isDirectory: true) }
    var assetsURL: URL { url.appendingPathComponent("assets", isDirectory: true) }
    var indexURL: URL { url.appendingPathComponent("index.json") }

    /// True when the folder already holds memable data (current or legacy format).
    public var containsLibrary: Bool {
        fileManager.fileExists(atPath: notesURL.path)
            || fileManager.fileExists(atPath: url.appendingPathComponent("notes.json").path)
    }

    // MARK: - Save

    /// Writes the snapshot, touching only files whose content changed.
    /// - Returns: true if anything on disk changed.
    @discardableResult
    public func save(notes: [Note], groups: [NoteGroup]) throws -> Bool {
        try fileManager.createDirectory(at: notesURL, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: assetsURL, withIntermediateDirectories: true)

        let previousFiles = (try? readJSON(indexURL) as? [String: Any])?["notes"] as? [String] ?? []
        var changed = false
        var nextFiles: [String] = []
        var layouts: [String: Any] = [:]

        for note in notes {
            let fileName = NoteFileFormat.fileName(for: note.id)
            var assetPath: String?
            if note.type == .image, let data = note.imageData {
                let ext = ImageMime.extensions[note.imageMimeType ?? ""] ?? "bin"
                let assetName = "\(NoteFileFormat.sanitize(note.id)).\(ext)"
                changed = try writeDataIfNeeded(data, to: assetsURL.appendingPathComponent(assetName)) || changed
                assetPath = "../assets/\(assetName)"
            }
            let markdown = NoteFileFormat.serialize(note, assetPath: assetPath)
            changed = try writeTextIfNeeded(markdown, to: notesURL.appendingPathComponent(fileName)) || changed
            nextFiles.append(fileName)
            layouts[note.id] = JSONCoding.presentation(of: note)
        }

        let nextSet = Set(nextFiles)
        for stale in previousFiles where !nextSet.contains(stale) {
            let name = (stale as NSString).lastPathComponent
            let staleURL = notesURL.appendingPathComponent(name)
            if fileManager.fileExists(atPath: staleURL.path) {
                try? fileManager.removeItem(at: staleURL)
                changed = true
            }
            removeAssets(forNoteFile: name)
        }

        changed = try writeTextIfNeeded(String(decoding: try JSONCoding.prettyData(groups.map(JSONCoding.groupObject)), as: UTF8.self),
                                        to: url.appendingPathComponent("groups.json")) || changed
        changed = try writeTextIfNeeded(String(decoding: try JSONCoding.prettyData(layouts), as: UTF8.self),
                                        to: url.appendingPathComponent("layout.json")) || changed

        if changed || previousFiles != nextFiles || !fileManager.fileExists(atPath: indexURL.path) {
            let index: [String: Any] = [
                "source": "memable",
                "version": MemableConstants.noteFileVersion,
                "updatedAt": ISOTime.now(),
                "notes": nextFiles
            ]
            _ = try writeTextIfNeeded(String(decoding: try JSONCoding.prettyData(index), as: UTF8.self), to: indexURL)
            changed = true
        }
        return changed
    }

    private func removeAssets(forNoteFile noteFile: String) {
        let base = (noteFile as NSString).deletingPathExtension
        for ext in Set(ImageMime.extensions.values).union(["bin"]) {
            try? fileManager.removeItem(at: assetsURL.appendingPathComponent("\(base).\(ext)"))
        }
    }

    private func writeTextIfNeeded(_ text: String, to fileURL: URL) throws -> Bool {
        if let existing = try? String(contentsOf: fileURL, encoding: .utf8), existing == text { return false }
        try Data(text.utf8).write(to: fileURL, options: .atomic)
        return true
    }

    private func writeDataIfNeeded(_ data: Data, to fileURL: URL) throws -> Bool {
        // Image content of a note never changes, so an equally sized file is treated as identical.
        if let size = (try? fileManager.attributesOfItem(atPath: fileURL.path))?[.size] as? NSNumber, size.intValue == data.count {
            return false
        }
        try data.write(to: fileURL, options: .atomic)
        return true
    }

    // MARK: - Load

    /// Loads the library, or returns nil if the folder holds no memable data.
    public func load(defaultColor: NoteColor = .yellow) -> (notes: [Note], groups: [NoteGroup])? {
        if fileManager.fileExists(atPath: notesURL.path) {
            return loadMarkdownLibrary(defaultColor: defaultColor)
        }
        // Legacy format (Electron ≤ 1.6): notes.json + groups.json
        let legacyNotes = try? readJSON(url.appendingPathComponent("notes.json")) as? [Any]
        let legacyGroups = try? readJSON(url.appendingPathComponent("groups.json")) as? [Any]
        guard legacyNotes != nil || legacyGroups != nil else { return nil }
        return Normalizer.normalizePayload(["notes": legacyNotes ?? [], "groups": legacyGroups ?? []], defaultColor: defaultColor)
    }

    private func loadMarkdownLibrary(defaultColor: NoteColor) -> (notes: [Note], groups: [NoteGroup]) {
        let rawGroups = (try? readJSON(url.appendingPathComponent("groups.json")) as? [Any]) ?? []
        let layouts = (try? readJSON(url.appendingPathComponent("layout.json")) as? [String: Any]) ?? [:]
        let files = ((try? fileManager.contentsOfDirectory(atPath: notesURL.path)) ?? [])
            .filter { $0.hasSuffix(".md") }
            .sorted()

        // Sync services leave conflict copies such as "id (… conflicted copy …).md" next to the real
        // file. Canonical files ("<id>.md") always win; any other file is only used when its note is
        // still listed in index.json, so deleted notes are not resurrected from stale copies.
        let indexedFiles = Set((try? readJSON(indexURL) as? [String: Any])?["notes"] as? [String] ?? [])
        var parsedFiles: [(file: String, id: String, metadata: [String: Any], body: String)] = []
        for file in files {
            guard let text = try? String(contentsOf: notesURL.appendingPathComponent(file), encoding: .utf8),
                  let parsed = NoteFileFormat.parse(text) else { continue }
            let id = (parsed.metadata["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (file as NSString).deletingPathExtension
            parsedFiles.append((file, id, parsed.metadata, parsed.body))
        }
        let canonicalIds = Set(parsedFiles.filter { $0.file == NoteFileFormat.fileName(for: $0.id) }.map(\.id))
        var seenIds = Set<String>()
        var rawNotes: [Any] = []
        for entry in parsedFiles.sorted(by: { ($0.file == NoteFileFormat.fileName(for: $0.id) ? 0 : 1) < ($1.file == NoteFileFormat.fileName(for: $1.id) ? 0 : 1) }) {
            let isCanonical = entry.file == NoteFileFormat.fileName(for: entry.id)
            if !isCanonical {
                guard !canonicalIds.contains(entry.id),
                      indexedFiles.isEmpty || indexedFiles.contains(NoteFileFormat.fileName(for: entry.id)) else { continue }
            }
            guard seenIds.insert(entry.id).inserted else { continue }
            let id = entry.id
            let metadata = entry.metadata
            let parsed = (metadata: metadata, body: entry.body)
            let isImage = (metadata["type"] as? String) == "image"
            var raw: [String: Any] = [
                "id": id,
                "title": metadata["title"] as? String ?? "",
                "type": isImage ? "image" : "text",
                "content": isImage ? "" : parsed.body,
                "presentation": layouts[id] as? [String: Any] ?? [:]
            ]
            raw["groupId"] = metadata["group"]
            raw["kanbanColumnId"] = metadata["status"]
            raw["kanbanOrder"] = metadata["order"]
            raw["tags"] = metadata["tags"]
            raw["createdAt"] = metadata["created_at"]
            raw["updatedAt"] = metadata["updated_at"]
            raw["source"] = metadata["source"]
            if isImage, let asset = loadAsset(metadata["asset"] as? String) {
                raw["_imageData"] = asset.data
                raw["_imageMime"] = asset.mime
            }
            rawNotes.append(raw)
        }
        return Normalizer.normalize(rawNotes: rawNotes, groups: rawGroups.map(Normalizer.group(from:)), defaultColor: defaultColor)
    }

    private func loadAsset(_ relativePath: String?) -> (data: Data, mime: String)? {
        guard let relativePath, !relativePath.isEmpty else { return nil }
        let resolved = notesURL.appendingPathComponent(relativePath).standardizedFileURL
        let assetsRoot = assetsURL.standardizedFileURL.path + "/"
        guard resolved.path.hasPrefix(assetsRoot),
              let mime = ImageMime.mimeTypes[resolved.pathExtension.lowercased()],
              let data = try? Data(contentsOf: resolved) else { return nil }
        return (data, mime)
    }

    private func readJSON(_ fileURL: URL) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(contentsOf: fileURL))
    }

    // MARK: - Change detection

    /// Hash of all files that describe the library (used to ignore our own writes).
    public func fingerprint() -> String? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        var files = ["notes.json", "groups.json", "layout.json", "index.json"]
        let noteFiles = ((try? fileManager.contentsOfDirectory(atPath: notesURL.path)) ?? []).filter { $0.hasSuffix(".md") }.sorted()
        files += noteFiles.map { "notes/\($0)" }
        var hasher = SHA256()
        for relative in files {
            guard let data = try? Data(contentsOf: url.appendingPathComponent(relative)) else { continue }
            hasher.update(data: Data(relative.utf8))
            hasher.update(data: Data([0]))
            hasher.update(data: data)
            hasher.update(data: Data([0]))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Removes everything this app writes (used by "Reset to Default" on the local library only).
    public func removeLibraryFiles() {
        for name in ["notes", "assets", "groups.json", "layout.json", "index.json", "notes.json"] {
            try? fileManager.removeItem(at: url.appendingPathComponent(name))
        }
    }
}
