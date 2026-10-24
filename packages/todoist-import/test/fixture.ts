import type { SyncExport } from "../src/types.js";

/**
 * A fixture mirroring the real account this importer was built against:
 * three levels of project nesting, sections whose descriptions hold the actual
 * plan in markdown, a task with both a due date and a separate deadline, labels
 * that exist only as names on tasks, and several kinds of dangling reference.
 */
export const realisticExport: SyncExport = {
  full_sync: true,
  sync_token: "abc",
  user: { id: "41204131", full_name: "Aman", tz_info: { timezone: "Asia/Bangkok" } },
  projects: [
    { id: "inbox", name: "Inbox", inbox_project: true, child_order: 0 },
    { id: "p_arme", name: "🏔️ ARME 🏆 Collection", child_order: 15, color: "teal", is_favorite: true },
    { id: "p_kyc", name: "📍 Develop KYC🏆 MEHTOS 247 SF", parent_id: "p_arme", child_order: 16 },
    { id: "p_3wm", name: "🔬 3WM 🏆 Assets", child_order: 38 },
    { id: "p_bisno", name: "💵 BISNO 🏆 LEASY SF", parent_id: "p_3wm", child_order: 40 },
    // Third level of nesting — the Light Suite projects live here.
    { id: "p_lw", name: "❓ Develop Light Week🏆❓", parent_id: "p_bisno", child_order: 46 },
    { id: "p_archived", name: "✅WP SHEPHERD 🏆 DJI Avata 2", child_order: 37, is_archived: true },
    // Parent that is not in the export at all.
    { id: "p_orphan", name: "Orphaned project", parent_id: "p_gone", child_order: 50 },
    { id: "p_deleted", name: "Deleted project", child_order: 99, is_deleted: true },
  ],
  sections: [
    {
      id: "s_phase1",
      project_id: "p_kyc",
      name: "🔨 Phase 1 — DO (now → Sep 21)",
      section_order: 2,
      description:
        "⛔ Everything here exists to put a finished, playable Night One in front of people.\n\nTHE CHAIN:\nAug 29-31 — MegaGrants weekend",
    },
    { id: "s_phase2", project_id: "p_kyc", name: "📊 Phase 2 — VALIDATE DEMAND", section_order: 3 },
    { id: "s_gone_project", project_id: "p_nonexistent", name: "Section of a missing project", section_order: 1 },
  ],
  labels: [
    { id: "l_focus", name: "focus", color: "charcoal", item_order: 5 },
    { id: "l_read", name: "read", color: "charcoal", item_order: 1 },
  ],
  items: [
    {
      id: "i_deck",
      project_id: "p_kyc",
      section_id: "s_phase2",
      content: "Ready publisher pitch deck",
      description: "Needed for BOTH applications on the Aug 29-30 weekend.",
      // Todoist's 4 means urgent, which must come out as p1.
      priority: 4,
      child_order: 1,
      day_order: 2,
      due: { date: "2026-10-24", string: "24 Oct", is_recurring: false },
      deadline: { date: "2026-10-24", lang: "en" },
      labels: ["focus", "TNIGA"],
      added_at: "2026-06-10T05:00:31.705Z",
    },
    {
      id: "i_subtask",
      project_id: "p_kyc",
      section_id: "s_phase2",
      parent_id: "i_deck",
      content: "Competitive slide vs HELLMART",
      priority: 2,
      child_order: 1,
      duration: { amount: 90, unit: "minute" },
      labels: ["EMS"],
    },
    {
      id: "i_recurring",
      project_id: "p_kyc",
      content: "Log wishlists",
      priority: 1,
      child_order: 5,
      due: {
        date: "2026-10-24T09:00:00.000000Z",
        string: "every saturday at 9am",
        is_recurring: true,
        timezone: "Asia/Bangkok",
      },
    },
    {
      id: "i_done",
      project_id: "p_kyc",
      content: "Submit demo build",
      priority: 4,
      child_order: 2,
      checked: true,
      completed_at: "2026-09-16T10:00:00.000000Z",
    },
    // Parent task not in the export — typically an archived parent.
    { id: "i_orphan", project_id: "p_kyc", content: "Orphaned subtask", parent_id: "i_gone", child_order: 9 },
    // Section not in the export.
    { id: "i_badsection", project_id: "p_kyc", content: "Task in a vanished section", section_id: "s_gone", child_order: 10 },
    // Project not in the export.
    { id: "i_badproject", project_id: "p_nonexistent", content: "Task in a vanished project", child_order: 1 },
    { id: "i_badpriority", project_id: "p_kyc", content: "Weird priority", priority: 9, child_order: 11 },
    { id: "i_badduration", project_id: "p_kyc", content: "Weird duration", duration: { amount: 3, unit: "fortnight" }, child_order: 12 },
    { id: "i_deleted", project_id: "p_kyc", content: "Deleted task", is_deleted: true, child_order: 13 },
  ],
  notes: [
    { id: "n_1", item_id: "i_deck", content: "Lead with Indian-studio economics.", posted_at: "2026-06-11T00:00:00Z" },
    {
      id: "n_attach",
      item_id: "i_deck",
      content: "Deck v3",
      posted_at: "2026-06-12T00:00:00Z",
      file_attachment: { file_name: "deck.pdf", file_type: "application/pdf", file_url: "https://example.com/deck.pdf", file_size: 2048 },
    },
    { id: "n_project", project_id: "p_kyc", content: "Project-level note", posted_at: "2026-06-13T00:00:00Z" },
    { id: "n_orphan", item_id: "i_gone", content: "Note on a vanished task", posted_at: "2026-06-14T00:00:00Z" },
  ],
  reminders: [
    { id: "r_rel", item_id: "i_deck", type: "relative", minute_offset: 30 },
    { id: "r_abs", item_id: "i_deck", type: "absolute", due: { date: "2026-10-24T08:00:00.000000Z" } },
    {
      id: "r_loc",
      item_id: "i_deck",
      type: "location",
      name: "Office",
      loc_lat: "13.7563",
      loc_long: "100.5018",
      radius: 150,
      loc_trigger: "on_enter",
    },
    { id: "r_orphan", item_id: "i_gone", type: "relative", minute_offset: 10 },
  ],
  filters: [
    { id: "f_waiting", name: "Waiting For", query: "assigned to: waiting", item_order: 1, color: "charcoal" },
    { id: "f_p1", name: "Priority 1", query: "priority 1", item_order: 2, color: "charcoal" },
  ],
};
