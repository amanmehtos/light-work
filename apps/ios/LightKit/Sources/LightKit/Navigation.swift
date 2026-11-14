import Foundation

/// Where the phone can go: the inbox, and the projects as a tree.
///
/// The Swift twin of what `apps/web/src/components/Sidebar.tsx` decides about
/// the project list, kept here (and tested) rather than in a view because the
/// rules are about the account and not the screen, and the web's counts are what
/// this one has to match.
///
/// - The **inbox** is a place you go, not a project you organise: the project
///   flagged `isInbox`, never one that is merely called "Inbox". When two devices
///   each made one before syncing, the lowest id is the real one — the rule
///   `ensureInbox` uses — and the strays are left out of the tree rather than
///   advertising the bug.
/// - Projects nest to any depth, drawn depth first in `order`.
/// - Anything filed under the inbox rises to the top level, because the inbox
///   draws no branch to hang it from and a project that cannot be reached is
///   worse than one that moved up.
/// - Archived projects are out, and the trophy cabinet with them while rewards
///   are off.
public enum Navigation {

    /// A project and how far in it is drawn.
    public struct Entry: Identifiable, Equatable, Sendable {
        public var project: Project
        public var depth: Int

        public var id: String { project.id }
    }

    /// The inbox, if the account has one.
    public static func inbox(_ projects: [Project]) -> Project? {
        projects.filter { $0.isInbox && !$0.isArchived }.min { $0.id < $1.id }
    }

    /// Every project worth showing in the tree, in the order it is drawn.
    public static func projectTree(_ projects: [Project], rewardsEnabled: Bool) -> [Entry] {
        let shown = projects.filter { !$0.isArchived && (rewardsEnabled || !$0.isRewards) }
        let inboxId = inbox(shown)?.id

        var byParent: [String?: [Project]] = [:]
        for project in shown where !project.isInbox {
            let parent = project.parentId == inboxId && inboxId != nil ? nil : project.parentId
            byParent[parent, default: []].append(project)
        }
        for key in byParent.keys { byParent[key]?.sort { $0.order < $1.order } }

        var entries: [Entry] = []
        var seen: Set<String> = []
        func walk(_ parent: String?, depth: Int) {
            for project in byParent[parent] ?? [] where !seen.contains(project.id) {
                // A parent cycle in bad data has no root, so it is never reached;
                // this only keeps a repeated id from drawing a project twice.
                seen.insert(project.id)
                entries.append(Entry(project: project, depth: depth))
                walk(project.id, depth: depth + 1)
            }
        }
        walk(nil, depth: 0)
        return entries
    }

    /// Where a new project can be filed, in the order the tree draws them.
    ///
    /// The Swift twin of `parentChoices` in `apps/web/src/projects.ts`: every
    /// project the tree shows except the trophy cabinet, which nothing is filed
    /// under by hand and `Operations.createProject` refuses. The inbox is not in
    /// the tree and so not here. What is offered is exactly what will be
    /// accepted, and exactly what can be seen.
    public static func parentChoices(_ projects: [Project], rewardsEnabled: Bool) -> [Entry] {
        projectTree(projects, rewardsEnabled: rewardsEnabled).filter { !$0.project.isRewards }
    }
}
