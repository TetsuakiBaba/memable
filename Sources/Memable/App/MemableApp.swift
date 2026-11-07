import AppKit
import MemableCore
import SwiftUI

@main
struct MemableApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = MemableStore.shared

    var body: some Scene {
        Window("memable", id: "main") {
            ContentView()
                .environment(store)
                .frame(minWidth: 720, minHeight: 460)
        }
        .defaultSize(width: 1100, height: 720)
        .commands { MemableCommands(store: store) }

        Settings {
            SettingsView()
                .environment(store)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var keyMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            MemableStore.shared.start()
        }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let handled = MainActor.assumeIsolated { Self.handleKeyDown(event) }
            return handled ? nil : event
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            MemableStore.shared.saveNow()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // keep global shortcuts alive, like the Electron version on macOS
    }

    /// In-window shortcuts that only apply while no text is being edited:
    /// [1-0 / a-z] copies the note, ⌘V creates a note from the clipboard.
    @MainActor
    private static func handleKeyDown(_ event: NSEvent) -> Bool {
        let store = MemableStore.shared
        guard let window = store.mainWindow, event.window === window, window.attachedSheet == nil,
              !(window.firstResponder is NSText) else { return false }
        let modifiers = event.modifierFlags.intersection([.command, .option, .control, .shift])
        guard let characters = event.charactersIgnoringModifiers, characters.count == 1 else { return false }
        if modifiers == .command && characters.lowercased() == "v" {
            return store.pasteFromPasteboard()
        }
        if modifiers.isEmpty {
            return store.copyNote(forKey: characters)
        }
        return false
    }
}

struct MemableCommands: Commands {
    let store: MemableStore
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Note") {
                openWindow(id: "main")
                store.createTextNote()
            }
            .keyboardShortcut("n")
            Button("New Group…") { store.activeSheet = .newGroup }
                .keyboardShortcut("n", modifiers: [.command, .shift])
        }
        CommandGroup(after: .newItem) {
            Divider()
            Button("Export LLM Context…") { store.activeSheet = .contextExport }
                .keyboardShortcut("e", modifiers: [.command, .shift])
            Divider()
            Button("Import JSON…") { store.importJSON() }
            Button("Export JSON…") { store.exportJSON() }
        }
        CommandGroup(after: .toolbar) {
            Button("Zoom In") { store.zoomPercent = min(200, store.zoomPercent + 10) }
                .keyboardShortcut("=", modifiers: .command)
            Button("Zoom Out") { store.zoomPercent = max(50, store.zoomPercent - 10) }
                .keyboardShortcut("-", modifiers: .command)
            Button("Actual Size") { store.zoomPercent = 100 }
                .keyboardShortcut("0", modifiers: .command)
            Divider()
            Toggle("Grid Snap", isOn: Binding(get: { store.isGridSnap }, set: { store.isGridSnap = $0 }))
                .keyboardShortcut("g", modifiers: [.command, .option])
            Button("Align Notes") { store.alignNotes() }
                .keyboardShortcut("l", modifiers: [.command, .option])
            Button(store.isKanban ? "Switch to Canvas" : "Switch to Kanban") { store.toggleViewMode(store.currentGroupId) }
                .keyboardShortcut("k", modifiers: [.command, .option])
            Divider()
        }
        CommandGroup(replacing: .help) {
            Button("memable Help") { store.activeSheet = .help }
            Link("memable on GitHub", destination: URL(string: "https://github.com/TetsuakiBaba/memable")!)
        }
    }
}
