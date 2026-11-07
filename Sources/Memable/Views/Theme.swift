import AppKit
import MemableCore
import SwiftUI

/// Material 3 inspired palette carried over from the web version.
enum Theme {
    static let surface = Color(light: 0xFEF7FF, dark: 0x141218)
    static let surfaceContainer = Color(light: 0xF3EDF7, dark: 0x211F26)
    static let primary = Color(light: 0x6750A4, dark: 0xD0BCFF)
    static let onPrimary = Color(light: 0xFFFFFF, dark: 0x381E72)
    static let secondaryContainer = Color(light: 0xE8DEF8, dark: 0x4A4458)
    static let outline = Color(light: 0x79747E, dark: 0x938F99)
    static let error = Color(light: 0xB3261E, dark: 0xF2B8B5)

    /// Notes keep their pastel colors in dark mode, so their text is always dark.
    static let noteText = Color(hex: 0x1D1B20)
    static let noteTextNS = NSColor(hex: 0x1D1B20)
    static let internalLink = Color(hex: 0x4B3A8F)

    static func columnBackground(_ role: KanbanColumnRole) -> Color {
        switch role {
        case .todo: return Color(light: 0xFFF6DD, dark: 0x3A3020)
        case .progress: return Color(light: 0xE8F2FF, dark: 0x1E2A3A)
        case .done: return Color(light: 0xE9F8EF, dark: 0x1E3326)
        }
    }

    static func columnHeader(_ role: KanbanColumnRole) -> Color {
        switch role {
        case .todo: return Color(light: 0xFFE8AA, dark: 0x5A4520)
        case .progress: return Color(light: 0xCFE5FF, dark: 0x203F60)
        case .done: return Color(light: 0xCDEED8, dark: 0x1F5233)
        }
    }

    static func columnBorder(_ role: KanbanColumnRole) -> Color {
        switch role {
        case .todo: return Color(hex: 0x7C4D00)
        case .progress: return Color(hex: 0x0B5394)
        case .done: return Color(hex: 0x0F6B3D)
        }
    }
}

extension NoteColor {
    var swiftUIColor: Color {
        Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue, opacity: 1)
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(nsColor: NSColor(hex: hex))
    }

    init(light: UInt32, dark: UInt32) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(hex: dark) : NSColor(hex: light)
        })
    }
}
