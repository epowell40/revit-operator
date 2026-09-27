import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/snapshot.js";

/** One shared view for status, resumed reasoning and the user-facing handoff. */
export function projectAdvisoryFollowupsV2(snapshot: AssignmentSnapshotV2, start = 0) {
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("advisory_followup_page_invalid");
  const retained = snapshot.advisory_followups ?? [];
  const pending = retained.filter(item => item.state === "open" || item.state === "deferred");
  const items: typeof pending = [];
  for (const item of pending.slice(start, start + 8)) {
    // A legal 1,000-character text and reason can each escape to 6,000 JSON bytes.
    if (new TextEncoder().encode(JSON.stringify([...items, item])).length > 16384) break;
    items.push(item);
  }
  const end = Math.min(start + items.length, pending.length);
  return { verified: false as const, assignment_version: snapshot.assignment_version, retained_total: retained.length, unresolved_total: pending.length,
    deferred_total: pending.filter(item => item.state === "deferred").length,
    start, items, not_shown: pending.length - items.length,
    next_start: end < pending.length ? end : null,
    pagination: "operator_manage_work_plan action=status followupStart=<next_start>; start at 0 again if assignment_version changes.",
    notice: "Assistant reports only. Deferred items remain unfinished. Explicit dispositions do not establish native effects, verification or task completion." };
}

export function advisoryFollowupsContextV2(snapshot: AssignmentSnapshotV2): string {
  const page = projectAdvisoryFollowupsV2(snapshot);
  return page.unresolved_total ? ["SAVED UNFINISHED ITEMS (UNVERIFIED):", JSON.stringify(page),
    "Use operator_manage_work_plan action=update_followup for an explicit disposition with a reason. Resolve only the exact item addressed; dispositions remain unverified assistant claims.",
    "For a partly addressed compound report, leave it open or mark it deferred with a reason explaining which clauses remain. To replace it, use superseded with replacements=[{kind, text}, ...] in the same update_followup command before proposing completion. This atomically retains the unfinished clauses and retires the parent. Omission or paraphrasing never resolves a saved report."
  ].join("\n") : "";
}

export function advisoryFollowupsHandoffV2(snapshot: AssignmentSnapshotV2): string {
  const page = projectAdvisoryFollowupsV2(snapshot);
  if (!page.unresolved_total) return "";
  return ["### Saved unfinished items (unverified)",
    "These earlier reports remain open unless explicitly resolved or superseded; deferred reports stay visible.",
    ...page.items.map(item => "- " + (item.state === "deferred" ? "Deferred: " : "") + item.text.replace(/\r?\n/g, "\n  ") + (item.disposition_reason ? " Reason: " + item.disposition_reason : "")),
    ...(page.not_shown ? [page.not_shown + " more unfinished items are saved. This handoff shows the first page; the assistant can retrieve the rest from saved task status."] : [])
  ].join("\n\n");
}
