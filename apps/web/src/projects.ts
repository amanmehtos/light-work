/**
 * The project tree, as the sidebar draws it and as "add a project" offers it.
 *
 * It lives apart from `Sidebar.tsx` for the reason `subtasks.ts` and `days.ts`
 * do: the rules are about the account and not the screen, and there are now two
 * readers of them. The sidebar draws the tree from `byParent`; the add-project
 * form lists the same tree as places to file a new project. If each worked out
 * for itself which projects count — archived ones out, the inbox its own entry
 * and not a branch, the trophies hidden with rewards off — they would eventually
 * disagree, and the form would offer a parent the sidebar cannot show, so the
 * project made under it would be one nothing draws. One function, so what can be
 * chosen is exactly what can be seen.
 *
 * Projects nest arbitrarily deep (the account this was built against goes three
 * levels), so the tree is walked recursively rather than assuming a depth.
 */

import type { Project } from "@light/core";
import { compareOrder } from "@light/core";

export interface ProjectTree {
  /** The project flagged `isInbox`, which is a place you go and not a branch. */
  inbox: Project | null;
  /** Children by parent id; `null` keys the top level. Each list is in `order`. */
  byParent: Map<string | null, Project[]>;
}

export function projectTree(all: readonly Project[], rewardsEnabled: boolean): ProjectTree {
  const shown = all
    .filter((project) => !project.isArchived)
    .filter((project) => rewardsEnabled || !project.isRewards);

  // Which one is by flag, never by name: a project merely called "Inbox" is not it.
  const inbox = shown.find((project) => project.isInbox) ?? null;
  const byParent = new Map<string | null, Project[]>();
  for (const project of shown) {
    // Every flagged inbox, not just the one the nav entry chose. Duplicates
    // should not exist — `ensureInbox` keeps one — but a cold-start race on
    // two devices can still mint a second, and when that happens the sidebar
    // showing "Inbox" twice is how the user finds out. One entry at the top,
    // and the strays stay out of the tree rather than advertising the bug.
    if (project.isInbox) continue;
    // Anything filed under the inbox rises to the top level instead, because
    // the inbox no longer draws a branch to hang it from, and a project that
    // cannot be reached from the sidebar is worse than one that moved up.
    const parentId = inbox !== null && project.parentId === inbox.id ? null : project.parentId;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(project);
    byParent.set(parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => compareOrder(a.order, b.order));
  }
  return { inbox, byParent };
}

/** A project and how far in it is drawn. */
export interface ParentChoice {
  project: Project;
  depth: number;
}

/**
 * Where a new project can be filed, in the order the sidebar draws them.
 *
 * Every project the tree shows, except the trophy cabinet: it holds what has
 * been earned, nothing is filed under it by hand, and `Operations.createProject`
 * refuses it. The inbox is not in the tree and so not here either — also refused
 * there — which means this list is exactly the parents that will be accepted.
 *
 * Walked down from the top, so a project under an archived parent, which the
 * sidebar cannot reach, is not offered either.
 */
export function parentChoices(tree: ProjectTree): ParentChoice[] {
  const out: ParentChoice[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    for (const project of tree.byParent.get(parentId) ?? []) {
      if (seen.has(project.id)) continue;
      seen.add(project.id);
      if (!project.isRewards) out.push({ project, depth });
      walk(project.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
