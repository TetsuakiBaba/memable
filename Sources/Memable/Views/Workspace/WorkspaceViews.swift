import AppKit
import MemableCore
import SwiftUI
import UniformTypeIdentifiers

let canvasSpace = "memable-canvas"
private let droppableTypes: [UTType] = [.fileURL, .image, .plainText]

struct WorkspaceView: View {
    @Environment(MemableStore.self) private var store

    var body: some View {
        Group {
            if store.isKanban {
                KanbanWorkspaceView()
            } else {
                CanvasWorkspaceView()
            }
        }
        .id(store.currentGroupId)
    }
}

/// Scrollable, zoomable surface. `content` receives the logical viewport and content sizes.
struct ZoomedCanvas<Content: View>: View {
    @Environment(MemableStore.self) private var store
    let minimumSize: CGSize
    @ViewBuilder let content: (_ viewport: CGSize, _ size: CGSize) -> Content

    var body: some View {
        let zoom = CGFloat(store.zoomPercent) / 100
        GeometryReader { geometry in
            let viewport = CGSize(width: geometry.size.width / zoom, height: geometry.size.height / zoom)
            let size = CGSize(width: max(viewport.width, minimumSize.width), height: max(viewport.height, minimumSize.height))
            ScrollViewReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    content(viewport, size)
                        .frame(width: size.width, height: size.height, alignment: .topLeading)
                        .scaleEffect(zoom, anchor: .topLeading)
                        .frame(width: size.width * zoom, height: size.height * zoom, alignment: .topLeading)
                }
                .onChange(of: store.scrollRequestNoteId) { _, id in
                    guard let id else { return }
                    withAnimation { proxy.scrollTo(id, anchor: .center) }
                    store.scrollRequestNoteId = nil
                }
            }
            .onAppear { store.canvasViewportWidth = viewport.width }
            .onChange(of: viewport.width) { _, width in store.canvasViewportWidth = width }
        }
    }
}

// MARK: - Canvas mode

struct CanvasWorkspaceView: View {
    @Environment(MemableStore.self) private var store
    @State private var isDropTargeted = false

    var body: some View {
        let notes = store.currentNotes
        ZoomedCanvas(minimumSize: extent(of: notes)) { _, _ in
            ZStack(alignment: .topLeading) {
                CanvasBackground(showGrid: store.isGridSnap)
                    .onTapGesture(count: 2, coordinateSpace: .local) { location in
                        store.createTextNote(at: location)
                    }
                    .onTapGesture { NSApp.keyWindow?.makeFirstResponder(nil) }

                if notes.isEmpty {
                    Text("Double-click to create a note · ⌘V to paste · drop images or files here")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(Theme.surfaceContainer, in: Capsule())
                        .offset(x: 40, y: 40)
                        .allowsHitTesting(false)
                }

                ForEach(notes.sorted { $0.zIndex < $1.zIndex }) { note in
                    StickyNoteView(note: note)
                        .frame(width: note.width, height: note.height)
                        .id(note.id)
                        .position(x: note.x + note.width / 2, y: note.y + note.height / 2)
                }
            }
            .coordinateSpace(name: canvasSpace)
            .onContinuousHover(coordinateSpace: .local) { phase in
                if case .active(let location) = phase { store.lastPointerLocation = location }
            }
            .onDrop(of: droppableTypes, isTargeted: $isDropTargeted) { providers, location in
                store.handleDrop(providers, at: location)
            }
            .overlay { if isDropTargeted { DropHighlight() } }
        }
    }

    private func extent(of notes: [Note]) -> CGSize {
        CGSize(width: max(2000, (notes.map { $0.x + $0.width }.max() ?? 0) + 400),
               height: max(2000, (notes.map { $0.y + $0.height }.max() ?? 0) + 400))
    }
}

struct CanvasBackground: View {
    let showGrid: Bool

    var body: some View {
        Canvas { context, size in
            guard showGrid else { return }
            let step = MemableConstants.gridSize
            var path = Path()
            for x in stride(from: 0, through: size.width, by: step) {
                for y in stride(from: 0, through: size.height, by: step) {
                    path.addEllipse(in: CGRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5))
                }
            }
            context.fill(path, with: .color(Theme.outline.opacity(0.35)))
        }
        .contentShape(Rectangle())
    }
}

struct DropHighlight: View {
    var body: some View {
        ZStack {
            Theme.primary.opacity(0.08)
            Text("Drop here")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.primary)
        }
        .allowsHitTesting(false)
    }
}

/// A free-floating sticky note (canvas mode, or a free note on a Kanban board).
struct StickyNoteView: View {
    @Environment(MemableStore.self) private var store
    let note: Note
    /// Called while dragging (location in canvas space) and on release; returning true consumes the drop.
    var onDragMoved: ((CGPoint?) -> Void)?
    var onDragEnded: ((CGPoint) -> Bool)?

