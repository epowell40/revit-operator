import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";
type Row = Record<string, any>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): any[] => Array.isArray(value) ? value : [];

/** Model presentation only: never replaces the canonical snapshot or journal. */
export function projectAssignmentStatusForModel(value: unknown): Row | null {
  const response = row(value);
  const snapshot = row(response.assignment_snapshot_v2);
  if (response.ok !== true || response.error || response.isError === true
    || snapshot.schema !== ASSIGNMENT_SNAPSHOT_V2_SCHEMA
    || typeof snapshot.terminal !== "boolean" || typeof snapshot.outcome !== "string"
    || typeof snapshot.current_binding?.assignment_id !== "string") return null;

  const omitted: Row = {};
  let remaining = 24_000;
  const exact = (name: string, field: unknown, cap: number): unknown => {
    if (field === undefined) return undefined;
    const chars = JSON.stringify(field).length;
    if (chars > cap || chars > remaining) {
      omitted[name] = { serialized_chars: chars, reason: "model_context_budget" };
      return undefined;
    }
    remaining -= chars;
    return field;
  };
  const boundedEntries = (name: string, entries: any[], budget: number, max = 24) => {
    const included: any[] = [];
    let used = 0;
    for (const entry of entries) {
      const chars = JSON.stringify(entry).length;
      if (included.length >= max || used + chars > budget || chars > remaining) continue;
      included.push(entry); used += chars; remaining -= chars;
    }
    if (included.length < entries.length) omitted[name] = { count: entries.length - included.length, reason: "model_context_budget" };
    return included;
  };
  const projection: Row = {
    schema: "revit-operator.assignment-status-for-model.v1",
    authority: "presentation_only",
    assignment_version: snapshot.assignment_version,
    binding: exact("binding", snapshot.current_binding, 1800),
    outcome: snapshot.outcome,
    terminal: snapshot.terminal,
    quiescent: snapshot.quiescent,
    terminal_reason: exact("terminal_reason", snapshot.terminal_reason, 1600),
    execution_control: exact("execution_control", snapshot.execution_control, 1800),
    progress_blocker: exact("progress_blocker", snapshot.progress_blocker, 1800),
    provider_budget_exhausted: snapshot.provider_budget_exhausted,
    result_delivery_required: snapshot.spec?.result_delivery_required === true,
    result_assessment_required: snapshot.spec?.result_assessment_required === true,
    result_delivery_present: snapshot.result_delivery !== undefined,
    pending_input_variable_ids: exact("pending_input_variable_ids", snapshot.pending_input_variable_ids, 1800),
    pending_review_ids: exact("pending_review_ids", snapshot.pending_review_ids, 1800),
    in_flight_operation_count: list(snapshot.in_flight_operation_ids).length,
    in_flight_provider_call_count: list(snapshot.in_flight_provider_call_ids).length,
    unresolved_unknown_operation_count: list(snapshot.unresolved_unknown_operation_ids).length,
    blocking_child_operation_count: list(snapshot.blocking_child_operation_ids).length
  };
  const delivery = list(snapshot.result_delivery?.items);
  projection.result_delivery = { items: boundedEntries("result_delivery.items", delivery, 9000) };
  if (snapshot.result_delivery?.assessment !== undefined) projection.result_delivery.assessment = exact("result_delivery.assessment", snapshot.result_delivery.assessment, 9000);
  const omittedDelivery = delivery.filter(item => !projection.result_delivery.items.includes(item));
  if (omittedDelivery.length) projection.result_delivery.omitted_evidence = boundedEntries("result_delivery.omitted_evidence",
    omittedDelivery.map(item => ({ label: item.label, observation_id: item.observation_id, evidence_ref: item.evidence_ref,
      path: item.path, payload_hash: item.payload_hash, value_omitted: true })), 2000, 12);
  projection.criteria = boundedEntries("criteria", Object.values(row(snapshot.criteria)), 5000);
  const pending = new Set(list(snapshot.pending_input_variable_ids));
  projection.pending_input_definitions = boundedEntries("pending_input_definitions",
    [...list(snapshot.spec?.input_variables), ...Object.values(row(snapshot.discovered_inputs)).map(item => row(item).variable)].filter(item => item && pending.has(item.variable_id)), 2200, 12);
  const questionHistory = Object.values(row(snapshot.clarifications)).reverse();
  projection.clarifications = boundedEntries("clarifications",
    [...questionHistory.filter(item => !row(item).resolved_at), ...questionHistory.filter(item => row(item).resolved_at)], 2200, 12);
  projection.execution_failures = boundedEntries("execution_failures", Object.values(row(snapshot.execution_failures)).slice(-8), 1800, 8);
  projection.retained_history = {
    operations: Object.keys(row(snapshot.operations)).length,
    observations: Object.keys(row(snapshot.observations)).length,
    provider_calls: Object.keys(row(snapshot.provider_calls)).length,
    note: "Full history remains in the canonical task. Use evidence references for exact omitted results; omitted values are not verified answers."
  };
  projection.omitted = omitted;
  return { ok: true, assignment_status: projection };
}
