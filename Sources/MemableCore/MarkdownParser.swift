import Foundation

/// Lightweight Markdown subset used for note previews:
/// headings (#–####), bullet / numbered lists, quotes, fenced code,
/// and inline `code`, **bold**, [links](https://…), [file links](../files/…) and [[internal links]].
public enum MarkdownParser {
    public enum Inline: Equatable, Sendable {
        case text(String)
        case bold(String)
        case code(String)
        case link(label: String, url: String)
        /// Link to a file in the library's `files/` folder, e.g. `[a.pdf](../files/a.pdf)`.
        case fileLink(label: String, path: String)
        case internalLink(String)
    }

    public enum Block: Equatable, Sendable {
        case heading(level: Int, [Inline])
        case bullet([Inline])
        case numbered(String, [Inline])
        case quote([Inline])
        case code(String)
        case blank
        case paragraph([Inline])
    }

    public static func parse(_ markdown: String) -> [Block] {
        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var blocks: [Block] = []
        var codeLines: [String]?

        for line in lines {
            if line.hasPrefix("```") {
                if let current = codeLines {
                    blocks.append(.code(current.joined(separator: "\n")))
                    codeLines = nil
                } else {
                    codeLines = []
                }
                continue
            }
            if codeLines != nil {
                codeLines?.append(line)
                continue
            }
            blocks.append(parseLine(line))
        }
        if let codeLines { blocks.append(.code(codeLines.joined(separator: "\n"))) }
        return blocks
    }

    static func parseLine(_ line: String) -> Block {
        if let match = line.firstMatch(of: /^(#{1,4})\s+(.+)$/) {
            return .heading(level: match.1.count, parseInline(String(match.2)))
        }
        if let match = line.firstMatch(of: /^\s*[-*]\s+(.+)$/) {
            return .bullet(parseInline(String(match.1)))
        }
        if let match = line.firstMatch(of: /^\s*(\d+)\.\s+(.+)$/) {
            return .numbered(String(match.1), parseInline(String(match.2)))
        }
        if let match = line.firstMatch(of: /^>\s?(.*)$/) {
            return .quote(parseInline(String(match.1)))
        }
        if line.isEmpty { return .blank }
        return .paragraph(parseInline(line))
    }

    public static func parseInline(_ text: String) -> [Inline] {
        let pattern = /(\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\((?:https?:\/\/|\.\.\/files\/)[^)\s]+\)|`[^`\n]+`|\*\*[^*\n]+\*\*)/
        var result: [Inline] = []
        var cursor = text.startIndex
        for match in text.matches(of: pattern) {
            if match.range.lowerBound > cursor {
                result.append(.text(String(text[cursor..<match.range.lowerBound])))
            }
            let token = String(match.output.0)
            if token.hasPrefix("[[") {
                result.append(.internalLink(String(token.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)))
            } else if token.hasPrefix("["), let link = token.firstMatch(of: /^\[([^\]]+)\]\(([^)]+)\)$/) {
                let destination = String(link.2)
                if FileAttachments.isAttachmentLink(destination) {
                    result.append(.fileLink(label: String(link.1), path: destination))
                } else {
                    result.append(.link(label: String(link.1), url: destination))
                }
            } else if token.hasPrefix("`") {
                result.append(.code(String(token.dropFirst().dropLast())))
            } else {
                result.append(.bold(String(token.dropFirst(2).dropLast(2))))
            }
            cursor = match.range.upperBound
        }
        if cursor < text.endIndex { result.append(.text(String(text[cursor...]))) }
        return result
    }
}
