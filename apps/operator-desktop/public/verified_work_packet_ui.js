export const VERIFIED_WORK_PACKET_SCHEMA = "revit-operator.verified-work-packet/v1";

const LIMITS = Object.freeze({
  targets: 50,
  criteria: 100,
  collateral: 50,
  artifacts: 50,
  issues: 50,
  actions: 50,
  evidence: 100
});

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

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return `${value}`;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized;
  } catch {
    return "—";
  }
}

function bounded(values, limit) {
  const rows = Array.isArray(values) ? values : [];
  return Object.freeze({
    rows: Object.freeze(rows.slice(0, limit)),
    total: rows.length,
    truncated: rows.length > limit
  });
}

function evidenceFromPacket(packet) {
  const byId = new Map();
  const add = (reference) => {
    const evidenceId = `${reference?.evidence_id || ""}`.trim();
    if (!evidenceId || byId.has(evidenceId)) return;
    byId.set(evidenceId, reference);
  };
  for (const criterion of packet.acceptance_criteria || []) {
    for (const reference of criterion?.evidence_references || []) add(reference);
  }
  for (const check of packet.collateral_checks || []) {
    for (const reference of check?.evidence_references || []) add(reference);
  }
  for (const action of packet.actions || []) {
    for (const reference of action?.receipt_references || []) add(reference);
    for (const reference of action?.evidence_references || []) add(reference);
  }
  for (const artifact of packet.artifacts || []) add(artifact?.evidence_reference);
  for (const issue of packet.issues || []) {
    for (const reference of issue?.evidence_references || []) add(reference);
  }
  return [...byId.values()];
}

export function verifiedWorkPacketStatusPresentation(status) {
  const presentations = {
    verified_complete: { label: "Requested result verified", tone: "tone-positive" },
    complete_with_issues: { label: "Complete with issues", tone: "tone-warning" },
    verified_no_op: { label: "Verified no-op", tone: "tone-positive" },
    blocked_truthfully: { label: "Blocked truthfully", tone: "tone-warning" },
    awaiting_clarification: { label: "Awaiting clarification", tone: "tone-warning" },
    failed: { label: "Failed", tone: "tone-danger" },
    rolled_back: { label: "Rolled back", tone: "tone-neutral" }
  };
  return presentations[`${status || ""}`] || { label: "Unavailable", tone: "tone-neutral" };
}

export function buildVerifiedWorkPacketView(packet) {
  if (!packet || packet.schema !== VERIFIED_WORK_PACKET_SCHEMA) return null;
  const targets = bounded(packet.grounded_targets, LIMITS.targets);
  const criteria = bounded(packet.acceptance_criteria, LIMITS.criteria);
  const collateral = bounded(packet.collateral_checks, LIMITS.collateral);
  const artifacts = bounded(packet.artifacts, LIMITS.artifacts);
  const issues = bounded(packet.issues, LIMITS.issues);
  const actions = bounded(packet.actions, LIMITS.actions);
  const evidence = bounded(evidenceFromPacket(packet), LIMITS.evidence);
  const trust = packet.trust_presentation || {};
  const changes = (packet.actions || []).some(action => ["applied", "unknown"].includes(action.effect?.state));
  const checks = (packet.collateral_checks || []).filter(check => check.status !== "not_applicable");
  const collateralSummary = checks.some(check => check.status === "fail")
    ? "Other changes: a recorded check failed."
    : checks.length && checks.every(check => check.status === "pass" && ["independently_verified", "native_execution_evidence"].includes(check.trust))
      ? "Other changes: recorded checks passed. This covers only the listed checks."
      : checks.length ? "Other changes: assessment incomplete."
        : changes ? "Other changes not assessed. No collateral checks were recorded."
          : "No model changes recorded; no collateral assessment is claimed.";
  return Object.freeze({
    packet,
    status: Object.freeze(verifiedWorkPacketStatusPresentation(packet.status)),
    targets,
    criteria,
    collateral,
    artifacts,
    issues,
    actions,
    evidence,
    collateralSummary,
    trustBadges: Object.freeze([
      Object.freeze({ key: "overall", label: `Acceptance evidence: ${words(trust.overall || "uncertain_or_missing")}` }),
      Object.freeze({ key: "agent", label: "Agent-reported", detail: trust.agent_reported || "" }),
      Object.freeze({ key: "native", label: "Native evidence", detail: trust.native_execution_evidence || "" }),
      Object.freeze({ key: "verified", label: "Independently verified", detail: trust.independently_verified || "" }),
      Object.freeze({ key: "uncertain", label: "Uncertain / missing", detail: trust.uncertain_or_missing || "" })
    ])
  });
}

