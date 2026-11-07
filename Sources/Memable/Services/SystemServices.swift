import AppKit
import ApplicationServices
import Carbon
import CoreServices
import MemableCore
import UniformTypeIdentifiers

enum Clipboard {
    static func write(_ note: Note) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        switch note.type {
        case .text:
            pasteboard.setString(note.content, forType: .string)
        case .image:
            guard let data = note.imageData else { return }
            if let image = NSImage(data: data) {
                pasteboard.writeObjects([image])
            }
            if note.imageMimeType == "image/png" {
                pasteboard.setData(data, forType: .png)
            }
        }
    }

    static func write(text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// Posts ⌘V to the frontmost application (requires Accessibility permission).
enum SystemPaste {
    static var isTrusted: Bool { AXIsProcessTrusted() }

    @discardableResult
    static func requestAccess() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    static func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    static func pasteToFrontmostApp() {
        let source = CGEventSource(stateID: .hidSystemState)
        let keyCode = CGKeyCode(kVK_ANSI_V)
        let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }
}

/// Reads images from the pasteboard, files and drag providers.
enum ImageImport {
    struct Payload {
        var data: Data
        var mime: String
    }

    static func fromFile(_ url: URL) -> Payload? {
        let ext = url.pathExtension.lowercased()
        if let mime = ImageMime.mimeTypes[ext], let data = try? Data(contentsOf: url) {
            return Payload(data: data, mime: mime)
        }
        guard let type = UTType(filenameExtension: ext), type.conforms(to: .image),
              let image = NSImage(contentsOf: url) else { return nil }
        return pngPayload(from: image)
    }

    static func fromPasteboard(_ pasteboard: NSPasteboard) -> Payload? {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           let payload = urls.lazy.compactMap(fromFile).first {
            return payload
        }
        if let png = pasteboard.data(forType: .png) { return Payload(data: png, mime: "image/png") }
        if let jpeg = pasteboard.data(forType: NSPasteboard.PasteboardType(UTType.jpeg.identifier)) {
            return Payload(data: jpeg, mime: "image/jpeg")
        }
        if let tiff = pasteboard.data(forType: .tiff), let image = NSImage(data: tiff) {
            return pngPayload(from: image)
        }
        return nil
    }

    static func pngPayload(from image: NSImage) -> Payload? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return Payload(data: png, mime: "image/png")
    }

    /// Loads an image from a drag provider (file URL or raw image data).
    static func load(from provider: NSItemProvider, completion: @escaping (Payload?) -> Void) {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                completion(url.flatMap(fromFile))
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                completion(data.flatMap(NSImage.init(data:)).flatMap(pngPayload(from:)))
            }
        } else {
            completion(nil)
        }
    }
}

/// Caches decoded images per note so canvas re-renders stay cheap.
final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, NSImage>()

    func image(for note: Note) -> NSImage? {
        guard let data = note.imageData else { return nil }
        let key = "\(note.id):\(data.count)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let image = NSImage(data: data) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}

/// FSEvents-based recursive folder watcher (works with Dropbox / iCloud updates).
final class FolderWatcher {
    private var stream: FSEventStreamRef?
    private let handler: () -> Void

    init?(url: URL, handler: @escaping () -> Void) {
        self.handler = handler
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue().handler()
        }
        guard let stream = FSEventStreamCreate(kCFAllocatorDefault, callback, &context, [url.path] as CFArray,
                                               FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.25,
                                               FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer))
        else { return nil }
        self.stream = stream
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        FSEventStreamStart(stream)
    }

    deinit {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
    }
}

enum Alerts {
    /// Shows a modal confirmation; returns true when the first (confirm) button is chosen.
    @MainActor
    static func confirm(_ title: String, message: String = "", confirmTitle: String = "OK", destructive: Bool = false) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = destructive ? .critical : .warning
        let button = alert.addButton(withTitle: confirmTitle)
        button.hasDestructiveAction = destructive
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    @MainActor
    static func info(_ title: String, message: String = "") {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }
}
