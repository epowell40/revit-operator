import type {
  AssignmentOutcomeV2,
  AssignmentSnapshotV2,
  SemanticFactV2
} from "../domain/assignment-kernel/index.js";

export const TERMINAL_RESULT_V2_SCHEMA = "revit-operator.terminal-result/v2" as const;

export interface TerminalResultV2 {
  schema: typeof TERMINAL_RESULT_V2_SCHEMA;
  assignment_id: string;
  terminal_snapshot_version: number;
  outcome: Exclude<AssignmentOutcomeV2, "active" | "awaiting_user_input" | "awaiting_user_review">;
  requested_effect: string;
  result_summary: string;
  supporting_observation_ids: readonly string[];
  evidence_refs: readonly string[];
  warnings: readonly string[];
}

function scalar(value: SemanticFactV2["value"]): string {
  if (Array.isArray(value)) return value.map(item => item === null ? "null" : String(item)).join(", ");
  return value === null ? "null" : String(value);
}

function domainFacts(snapshot: AssignmentSnapshotV2, observationIds: readonly string[]): SemanticFactV2[] {
  return observationIds.flatMap(observationId => snapshot.observations[observationId]?.facts ?? [])
    .filter(fact => fact.fact_class === "domain" || fact.fact_class === "verification")
    .filter(fact => !fact.fact_id.startsWith("control."));
}

function inventorySummary(facts: readonly SemanticFactV2[]): string | null {
  const total = facts.find(fact => fact.fact_id === "inventory.total");
  if (!total) return null;
  const groups = facts.filter(fact => fact.fact_id === "inventory.group");
  const lines = [`Inventory total: ${scalar(total.value)}.`];
  if (groups.length > 0) {
    const dimensions = [...new Set(groups.flatMap(group => Object.keys(group.dimensions ?? {})))].sort();
    lines.push("", dimensions.length > 0 ? `Breakdown by ${dimensions.join(" / ")}:` : "Breakdown:");
    for (const group of groups) {
      const labels = dimensions.map(key => `${group.dimensions?.[key] ?? "(unspecified)"}`);
      lines.push(`- ${labels.join(" — ")}: ${scalar(group.value)}`);
    }
  }
  return lines.join("\n");
}

function generalDomainSummary(facts: readonly SemanticFactV2[]): string | null {
  const useful = facts.filter(fact => !["inventory.complete", "task.result_available"].includes(fact.fact_id));
  if (useful.length === 0) return null;
  return useful.map(fact => {
    const dimensions = Object.entries(fact.dimensions ?? {}).map(([key, value]) => `${key}=${value}`).join(", ");
    return `- ${fact.fact_id}${dimensions ? ` (${dimensions})` : ""}: ${scalar(fact.value)}`;
  }).join("\n");
}

/**
 * Derives a product-facing, read-only terminal handoff from canonical V2
 * truth. It never appends lifecycle events and never treats control or
 * telemetry observations as the user's result.
 */
export function deriveTerminalResultV2(snapshot: AssignmentSnapshotV2): TerminalResultV2 {
  if (!snapshot.terminal || ["active", "awaiting_user_input", "awaiting_user_review"].includes(snapshot.outcome)) {
    throw new Error("assignment_terminal_result_not_available");
  }
  const supportingObservationIds = [...new Set(Object.values(snapshot.criteria)
    .filter(criterion => criterion.status === "pass" || criterion.status === "not_applicable")
    .flatMap(criterion => criterion.supporting_facts.map(fact => fact.observation_id)))]
    .filter(observationId => Boolean(snapshot.observations[observationId]))
    .sort();
  const facts = domainFacts(snapshot, supportingObservationIds);
  const successfulSummary = inventorySummary(facts) ?? generalDomainSummary(facts);
  const complete = snapshot.outcome === "complete" || snapshot.outcome === "verified_noop" || snapshot.outcome === "complete_with_issues";
  const resultSummary = successfulSummary
    ?? (complete
      ? "The requested work completed from authoritative Revit evidence."
      : `The requested work did not complete: ${snapshot.terminal_reason ?? snapshot.outcome}.`);
  return {
    schema: TERMINAL_RESULT_V2_SCHEMA,
    assignment_id: snapshot.current_binding.assignment_id,
    terminal_snapshot_version: snapshot.assignment_version,
    outcome: snapshot.outcome as TerminalResultV2["outcome"],
    requested_effect: snapshot.spec.requested_effect,
    result_summary: resultSummary,
    supporting_observation_ids: supportingObservationIds,
    evidence_refs: supportingObservationIds.map(id => snapshot.observations[id]!.raw_payload_ref),
    warnings: snapshot.outcome === "complete_with_issues" && snapshot.terminal_reason
      ? [snapshot.terminal_reason]
      : []
  };
}

export function renderTerminalResultV2(snapshot: AssignmentSnapshotV2): string {
  const result = deriveTerminalResultV2(snapshot);
  return result.warnings.length > 0
    ? `${result.result_summary}\n\nIssues: ${result.warnings.join("; ")}`
    : result.result_summary;
}