function truncationNote(collection, noun) {
  return collection.truncated
    ? `<p class="workPacketLimitNote">Showing ${collection.rows.length} of ${collection.total} ${escapeHtml(noun)}.</p>`
    : "";
}

function targetText(target) {
  return [
    target?.identity,
    target?.element_id ? `element ${target.element_id}` : "",
    target?.view_id ? `view ${target.view_id}` : "",
    target?.sheet_id ? `sheet ${target.sheet_id}` : "",
    target?.family_id ? `family ${target.family_id}` : "",
    target?.type_id ? `type ${target.type_id}` : "",
    target?.system_id ? `system ${target.system_id}` : "",
    target?.room_id ? `room ${target.room_id}` : "",
    target?.space_id ? `space ${target.space_id}` : "",
    target?.level_id ? `level ${target.level_id}` : "",
    target?.host_id ? `host ${target.host_id}` : "",
    target?.side,
    target?.orientation,
    target?.circuit_id ? `circuit ${target.circuit_id}` : ""
  ].filter(Boolean).join(" · ");
}

function artifactText(artifact) {
  const reference = artifact?.evidence_reference || {};
  return [
    words(artifact?.role || "artifact"),
    artifact?.path,
    artifact?.content_hash,
    Number.isFinite(Number(artifact?.byte_count)) ? `${artifact.byte_count} bytes` : "",
    reference?.evidence_id ? `evidence ${reference.evidence_id}` : ""
  ].filter(Boolean).join(" · ");
}

