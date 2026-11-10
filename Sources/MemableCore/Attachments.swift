import Foundation

/// Files dropped onto notes are copied into `<library>/files/` and referenced from the note body
/// with a relative Markdown link such as `[report.pdf](../files/report.pdf)`.
/// The path is relative to `notes/`, so the link also works in other Markdown editors.
public enum FileAttachments {
    public static let folderName = "files"
    /// Prefix of every attachment link destination (relative to the `notes/` folder).
    public static let linkPrefix = "../\(folderName)/"

    /// Markdown link for a file stored in `files/`.
    public static func markdownLink(fileName: String) -> String {
        let label = fileName.replacingOccurrences(of: "[", with: "(").replacingOccurrences(of: "]", with: ")")
        return "[\(label)](\(linkPrefix)\(encode(fileName)))"
    }

    /// True when a link destination points into `files/`.
    public static func isAttachmentLink(_ destination: String) -> Bool {
        destination.hasPrefix(linkPrefix) && destination.count > linkPrefix.count
    }

    /// Percent-encodes only what would break a Markdown link destination; Unicode stays readable.
    static func encode(_ name: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "()<>[]%#?/")
        var result = ""
        for scalar in name.unicodeScalars {
            if scalar.isASCII ? allowed.contains(scalar) : !CharacterSet.whitespacesAndNewlines.contains(scalar) {
                result.unicodeScalars.append(scalar)
            } else {
                result += String(scalar).utf8.map { String(format: "%%%02X", $0) }.joined()
            }
        }
        return result
    }

    /// Makes a dropped file name safe to store: no path separators, no leading dots.
    static func sanitize(_ name: String) -> String {
        var cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        return cleaned.isEmpty ? "file" : cleaned
    }
}

extension LibraryFolder {
    var filesURL: URL { url.appendingPathComponent(FileAttachments.folderName, isDirectory: true) }

    /// Copies a file or folder into `files/` and returns its Markdown link.
    /// An identical file that is already stored under the same name is reused instead of copied again.
    public func importAttachment(from source: URL) throws -> String {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: filesURL, withIntermediateDirectories: true)
        let name = FileAttachments.sanitize(source.lastPathComponent)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var counter = 1
        while true {
            let candidate = counter == 1 ? name : (ext.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(ext)")
            let destination = filesURL.appendingPathComponent(candidate)
            if !fileManager.fileExists(atPath: destination.path) {
                try fileManager.copyItem(at: source, to: destination)
                return FileAttachments.markdownLink(fileName: candidate)
            }
            if source.standardizedFileURL == destination.standardizedFileURL
                || fileManager.contentsEqual(atPath: source.path, andPath: destination.path) {
                return FileAttachments.markdownLink(fileName: candidate)
            }
            counter += 1
        }
    }

    /// Resolves an attachment link destination (`../files/…`) to a file inside this library.
    public func attachmentURL(forLink destination: String) -> URL? {
        guard FileAttachments.isAttachmentLink(destination) else { return nil }
        let decoded = destination.removingPercentEncoding ?? destination
        let resolved = notesURL.appendingPathComponent(decoded).standardizedFileURL
        guard resolved.path.hasPrefix(filesURL.standardizedFileURL.path + "/") else { return nil }
        return resolved
    }

    /// Copies attachments that do not exist in `destination` yet (used when switching storage folders).
    public func copyAttachments(to destination: LibraryFolder) {
        let fileManager = FileManager.default
        guard destination.url.standardizedFileURL != url.standardizedFileURL,
              let names = try? fileManager.contentsOfDirectory(atPath: filesURL.path), !names.isEmpty else { return }
        try? fileManager.createDirectory(at: destination.filesURL, withIntermediateDirectories: true)
        for name in names where !fileManager.fileExists(atPath: destination.filesURL.appendingPathComponent(name).path) {
            try? fileManager.copyItem(at: filesURL.appendingPathComponent(name), to: destination.filesURL.appendingPathComponent(name))
        }
    }
}