    @State private var dragOrigin: CGPoint?
    @State private var resizeOrigin: CGSize?

    var body: some View {
        VStack(spacing: 0) {
            NoteHeaderView(note: note, width: note.width)
                .contentShape(Rectangle())
                .gesture(moveGesture)
                .simultaneousGesture(TapGesture().onEnded {
                    if NSEvent.modifierFlags.contains(.command) { store.toggleSelection(note.id) }
                })
            Divider().opacity(0.3)
            if note.type == .text {
                NoteTextBody(note: note, fillsFrame: true)
            } else {
                ImageNoteBody(note: note)
            }
            HStack(spacing: 0) {
                Spacer()
                Text(note.sizeDescription)
                    .font(.system(size: 9))
                    .foregroundStyle(Theme.noteText.opacity(0.45))
                    .padding(.trailing, 4)
                resizeHandle
            }
            .frame(height: 16)
        }
        .background(note.color.swiftUIColor)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(dragOrigin == nil ? 0.15 : 0.3), radius: dragOrigin == nil ? 3 : 8, y: 1)
        .overlay(selectionOutline)
        .simultaneousGesture(TapGesture().onEnded { store.bringToFront(note.id) })
        .opacity(dragOrigin == nil ? 1 : 0.92)
    }

    @ViewBuilder
    private var selectionOutline: some View {
        if store.highlightedNoteId == note.id {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Theme.primary.opacity(0.6), lineWidth: 6)
                .padding(-4)
        } else if store.selectedNoteIds.contains(note.id) {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Theme.primary, lineWidth: 3)
                .padding(-4)
        }
    }

    private var moveGesture: some Gesture {
        DragGesture(minimumDistance: 2, coordinateSpace: .named(canvasSpace))
            .onChanged { value in
                if dragOrigin == nil {
                    dragOrigin = CGPoint(x: note.x, y: note.y)
                    store.bringToFront(note.id)
                    NSApp.keyWindow?.makeFirstResponder(nil)
                }
                guard let origin = dragOrigin else { return }
                let x = store.snap(max(0, origin.x + value.translation.width))
                let y = store.snap(max(0, origin.y + value.translation.height))
                store.updateNote(note.id) {
                    $0.x = x
                    $0.y = y
                }
                onDragMoved?(value.location)
            }
            .onEnded { value in
                dragOrigin = nil
                onDragMoved?(nil)
                _ = onDragEnded?(value.location)
            }
    }

    private var resizeHandle: some View {
        Image(systemName: "arrow.up.left.and.arrow.down.right")
            .font(.system(size: 8, weight: .bold))
            .rotationEffect(.degrees(90))
            .foregroundStyle(Theme.noteText.opacity(0.4))
            .frame(width: 16, height: 16)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.crosshair.push() } else { NSCursor.pop() }
            }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .named(canvasSpace))
                    .onChanged { value in
                        if resizeOrigin == nil { resizeOrigin = CGSize(width: note.width, height: note.height) }
                        guard let origin = resizeOrigin else { return }
                        let width = store.snap(max(NoteLayout.minWidth, origin.width + value.translation.width))
                        let height = store.snap(max(NoteLayout.minHeight, origin.height + value.translation.height))
                        store.updateNote(note.id) {
                            $0.width = max(NoteLayout.minWidth, width)
                            $0.height = max(NoteLayout.minHeight, height)
                        }
                    }
                    .onEnded { _ in resizeOrigin = nil }
            )
            .help("Drag to resize")
    }
}

// MARK: - Kanban mode

private struct ColumnFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { $1 })
    }
}

struct KanbanWorkspaceView: View {
    @Environment(MemableStore.self) private var store
    @State private var columnFrames: [String: CGRect] = [:]
    @State private var hoveredColumnId: String?
    @State private var isDropTargeted = false

