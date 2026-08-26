import { AssignmentJournalV2 } from "../domain/assignment-kernel/index.js";
import type { GoalRecord } from "./service.js";

/** Read-only prompt projection; it never writes Assignment truth. */
export function formatAssignmentKernelV2GoalContext(goal: GoalRecord): string | null {
  const record = goal.assignment_kernel_v2;
  if (record?.schema !== "revit-operator.assignment-kernel-journal/v2" || record.events.length === 0) return null;
  const snapshot = new AssignmentJournalV2(record.events).snapshot();
  if (snapshot.terminal) return "";
  const criteria = snapshot.spec.criteria.map(criterion => {
    const evaluation = snapshot.criteria[criterion.criterion_id];
    return `- ${criterion.criterion_id} [${evaluation?.status ?? "unevaluated"}] ${criterion.requirement}`;
  });
  const observations = Object.values(snapshot.observations).slice(-12).map(observation =>
    `- ${observation.observation_id} operation=${observation.operation_id} authority=${observation.authority} facts=${observation.facts.map(fact => fact.fact_id).join(",")}`);
  const operations = Object.values(snapshot.operations).slice(-12).map(operation =>
    `- ${operation.operation_id} work_unit=${operation.work_unit_id} capability=${operation.capability_id} purpose=${operation.purpose} requested_effect=${operation.requested_effect} dispatch=${operation.dispatch_state}/${operation.dispatch_authority} persistent_effect=${operation.persistent_effect} settlement=${operation.settlement_state}`);
  const clarifications = Object.values(snapshot.clarifications).filter(item => !item.resolved_at).map(item =>
    `- ${item.clarification_id}: variable=${item.variable_id} question=${item.question}`);
  return [
    "ACTIVE ASSIGNMENT V2 CONTEXT:",
    `assignment_id: ${snapshot.current_binding.assignment_id}`,
    `run_id: ${snapshot.current_binding.run_id}`,
    `generation: ${snapshot.current_binding.generation}`,
    `assignment_version: ${snapshot.assignment_version}`,
    `requested_effect: ${snapshot.spec.requested_effect}`,
    `source_user_request: ${snapshot.spec.source_user_request}`,
    `outcome: ${snapshot.outcome}`,
    `quiescent: ${snapshot.quiescent}`,
    `pending_input_variable_ids: ${snapshot.pending_input_variable_ids.join(", ") || "(none)"}`,
    `criteria:\n${criteria.join("\n") || "- (none)"}`,
    `observations_and_semantic_fact_ids:\n${observations.join("\n") || "- (none)"}`,
    `operations:\n${operations.join("\n") || "- (none)"}`,
    `pending_clarifications:\n${clarifications.join("\n") || "- (none)"}`,
    "Use stable criterion, Observation, and semantic fact IDs—not JSON paths, routes, field aliases, or prose—as proof.",
    "Evaluate supported criteria with operator_evaluate_assignment_criteria; request missing stable inputs with operator_request_assignment_input. The host injects lifecycle binding.",
    "The V2 journal owns truth. Do not call Codex goal tools from this embedded turn."
  ].join("\n");
}
