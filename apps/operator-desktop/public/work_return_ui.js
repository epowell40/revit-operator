export const WORK_RETURN_SCHEMA = "revit-operator.work-return/v1";

const LIMIT = 20;

function escapeHtml(value) {
  return `${value ?? ""}`.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] || character);
}

function words(value) {
  return `${value || ""}`.replace(/_/g, " ").trim();
}

function boundedStrings(values) {
  const rows = Array.isArray(values)
    ? values.map((value) => `${value || ""}`.trim()).filter(Boolean)
    : [];
  return Object.freeze({ rows: Object.freeze(rows.slice(0, LIMIT)), total: rows.length });
}

export function workReturnStatusPresentation(status) {
  const presentations = {
    active: { label: "Active", tone: "tone-info" },
    awaiting_user_input: { label: "Awaiting input", tone: "tone-warning" },
    awaiting_user_review: { label: "Awaiting review", tone: "tone-warning" },
    complete: { label: "Complete", tone: "tone-positive" },
    complete_with_issues: { label: "Complete with issues", tone: "tone-warning" },
    verified_noop: { label: "Verified no-op", tone: "tone-positive" },
    blocked: { label: "Blocked", tone: "tone-warning" },
    failed: { label: "Failed", tone: "tone-danger" }
  };
  return presentations[`${status || ""}`] || { label: "Unavailable", tone: "tone-neutral" };
}

export function buildWorkReturnView(workReturn) {
  if (!workReturn || workReturn.schema !== WORK_RETURN_SCHEMA) return null;
  return Object.freeze({
    workReturn,
    status: Object.freeze(workReturnStatusPresentation(workReturn.status)),
    completed: boundedStrings(workReturn.completed),
    primaryArtifacts: boundedStrings(workReturn.primary_artifacts),
    openItems: boundedStrings(workReturn.deviations_or_open_items),
    affectedTargets: boundedStrings(workReturn.affected_targets),
    visuals: boundedStrings(workReturn.visual_refs)
  });
}

function list(collection, empty) {
  const rows = collection.rows.length
    ? collection.rows.map((value) => `<li>${escapeHtml(value)}</li>`).join("")
    : `<li>${escapeHtml(empty)}</li>`;
  const note = collection.total > collection.rows.length
    ? `<p class="workReturnLimitNote">Showing ${collection.rows.length} of ${collection.total} items.</p>`
    : "";
  return `<ul>${rows}</ul>${note}`;
}

export function renderWorkReturnHtml(workReturn) {
  const view = buildWorkReturnView(workReturn);
  if (!view) return "";
  const question = `${workReturn.question || ""}`.trim();
  return `
    <div class="workReturnHeader">
      <div>
        <p class="paneKicker">Work return</p>
        <h3>Your Revit work</h3>
      </div>
      <span class="assignmentStatus ${view.status.tone}">${escapeHtml(view.status.label)}</span>
    </div>
    <p class="workReturnReason">${escapeHtml(words(workReturn.status_reason))}</p>
    <section><h4>Completed</h4>${list(view.completed, "No completed work has been established yet.")}</section>
    <section><h4>Primary artifact</h4>${list(view.primaryArtifacts, "No primary artifact has been recorded yet.")}</section>
    ${view.openItems.total ? `<section class="workReturnOpenItems"><h4>Deviations or open items</h4>${list(view.openItems, "None.")}</section>` : ""}
    ${question ? `<section class="workReturnQuestion"><h4>Question</h4><p>${escapeHtml(question)}</p></section>` : ""}
    <section><h4>Recommended next step</h4><p>${escapeHtml(workReturn.recommended_next_step || "Review the returned work.")}</p></section>
    ${view.affectedTargets.total ? `<details><summary>Affected targets</summary>${list(view.affectedTargets, "None recorded.")}</details>` : ""}
    ${view.visuals.total ? `<details><summary>Visual references</summary>${list(view.visuals, "None recorded.")}</details>` : ""}
    <p class="workReturnIdentity"><code>${escapeHtml(workReturn.work_return_id || "")}</code> · generation ${escapeHtml(workReturn.generation)}</p>`;
}
