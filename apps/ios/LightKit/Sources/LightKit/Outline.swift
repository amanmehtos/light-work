import Foundation

/// How a list of tasks is arranged around the subtasks and sections in it.
///
/// The Swift twin of `apps/web/src/subtasks.ts` and `sections.ts`, and for the
/// same reason the reward rule exists twice: it is a rule about what the account
/// *means*, and two clients that read it differently show the same tasks
/// differently. The cases in `OutlineTests` are the web's.
///
/// The rule, once:
///
/// - A task whose parent is in the list is drawn beneath it, one step in.
/// - A task whose parent is *not* in the list is a root, and names its parent.
/// - Nothing is ever left out: `arrange(list).count == list.count`. A count
///   anywhere is the length of this result, so a badge and its rows cannot
///   disagree.
/// - Folding hides rows, it does not remove them. A folded parent's descendants
///   stay in the result, flagged `isHidden`.
public enum Outline {

    /// One task as the list draws it.
    public struct Row: Identifiable, Equatable, Sendable {
        public var task: Task
        /// 0 for a root; one more for each parent above it that is in the list.
        public var depth: Int
        /// Set on a root that is a subtask: its parent is somewhere else.
        public var parentTitle: String?
        /// Direct subtasks finished, and in all. Counted from every task the
        /// account holds, not only those in the list, so a folded row can say
        /// what is inside it.
        public var subtasksDone: Int
        public var subtasksTotal: Int
        /// Whether any of its subtasks are in this list, and so there is
        /// something to fold.
        public var hasChildren: Bool
        /// Folded, with children to hide.
        public var isCollapsed: Bool
        /// Inside a folded ancestor: in the result, absent from the screen.
        public var isHidden: Bool

        public var id: String { task.id }
    }

    /// A row that is not part of any nesting — Completed, which is a record
    /// rather than a plan, and any list that shows a task on its own. Public
    /// because the memberwise initialiser is not.
    public static func flat(_ task: Task) -> Row {
        Row(task: task, depth: 0, parentTitle: nil, subtasksDone: 0, subtasksTotal: 0,
            hasChildren: false, isCollapsed: false, isHidden: false)
    }

    /// Arranges `list` around its subtasks. `all` is every task the account
    /// holds, completed ones included — the parent lookup and the `2/5` need it.
    public static func arrange(_ list: [Task], among all: [Task]) -> [Row] {
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var childrenOf: [String: [Task]] = [:]
        for task in all {
            if let parent = task.parentId { childrenOf[parent, default: []].append(task) }
        }

        let present = Set(list.map(\.id))
        var kids: [String: [Task]] = [:]
        var roots: [Task] = []
        for task in list {
            if let parent = task.parentId, parent != task.id, present.contains(parent) {
                kids[parent, default: []].append(task)
            } else {
                roots.append(task)
            }
        }

        var rows: [Row] = []
        var seen: Set<String> = []

        func visit(_ task: Task, depth: Int, hidden: Bool) {
            guard !seen.contains(task.id) else { return }
            seen.insert(task.id)

            let children = kids[task.id] ?? []
            let folded = task.isCollapsed && !children.isEmpty
            // A parent that cannot be found gives no hint rather than a made-up one.
            let parent = depth == 0 ? task.parentId.flatMap { byId[$0] } : nil
            let direct = childrenOf[task.id] ?? []

            rows.append(Row(
                task: task, depth: depth, parentTitle: parent?.content,
                subtasksDone: direct.filter(\.isCompleted).count,
                subtasksTotal: direct.count,
                hasChildren: !children.isEmpty,
                isCollapsed: folded,
                isHidden: hidden))
            for child in children { visit(child, depth: depth + 1, hidden: hidden || folded) }
        }

        for root in roots { visit(root, depth: 0, hidden: false) }
        // A parent cycle in bad data leaves every member with a parent that is
        // present, so none is a root. Drawn rather than lost, so "nothing is
        // ever left out" holds for bad data too.
        for task in list { visit(task, depth: 0, hidden: false) }
        return rows
    }

    // MARK: - Sections

    /// A run of rows under one heading, or the rows above the first.
    public struct SectionGroup: Identifiable, Equatable, Sendable {
        /// Nil for the rows above the first heading.
        public var section: Section?
        public var rows: [Row]

        public var id: String { section?.id ?? "" }
    }

    /// A project's rows under the headings they belong to: unsectioned first,
    /// then each section in `order`.
    ///
    /// A section is a heading, not a container of record, and this does not let
    /// one make a task unreachable. A task naming a section that is not there is
    /// drawn with the unsectioned rows; an archived section is hidden unless it
    /// still holds work. A subtask follows its parent whatever its own
    /// `sectionId` says, because it is drawn beneath it.
    public static func groups(_ rows: [Row], sections: [Section]) -> [SectionGroup] {
        // Plain string comparison, as `compareOrder` does on the web.
        let ordered = sections.sorted { $0.order < $1.order }
        let known = Set(ordered.map(\.id))

        var root = SectionGroup(section: nil, rows: [])
        var bySection: [String: [Row]] = [:]
        var current: String? = nil

        for row in rows {
            // A root row picks the group; the rows beneath it follow it.
            if row.depth == 0 {
                current = row.task.sectionId.flatMap { known.contains($0) ? $0 : nil }
            }
            if let current { bySection[current, default: []].append(row) } else { root.rows.append(row) }
        }

        var groups = [root]
        for section in ordered {
            let rows = bySection[section.id] ?? []
            if section.isArchived && rows.isEmpty { continue }
            groups.append(SectionGroup(section: section, rows: rows))
        }
        return groups
    }

    /// The rows that are on the screen: not folded under a task, nor inside a
    /// folded section.
    public static func onScreen(_ groups: [SectionGroup]) -> [Row] {
        groups.flatMap { group -> [Row] in
            if let section = group.section, section.isCollapsed { return [] }
            return group.rows.filter { !$0.isHidden }
        }
    }
}