    var body: some View {
        let columns = Kanban.normalize(store.currentGroup.kanbanColumns)
        let freeNotes = store.currentNotes.filter(\.isFreeCanvasInKanban).sorted { $0.zIndex < $1.zIndex }
        ZoomedCanvas(minimumSize: extent(of: freeNotes)) { viewport, _ in
            ZStack(alignment: .topLeading) {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2, coordinateSpace: .local) { location in
                        store.createTextNote(at: location, columnId: MemableConstants.freeCanvasColumnId)
                    }
                    .onTapGesture { NSApp.keyWindow?.makeFirstResponder(nil) }

                let spacing: CGFloat = 12
                let columnWidth = max(220, (viewport.width - spacing * 2 - spacing * CGFloat(columns.count - 1)) / CGFloat(columns.count))
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(Array(columns.enumerated()), id: \.element.id) { index, column in
                        KanbanColumnView(column: column, role: .role(index: index, count: columns.count),
                                         width: columnWidth, maxHeight: max(240, viewport.height - spacing * 2),
                                         isHovered: hoveredColumnId == column.id)
                            .background(GeometryReader { proxy in
                                Color.clear.preference(key: ColumnFramesKey.self,
                                                       value: [column.id: proxy.frame(in: .named(canvasSpace))])
                            })
                    }
                }
                .padding(spacing)

                ForEach(freeNotes) { note in
                    StickyNoteView(note: note,
                                   onDragMoved: { location in hoveredColumnId = location.flatMap(columnId(at:)) },
                                   onDragEnded: { location in
                                       guard let columnId = columnId(at: location) else { return false }
                                       store.moveNoteToColumn(note.id, columnId: columnId)
                                       return true
                                   })
                        .frame(width: note.width, height: note.height)
                        .id(note.id)
                        .position(x: note.x + note.width / 2, y: note.y + note.height / 2)
                }
            }
            .coordinateSpace(name: canvasSpace)
            .onPreferenceChange(ColumnFramesKey.self) { columnFrames = $0 }
            .onContinuousHover(coordinateSpace: .local) { phase in
                if case .active(let location) = phase { store.lastPointerLocation = location }
            }
            .onDrop(of: droppableTypes, isTargeted: $isDropTargeted) { providers, location in
                store.handleDrop(providers, at: location)
            }
        }
    }

    private func columnId(at location: CGPoint) -> String? {
        columnFrames.first { $0.value.contains(location) }?.key
    }

    private func extent(of notes: [Note]) -> CGSize {
        CGSize(width: (notes.map { $0.x + $0.width }.max() ?? 0) + 200,
               height: (notes.map { $0.y + $0.height }.max() ?? 0) + 200)
    }
}

struct KanbanColumnView: View {
    @Environment(MemableStore.self) private var store
    let column: KanbanColumn
    let role: KanbanColumnRole
    let width: CGFloat
    let maxHeight: CGFloat
    let isHovered: Bool
    @State private var isDropTargeted = false

    var body: some View {
        let cards = store.cardsInColumn(column.id)
        VStack(spacing: 0) {
            HStack {
                Text(column.name).font(.system(size: 13, weight: .semibold))
                Spacer()
                Text("\(cards.count)").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Theme.columnHeader(role))

            ViewThatFits(in: .vertical) {
                cardList(cards)
                ScrollView(.vertical) { cardList(cards) }
            }
            .frame(minHeight: 120, alignment: .top)
            .background(
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { store.createTextNote(columnId: column.id) }
            )
        }
        .frame(width: width)
        .frame(maxHeight: maxHeight, alignment: .top)
        .fixedSize(horizontal: false, vertical: true)
        .background(Theme.columnBackground(role))
        .overlay {
            if isDropTargeted || isHovered { Theme.primary.opacity(0.08).allowsHitTesting(false) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.columnBorder(role), lineWidth: 1))
        .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
        .onDrop(of: [.plainText], isTargeted: $isDropTargeted) { providers in
            guard let provider = providers.first(where: { $0.canLoadObject(ofClass: NSString.self) }) else { return false }
            _ = provider.loadObject(ofClass: NSString.self) { object, _ in
                guard let text = object as? String, let id = NoteDragPayload.noteId(from: text) else { return }
                DispatchQueue.main.async { MemableStore.shared.moveNoteToColumn(id, columnId: column.id) }
            }
            return true
        }
    }

    private func cardList(_ cards: [Note]) -> some View {
        VStack(spacing: 10) {
            ForEach(cards) { note in
                KanbanCardView(note: note, contentWidth: width - 20)
                    .id(note.id)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .top)
    }
}

struct KanbanCardView: View {
    @Environment(MemableStore.self) private var store
    let note: Note
    let contentWidth: CGFloat

    var body: some View {
        VStack(spacing: 0) {
            NoteHeaderView(note: note, width: contentWidth, compact: true)
                .contentShape(Rectangle())
                .onDrag {
                    store.draggingGroupId = nil
                    return NSItemProvider(object: NoteDragPayload.string(for: note.id) as NSString)
                }
                .simultaneousGesture(TapGesture().onEnded {
                    if NSEvent.modifierFlags.contains(.command) { store.toggleSelection(note.id) }
                })
            Divider().opacity(0.3)
            if note.type == .text {
                NoteTextBody(note: note, fillsFrame: false, contentWidth: contentWidth - NoteLayout.textInset.width * 2 - 10)
            } else {
                ImageNoteBody(note: note)
                    .frame(maxHeight: 240)
            }
        }
        .background(note.color.swiftUIColor)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.black.opacity(0.06)))
        .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
        .overlay {
            if store.highlightedNoteId == note.id {
                RoundedRectangle(cornerRadius: 14).stroke(Theme.primary.opacity(0.6), lineWidth: 6).padding(-4)
            } else if store.selectedNoteIds.contains(note.id) {
                RoundedRectangle(cornerRadius: 14).stroke(Theme.primary, lineWidth: 3).padding(-4)
            }
        }
    }
}
