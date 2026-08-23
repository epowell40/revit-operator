import type { PacketEvidenceReference, VerifiedWorkPacketV1, VerifiedWorkTrust } from "./contract.js";

function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function badge(trust: VerifiedWorkTrust): string {
  switch (trust) {
    case "independently_verified": return "[independently verified]";
    case "native_execution_evidence": return "[native evidence]";
    case "agent_reported": return "[agent reported]";
    default: return "[uncertain / missing]";
  }
}

function refs(values: PacketEvidenceReference[]): string {
  return values.length ? values.map(value => `${value.evidence_id} ${badge(value.trust)}`).join(", ") : "—";
}

function heading(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

export function renderVerifiedWorkPacketMarkdown(packet: VerifiedWorkPacketV1): string {
  const lines: string[] = [
    `# Verified Work Packet`,
    "",
    `**${heading(packet.status)}** ${badge(packet.trust_presentation.overall)}`,
    "",
    packet.status_reason,
    "",
    `- Packet: \`${packet.packet_id}\``,
    `- Hash: \`${packet.packet_hash}\``,
    `- Assignment: \`${packet.identity.assignment_id}\``,
    `- Run / generation: \`${packet.identity.run_id ?? "none"}\` / ${packet.identity.generation}`,
    `- Project/document: \`${packet.identity.project_document_fingerprint ?? "not recorded"}\``,
    `- Created: ${packet.identity.created_at}`,
    `- Release: \`${packet.identity.source_release_identity}\``,
    ...(packet.parent_packet_id ? [`- Parent packet: \`${packet.parent_packet_id}\``] : []),
    "",
    "## Assignment",
    "",
    packet.assignment.normalized_user_request,
    "",
    `- Requested effect: ${packet.assignment.requested_effect ?? "not recorded"}`,
    `- Scope: ${packet.assignment.scope.length ? packet.assignment.scope.join("; ") : "not recorded"}`,
    `- Exclusions: ${packet.assignment.exclusions.length ? packet.assignment.exclusions.join("; ") : "none recorded"}`,
    `- Constraints: ${packet.assignment.constraints.length ? packet.assignment.constraints.join("; ") : "none recorded"}`,
    "",
    "## Acceptance criteria",
    "",
    "| Requirement | Status | Trust | Observed | Expected | Evidence | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];
  if (!packet.acceptance_criteria.length) lines.push("| No criteria recorded | uncertain | [uncertain / missing] | — | — | — | No acceptance audit exists. |");
  for (const criterion of packet.acceptance_criteria) lines.push(
    `| ${cell(criterion.requirement)} | ${criterion.status} | ${badge(criterion.trust)} | ${cell(criterion.observed_value)} | ${cell(criterion.expected_value)} | ${cell(refs(criterion.evidence_references))} | ${cell(criterion.reason)} |`
  );
  lines.push("", "## Affected targets", "");
  if (!packet.grounded_targets.length) lines.push("No grounded target identity was recorded.");
  else {
    lines.push("| Identity | Element | View / sheet | Family / type | System / circuit | Room / space / level | Host / side / orientation |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const target of packet.grounded_targets) lines.push(
      `| ${cell(target.identity)} | ${cell(target.element_id)} | ${cell([target.view_id, target.sheet_id].filter(Boolean).join(" / "))} | ${cell([target.family_id, target.type_id].filter(Boolean).join(" / "))} | ${cell([target.system_id, target.circuit_id].filter(Boolean).join(" / "))} | ${cell([target.room_id, target.space_id, target.level_id].filter(Boolean).join(" / "))} | ${cell([target.host_id, target.side, target.orientation].filter(Boolean).join(" / "))} |`
    );
  }
  lines.push("", "## Actions and effect truth", "", "| Attempt | Operation | Dispatch | Effect | Verification | Trust | Relationship |", "| --- | --- | --- | --- | --- | --- | --- |");
  if (!packet.actions.length) lines.push("| — | No canonical action attempts recorded | — | none | — | [uncertain / missing] | — |");
  for (const action of packet.actions) lines.push(
    `| ${cell(action.attempt_id)} | ${cell(`${action.purpose}: ${action.action_path || action.tool_identity}`)} | ${cell(action.dispatch.state)} | ${cell(`${action.effect.state}: ${action.effect.reason}`)} | ${cell(action.verification.state)} | ${badge(action.trust)} | ${cell(action.retry_of_attempt_id ? `retry of ${action.retry_of_attempt_id} (${action.retry_delta})` : action.reconciliation_of_attempt_id ? `reconciles ${action.reconciliation_of_attempt_id}` : null)} |`
  );
  lines.push("", "## Collateral checks", "", "| Invariant | Status | Trust | Evidence | Reason |", "| --- | --- | --- | --- | --- |");
  if (!packet.collateral_checks.length) lines.push("| No collateral assertion recorded | not applicable | [uncertain / missing] | — | The packet makes no unchanged-target claim. |");
  for (const check of packet.collateral_checks) lines.push(`| ${cell(check.invariant)} | ${check.status} | ${badge(check.trust)} | ${cell(refs(check.evidence_references))} | ${cell(check.reason)} |`);
  lines.push("", "## Artifacts", "");
  if (!packet.artifacts.length) lines.push("No artifacts recorded.");
  else {
    lines.push("| Role | Path/reference | Hash | Size | Trust |", "| --- | --- | --- | --- | --- |");
    for (const artifact of packet.artifacts) lines.push(`| ${artifact.role} | ${cell(artifact.path ?? artifact.evidence_reference?.evidence_id)} | ${cell(artifact.content_hash)} | ${cell(artifact.byte_count)} | ${artifact.evidence_reference ? badge(artifact.evidence_reference.trust) : "[uncertain / missing]"} |`);
  }
  lines.push("", "## Issues", "");
  if (!packet.issues.length) lines.push("No unresolved issues are recorded.");
  for (const issue of packet.issues) lines.push(`- **${heading(issue.kind)}:** ${issue.summary}${issue.user_action_required ? ` User action: ${issue.user_action_required}` : ""}`);
  lines.push(
    "", "## Rollback", "",
    `- Available: ${packet.rollback.available === null ? "not recorded" : packet.rollback.available ? "yes" : "no"}`,
    `- Already completed: ${packet.rollback.completed ? "yes" : "no"}`,
    `- Authority / transaction: ${packet.rollback.authority_or_transaction_identity ?? "not recorded"}`,
    `- Targets: ${packet.rollback.affected_target_identities.length ? packet.rollback.affected_target_identities.join(", ") : "none recorded"}`,
    "", "## Performance", "",
    `- Elapsed: ${packet.performance.elapsed_ms === null ? "not recorded" : `${packet.performance.elapsed_ms} ms`}`,
    `- Model calls: ${packet.performance.model_calls ?? "not recorded"}`,
    `- Revit calls: ${packet.performance.revit_calls ?? "not recorded"}`,
    `- Tokens: ${packet.performance.total_tokens ?? "not recorded"}`,
    `- Estimated cost: ${packet.performance.estimated_cost_usd === null ? "not recorded" : `$${packet.performance.estimated_cost_usd.toFixed(6)}`}`,
    `- Human intervention: ${packet.performance.human_intervention === null ? "not recorded" : packet.performance.human_intervention ? "yes" : "no"}`,
    "", "## Trust legend", "",
    `- ${badge("agent_reported")} ${packet.trust_presentation.agent_reported}`,
    `- ${badge("native_execution_evidence")} ${packet.trust_presentation.native_execution_evidence}`,
    `- ${badge("independently_verified")} ${packet.trust_presentation.independently_verified}`,
    `- ${badge("uncertain_or_missing")} ${packet.trust_presentation.uncertain_or_missing}`,
    ""
  );
  return lines.join("\n");
}