export function renderVerifiedWorkPacketHtml(packet, assignmentId = "") {
  const view = buildVerifiedWorkPacketView(packet);
  if (!view) return "";
  const reportHref = `/api/assignments/${encodeURIComponent(assignmentId || packet.identity?.assignment_id || "")}/verified-work-packet?format=markdown`;
  const criteriaRows = view.criteria.rows.map((criterion) => `
    <tr>
      <td><span class="workPacketCriterionStatus status-${escapeHtml(criterion.status)}">${escapeHtml(words(criterion.status))}</span></td>
      <td>${escapeHtml(criterion.requirement)}</td>
      <td><strong>Observed:</strong> ${escapeHtml(displayValue(criterion.observed_value))}<br><strong>Expected:</strong> ${escapeHtml(displayValue(criterion.expected_value))}</td>
      <td>${escapeHtml(criterion.authority || "unknown")}<br><span class="workPacketTrustInline">${escapeHtml(words(criterion.trust))}</span><br>${Number(criterion.evidence_references?.length || 0)} evidence refs</td>
      <td>${escapeHtml(criterion.reason || "")}</td>
    </tr>`).join("");
  const collateralRows = view.collateral.rows.map((check) => `
    <li><strong>${escapeHtml(words(check.status))}:</strong> ${escapeHtml(check.invariant)} — ${escapeHtml(check.reason || "")} <span class="workPacketTrustInline">${escapeHtml(words(check.trust))}</span></li>`).join("");
  const actionRows = view.actions.rows.map((action) => `
    <li>
      <strong>${escapeHtml(action.action_path || action.tool_identity || "Action")}</strong>
      <span>${escapeHtml(action.attempt_id)} · effect ${escapeHtml(action.effect?.state || "unknown")} · ${escapeHtml(words(action.verification?.state || "unknown"))}</span>
      <span>${escapeHtml(action.result || action.effect?.reason || "")}</span>
      ${action.verification?.reason ? `<span>${escapeHtml(action.verification.reason)}</span>` : ""}
      ${action.retry_of_attempt_id ? `<span>Retry of ${escapeHtml(action.retry_of_attempt_id)} · ${escapeHtml(words(action.retry_delta || ""))}</span>` : ""}
      ${action.reconciliation_of_attempt_id ? `<span>Reconciles ${escapeHtml(action.reconciliation_of_attempt_id)}</span>` : ""}
    </li>`).join("");
  const evidenceRows = view.evidence.rows.map((reference) => `
    <li><code>${escapeHtml(reference.evidence_id)}</code> · ${escapeHtml(words(reference.trust))} · ${escapeHtml(reference.bounded_summary || reference.verification_relevance || "")}</li>`).join("");
  return `
    <div class="workPacketHeader">
      <div>
        <p class="paneKicker">Verified work packet</p>
        <h3>Customer-readable completion record</h3>
      </div>
      <span class="assignmentStatus ${view.status.tone}">${escapeHtml(view.status.label)}</span>
    </div>
    <p class="workPacketReason">${escapeHtml(words(packet.status_reason))}</p>
    <div class="workPacketTrustBadges">${view.trustBadges.filter(badge => badge.key === "overall").map((badge) => `<span class="workPacketTrustBadge">${escapeHtml(badge.label)}</span>`).join("")}</div>
    <p class="workPacketVerificationScope">Acceptance evidence applies to the recorded acceptance criteria. ${escapeHtml(view.collateralSummary)}</p>
    <p class="workPacketIdentity"><code>${escapeHtml(packet.packet_id)}</code> · generation ${escapeHtml(packet.identity?.generation)} · ${escapeHtml(packet.identity?.source_release_identity || "release unknown")}</p>
    <a class="workPacketReportLink" href="${escapeHtml(reportHref)}" target="_blank" rel="noopener">Open packet report</a>
    <section>
      <h4>Affected targets</h4>
      <ul class="workPacketTargetList">${view.targets.rows.length ? view.targets.rows.map((target) => `<li><code>${escapeHtml(targetText(target))}</code></li>`).join("") : "<li>No grounded targets recorded.</li>"}</ul>
      ${truncationNote(view.targets, "targets")}
    </section>
    <section>
      <h4>Acceptance criteria</h4>
      <div class="workPacketTableWrap"><table class="workPacketTable"><thead><tr><th>Status</th><th>Requirement</th><th>Values</th><th>Authority</th><th>Reason</th></tr></thead><tbody>${criteriaRows || '<tr><td colspan="5">No acceptance criteria recorded.</td></tr>'}</tbody></table></div>
      ${truncationNote(view.criteria, "criteria")}
    </section>
    <section>
      <h4>Collateral checks</h4>
      <ul>${collateralRows || "<li>No collateral checks recorded.</li>"}</ul>
      ${truncationNote(view.collateral, "checks")}
    </section>
    <section>
      <h4>Artifacts</h4>
      <ul>${view.artifacts.rows.length ? view.artifacts.rows.map((artifact) => `<li>${escapeHtml(artifactText(artifact))}</li>`).join("") : "<li>No artifacts recorded.</li>"}</ul>
      ${truncationNote(view.artifacts, "artifacts")}
    </section>
    <section class="${view.issues.total ? "workPacketIssues" : ""}">
      <h4>Unresolved issues</h4>
      <ul>${view.issues.rows.length ? view.issues.rows.map((issue) => `<li><strong>${escapeHtml(words(issue.kind))}:</strong> ${escapeHtml(issue.summary)}${issue.user_action_required ? ` — Action required: ${escapeHtml(issue.user_action_required)}` : ""}</li>`).join("") : "<li>None recorded.</li>"}</ul>
      ${truncationNote(view.issues, "issues")}
    </section>
    <details class="assignmentDetails workPacketDetails">
      <summary>Actions and evidence</summary>
      <h4>Evidence labels</h4>
      <ul>${view.trustBadges.filter(badge => badge.key !== "overall").map(badge => `<li><strong>${escapeHtml(badge.label)}:</strong> ${escapeHtml(badge.detail)}</li>`).join("")}</ul>
      <h4>Actions</h4>
      <ol class="workPacketActionList">${actionRows || "<li>No action attempts recorded.</li>"}</ol>
      ${truncationNote(view.actions, "actions")}
      <h4>Evidence references</h4>
      <ul>${evidenceRows || "<li>No evidence references recorded.</li>"}</ul>
      ${truncationNote(view.evidence, "evidence references")}
    </details>
  `;
}
