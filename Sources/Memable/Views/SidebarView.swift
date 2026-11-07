import MemableCore
import SwiftUI
import UniformTypeIdentifiers

struct SidebarView: View {
    @Environment(MemableStore.self) private var store

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(visibleRows, id: \.group.id) { row in
                    GroupRowView(group: row.group, depth: row.depth)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack {
                Text("Groups")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button { store.activeSheet = .newGroup } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
                .help("New Group (⇧⌘N)")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    private var visibleRows: [(group: NoteGroup, depth: Int)] {
        var hiddenParents = Set<String>()
        var rows: [(group: NoteGroup, depth: Int)] = []
        for row in store.groupTree {
            if let parent = row.group.parentId, hiddenParents.contains(parent) {
                hiddenParents.insert(row.group.id)
                continue
            }
            if store.collapsedGroupIds.contains(row.group.id) { hiddenParents.insert(row.group.id) }
            rows.append(row)
        }
        return rows
    }
}

private struct GroupRowView: View {
    @Environment(MemableStore.self) private var store
    let group: NoteGroup
    let depth: Int

    @State private var isHovering = false
    @State private var dropPosition: GroupDropPosition?
    @State private var rowHeight: CGFloat = 30

    private var isActive: Bool { store.currentGroupId == group.id }

    var body: some View {
        HStack(spacing: 4) {
            Button {
                store.toggleCollapsed(group.id)
            } label: {
                Image(systemName: store.collapsedGroupIds.contains(group.id) ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .frame(width: 14, height: 14)
            }
            .buttonStyle(.plain)
            .opacity(store.hasChildren(group.id) ? 0.8 : 0)
            .disabled(!store.hasChildren(group.id))

            Image(systemName: group.viewMode == .kanban ? "rectangle.split.3x1" : "note.text")
                .font(.system(size: 11))
                .frame(width: 16)
                .opacity(0.8)

            Text(group.name)
                .lineLimit(1)
                .truncationMode(.tail)
                .help("Double-click to rename")

            Spacer(minLength: 0)

            if isHovering {
                HStack(spacing: 2) {
                    rowButton("slider.horizontal.3", help: "Customize Kanban steps") {
                        store.activeSheet = .kanbanSteps(group.id)
                    }
                    rowButton(group.viewMode == .kanban ? "note.text" : "rectangle.split.3x1",
                              help: group.viewMode == .kanban ? "Switch to Canvas mode" : "Switch to Kanban mode") {
                        store.toggleViewMode(group.id)
                    }
                    if group.id != MemableConstants.defaultGroupId {
                        rowButton("trash", help: "Delete group and its notes") {
                            store.deleteGroup(group.id)
                        }
                    }
                }
            }
        }
        .font(.system(size: 13))
        .padding(.leading, 4 + CGFloat(depth) * 14)
        .padding(.trailing, 6)
        .frame(height: 28)
        .foregroundStyle(isActive ? Theme.onPrimary : Color.primary)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(isActive ? Theme.primary : (isHovering ? Theme.secondaryContainer : Color.clear))
        )
        .overlay(dropIndicator)
        .contentShape(Rectangle())
        .onHover { isHovering = $0 }
        .onTapGesture { store.switchGroup(group.id) }
        .simultaneousGesture(TapGesture(count: 2).onEnded { store.activeSheet = .renameGroup(group.id) })
        .contextMenu {
            Button("Rename…") { store.activeSheet = .renameGroup(group.id) }
            Button("Kanban Steps…") { store.activeSheet = .kanbanSteps(group.id) }
            Button(group.viewMode == .kanban ? "Switch to Canvas" : "Switch to Kanban") { store.toggleViewMode(group.id) }
            if group.id != MemableConstants.defaultGroupId {
                Divider()
                Button("Delete Group…", role: .destructive) { store.deleteGroup(group.id) }
            }
        }
        .background(GeometryReader { proxy in
            Color.clear.onAppear { rowHeight = proxy.size.height }
        })
        .onDrag {
            store.draggingGroupId = group.id
            return NSItemProvider(object: "memable-group:\(group.id)" as NSString)
        }
        .onDrop(of: [.plainText], delegate: GroupDropDelegate(store: store, targetId: group.id,
                                                              rowHeight: rowHeight, position: $dropPosition))
        .help("Drag to reorder or nest")
    }

    @ViewBuilder
    private var dropIndicator: some View {
        switch dropPosition {
        case .before:
            VStack { Rectangle().fill(Theme.primary).frame(height: 2); Spacer() }
        case .after:
            VStack { Spacer(); Rectangle().fill(Theme.primary).frame(height: 2) }
        case .inside:
            RoundedRectangle(cornerRadius: 7).stroke(Theme.primary, lineWidth: 2)
        case nil:
            EmptyView()
        }
    }

    private func rowButton(_ systemName: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 11))
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

private struct GroupDropDelegate: DropDelegate {
    let store: MemableStore
    let targetId: String
    let rowHeight: CGFloat
    @Binding var position: GroupDropPosition?

    private func dropPosition(_ info: DropInfo) -> GroupDropPosition {
        let ratio = info.location.y / max(rowHeight, 1)
        if ratio < 0.25 { return .before }
        if ratio > 0.75 { return .after }
        return .inside
    }

    private var isValid: Bool {
        guard let dragged = store.draggingGroupId else { return false }
        return store.canDropGroup(dragged, on: targetId)
    }

    func validateDrop(info: DropInfo) -> Bool { isValid }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        guard isValid else { return DropProposal(operation: .forbidden) }
        position = dropPosition(info)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        position = nil
    }

    func performDrop(info: DropInfo) -> Bool {
        defer {
            position = nil
            store.draggingGroupId = nil
        }
        guard isValid, let dragged = store.draggingGroupId else { return false }
        store.moveGroup(dragged, onto: targetId, position: dropPosition(info))
        return true
    }
}
