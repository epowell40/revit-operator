import { canonicalJsonV2 } from "./canonical.js";
import type { AssignmentEventV2 } from "./events.js";
import { kernelAssertV2 } from "./errors.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import type { CriterionEvaluationV2 } from "./criteria.js";
import { deriveAssignmentOutcomeV2 } from "./outcome.js";
import { OPERATION_INPUT_SCHEMA_GAP_V2_SCHEMA, type OperationResultV2, type OperationV2 } from "./operation.js";
import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA, type AssignmentSnapshotV2 } from "./snapshot.js";
import { PROVIDER_CALL_V2_SCHEMA, type ProviderCallStateV2, type ProviderCallV2 } from "./progress/provider_call.js";
import { deriveProgressGapsV2, operationProgressIdentityV2 } from "./progress/controller.js";
import {
  CRITERION_EVIDENCE_POLICY_V2_SCHEMA,
  SEMANTIC_EVIDENCE_CONTRACT_V2,
  evidenceClassForFulfillmentRoleV2,
  fulfillmentRoleCanCarryTaskCriteriaV2,
  observationAdmissibilityForCriterionV2
} from "./semantic_admissibility.js";

const EFFECT_RANK = { read: 0, preview: 1, apply: 2 } as const;
const PROVIDER_STATE_RANK: Readonly<Record<ProviderCallStateV2, number>> = {
  admitted: 0,
  dispatched: 1,
  response_started: 2,
  usage_received: 3,
  completed: 4,
  response_transport_completed: 5
};

function providerTimestampField(state: ProviderCallStateV2): keyof ProviderCallV2 {
  return ({
    admitted: "admitted_at",
    dispatched: "dispatched_at",
    response_started: "response_started_at",
    usage_received: "usage_received_at",
    completed: "completed_at",
    response_transport_completed: "response_transport_completed_at"
  } as const)[state];
}

function applyProviderState(snapshot: AssignmentSnapshotV2, event: Extract<AssignmentEventV2, { event_type: "provider_call_state_recorded" }>): AssignmentSnapshotV2 {
  const previous = snapshot.provider_calls[event.call_id];
  kernelAssertV2(event.call_id.trim().length > 0, "provider_call_identity_missing", "Provider call requires a stable identity.");
  if (!previous) {
    kernelAssertV2(event.state === "admitted", "provider_call_not_admitted", "The first provider-call state must be admitted.");
    kernelAssertV2(Boolean(event.provider?.trim()) && Boolean(event.model?.trim()), "provider_call_route_missing", "Provider admission requires the selected provider and model.");
    kernelAssertV2((event.gap_ids?.length ?? 0) > 0 && (event.criterion_ids?.length ?? 0) > 0, "provider_call_progress_binding_missing", "Provider admission requires unresolved gap and criterion bindings.");
    kernelAssertV2((event.expected_information?.length ?? 0) > 0, "provider_call_expected_information_missing", "Provider admission must state expected information.");
    const call: ProviderCallV2 = {
      schema: PROVIDER_CALL_V2_SCHEMA,
      call_id: event.call_id,
      binding: structuredClone(snapshot.current_binding),
      state: "admitted",
      provider: event.provider!,
      model: event.model!,
      reasoning_effort: event.reasoning_effort ?? null,
      gap_ids: [...new Set(event.gap_ids)].sort(),
      criterion_ids: [...new Set(event.criterion_ids)].sort(),
      expected_information: [...new Set(event.expected_information)].sort(),
      admitted_at: event.occurred_at
    };
    return { ...snapshot, provider_calls: { ...snapshot.provider_calls, [call.call_id]: call }, provider_call_ids: [...new Set([...snapshot.provider_call_ids, call.call_id])].sort() };
  }
  kernelAssertV2(event.state !== "admitted", "provider_call_duplicate_admission", "Provider admission is unique.");
  if (event.state === "usage_received") kernelAssertV2(Boolean(event.usage), "provider_call_usage_missing", "Usage state requires provider usage data.");
  if (event.state === "completed") kernelAssertV2(typeof event.success === "boolean", "provider_call_completion_missing", "Provider completion requires success truth.");
  if (event.state === "response_transport_completed") kernelAssertV2(Boolean(previous.completed_at), "provider_transport_before_completion", "Downstream response transport cannot complete before provider completion.");
  const timestamp = providerTimestampField(event.state);
  if (event.state === "usage_received" && previous.usage) {
    kernelAssertV2(canonicalJsonV2(previous.usage) === canonicalJsonV2(event.usage), "provider_call_usage_conflict", "Replayed provider usage must agree with retained usage.");
  }
  if (event.state === "completed" && previous.completed_at) {
    kernelAssertV2(previous.success === event.success && (!event.error_class || previous.error_class === event.error_class), "provider_call_completion_conflict", "Replayed provider completion must agree with retained completion.");
  }
  const nextState = PROVIDER_STATE_RANK[event.state] > PROVIDER_STATE_RANK[previous.state]
    ? event.state
    : previous.state;
  const next = {
    ...previous,
    state: nextState,
    [timestamp]: previous[timestamp] ?? event.occurred_at,
    ...(event.usage ? { usage: structuredClone(event.usage) } : {}),
    ...(event.success !== undefined ? { success: event.success } : {}),
    ...(event.error_class ? { error_class: event.error_class } : {})
  } as ProviderCallV2;
  return { ...snapshot, provider_calls: { ...snapshot.provider_calls, [event.call_id]: next } };
}

interface ReducerStateV2 {
  snapshot?: AssignmentSnapshotV2;
  superseded: boolean;
  clarificationByVariable: Map<string, string>;
}

function current(state: ReducerStateV2): AssignmentSnapshotV2 {
  kernelAssertV2(state.snapshot, "assignment_not_created", "The first V2 event must create the Assignment.");
  return state.snapshot;
}

function withDerivedState(snapshot: AssignmentSnapshotV2): AssignmentSnapshotV2 {
  const inFlight = Object.values(snapshot.operations)
    .filter((operation) => ["open", "awaiting_result", "retaining_observation"].includes(operation.settlement_state))
    .map((operation) => operation.operation_id)
    .sort();
  const unknown = Object.values(snapshot.operations)
    .filter((operation) => operation.persistent_effect === "unknown")
    .map((operation) => operation.operation_id)
    .sort();
  const inFlightProviders = Object.values(snapshot.provider_calls)
    .filter((call) => !call.completed_at)
    .map((call) => call.call_id)
    .sort();
  const operationChildren: Record<string, string[]> = {};
  for (const operation of Object.values(snapshot.operations)) {
    if (!operation.parent_operation_id) continue;
    operationChildren[operation.parent_operation_id] = [
      ...(operationChildren[operation.parent_operation_id] ?? []),
      operation.operation_id
    ];
  }
  for (const children of Object.values(operationChildren)) children.sort();
  const blockingChildren = Object.values(snapshot.operations)
    .filter((operation) => Boolean(operation.parent_operation_id)
      && operation.blocks_parent_settlement !== false
      && operation.settlement_state !== "settled")
    .map((operation) => operation.operation_id)
    .sort();
  const next: AssignmentSnapshotV2 = {
    ...snapshot,
    in_flight_operation_ids: inFlight,
    in_flight_provider_call_ids: inFlightProviders,
    operation_children: operationChildren,
    blocking_child_operation_ids: blockingChildren,
    unresolved_unknown_operation_ids: unknown,
    quiescent: inFlight.length === 0 && inFlightProviders.length === 0
  };
  return { ...next, outcome: deriveAssignmentOutcomeV2(next) };
}

function validateVersion(state: ReducerStateV2, event: AssignmentEventV2): void {
  const expected = state.snapshot ? state.snapshot.assignment_version + 1 : 1;
  kernelAssertV2(event.assignment_version === expected, "assignment_event_out_of_order", `Expected Assignment version ${expected}.`);
  kernelAssertV2(event.binding.assignment_id === event.assignment_id, "assignment_event_binding_mismatch", "Event Assignment identity disagrees with its binding.");
}

function requireCurrentBinding(snapshot: AssignmentSnapshotV2, event: AssignmentEventV2): void {
  kernelAssertV2(sameAssignmentBindingV2(snapshot.current_binding, event.binding), "assignment_event_stale_binding", "Event does not bind to the current Assignment run and generation.");
}

function validateOperationAdmission(snapshot: AssignmentSnapshotV2, operation: OperationV2): void {
  kernelAssertV2(sameAssignmentBindingV2(snapshot.current_binding, operation.binding), "operation_binding_mismatch", "Operation binding is not current.");
  kernelAssertV2(!snapshot.operations[operation.operation_id], "operation_duplicate", "Operation identity already exists.");
  kernelAssertV2(snapshot.unresolved_unknown_operation_ids.length === 0 || operation.purpose === "reconciliation",
    "operation_unknown_effect_requires_reconciliation", "Unknown-effect work must be reconciled before another ordinary operation is admitted.");
  const workUnit = snapshot.spec.work_units.find((candidate) => candidate.work_unit_id === operation.work_unit_id);
  kernelAssertV2(workUnit, "operation_work_unit_unknown", "Operation work unit is not in AssignmentSpecV2.");
  if (snapshot.spec.semantic_evidence_contract === SEMANTIC_EVIDENCE_CONTRACT_V2) {
    kernelAssertV2(Boolean(operation.fulfillment_role) && Array.isArray(operation.eligible_criterion_ids),
      "operation_fulfillment_contract_missing", "A semantic-evidence Assignment requires an explicit operation fulfillment contract.");
    const eligible = operation.eligible_criterion_ids ?? [];
    if (!fulfillmentRoleCanCarryTaskCriteriaV2(operation.fulfillment_role!)) {
      kernelAssertV2(eligible.length === 0, "operation_support_criterion_forbidden", "Supporting, prerequisite, reconciliation, and telemetry work cannot satisfy task criteria.");
    }
    if (operation.fulfillment_role === "delegated_task_execution") {
      kernelAssertV2(operation.purpose === "work", "operation_delegated_purpose_invalid", "Delegated task execution requires work purpose.");
    } else if (operation.fulfillment_role === "verification") {
      kernelAssertV2(operation.purpose === "verification", "operation_verification_fulfillment_invalid", "Verification fulfillment requires verification purpose.");
    } else if (operation.fulfillment_role === "reconciliation") {
      kernelAssertV2(operation.purpose === "reconciliation", "operation_reconciliation_fulfillment_invalid", "Reconciliation fulfillment requires reconciliation purpose.");
    } else if (operation.fulfillment_role === "prerequisite") {
      kernelAssertV2(operation.purpose === "discovery" && operation.operation_role === "prerequisite",
        "operation_prerequisite_fulfillment_invalid", "Prerequisite fulfillment requires prerequisite topology and discovery purpose.");
    } else if (operation.fulfillment_role === "telemetry") {
      kernelAssertV2(false, "operation_telemetry_admission_invalid", "Telemetry is retained in the provider ledger, not admitted as task execution.");
    }
    if ((operation.operation_role ?? "root") === "root" && fulfillmentRoleCanCarryTaskCriteriaV2(operation.fulfillment_role!)) {
      kernelAssertV2(Boolean(operation.delegation_authority_id), "operation_delegation_authority_missing", "A criterion-fulfillment root must issue one delegation authority.");
    }
    for (const criterionId of eligible) {
      kernelAssertV2(workUnit.criterion_ids.includes(criterionId), "operation_eligible_criterion_unbound", "Operation criterion eligibility is outside its admitted work unit.");
      kernelAssertV2(operation.advances_criterion_ids.includes(criterionId), "operation_eligible_criterion_progress_unbound", "Eligible criterion must retain its progress binding.");
    }
    if ((operation.operation_role ?? "root") === "prerequisite") {
      kernelAssertV2(operation.fulfillment_role === "prerequisite", "operation_prerequisite_fulfillment_invalid", "Prerequisite topology requires prerequisite fulfillment semantics.");
    }
  }
  const role = operation.operation_role ?? "root";
  kernelAssertV2(role !== "root" || operation.advances_criterion_ids.length > 0 || operation.resolves_gap_ids.length > 0,
    "operation_progress_binding_missing", "A root operation must bind to unresolved criterion or gap work; nested work binds through its parent.");
  for (const criterionId of operation.advances_criterion_ids) {
    kernelAssertV2(workUnit.criterion_ids.includes(criterionId), "operation_progress_criterion_unbound", "Operation criterion is not admitted by its work unit.");
  }
  const currentGapIds = new Set(deriveProgressGapsV2(snapshot).map((gap) => gap.gap_id));
  for (const gapId of operation.resolves_gap_ids) kernelAssertV2(currentGapIds.has(gapId), "operation_progress_gap_stale", "Operation gap is no longer unresolved.");
  const equivalent = Object.values(snapshot.operations).find((candidate) => operationProgressIdentityV2(candidate) === operationProgressIdentityV2(operation));
  kernelAssertV2(!equivalent || Boolean(operation.retry_of_operation_id) || operation.purpose === "reconciliation",
    "operation_progress_equivalent_repeat", "Equivalent operation requires a typed retry or reconciliation basis.");
  kernelAssertV2(operation.requested_effect === workUnit.requested_effect, "operation_effect_mismatch", "Operation effect must come from its admitted work unit.");
  kernelAssertV2(EFFECT_RANK[operation.requested_effect] <= EFFECT_RANK[snapshot.spec.requested_effect], "operation_effect_exceeds_assignment", "Operation effect exceeds the Assignment effect envelope.");
  for (const dependencyId of workUnit.dependency_ids) kernelAssertV2(["complete", "retained"].includes(snapshot.work_unit_states[dependencyId] ?? ""), "operation_dependency_incomplete", "Operation dependencies must be complete or retained.");
  for (const variableId of workUnit.input_variable_ids) kernelAssertV2(Object.prototype.hasOwnProperty.call(snapshot.input_values, variableId), "operation_input_missing", "Operation requires a known stable input variable.");
  if (role === "root") {
    kernelAssertV2(!operation.parent_operation_id && !operation.root_operation_id,
      "operation_root_relation_invalid", "A root operation cannot cite a parent or another root operation.");
    kernelAssertV2(operation.blocks_parent_settlement === undefined || operation.blocks_parent_settlement === false,
      "operation_root_blocking_invalid", "Only a child operation can block parent settlement.");
  } else {
    const parent = operation.parent_operation_id ? snapshot.operations[operation.parent_operation_id] : undefined;
    kernelAssertV2(parent && ["open", "awaiting_result", "retaining_observation"].includes(parent.settlement_state),
      "operation_parent_invalid", "A child operation requires one current unsettled parent operation.");
    kernelAssertV2(sameAssignmentBindingV2(parent.binding, operation.binding),
      "operation_parent_binding_mismatch", "Parent and child operations must share one Assignment binding.");
    const expectedRoot = parent.root_operation_id ?? parent.operation_id;
    kernelAssertV2(operation.root_operation_id === expectedRoot,
      "operation_root_identity_mismatch", "A child operation must retain the deterministic root operation identity.");
    kernelAssertV2(operation.operation_id !== parent.operation_id,
      "operation_child_identity_collision", "A child operation must have its own immutable identity.");
    if (snapshot.spec.semantic_evidence_contract === SEMANTIC_EVIDENCE_CONTRACT_V2) {
      const parentEligible = new Set(parent.eligible_criterion_ids ?? []);
      for (const criterionId of operation.eligible_criterion_ids ?? []) {
        kernelAssertV2(parentEligible.has(criterionId), "operation_delegated_criterion_widening", "A child cannot widen its parent's criterion eligibility.");
      }
      if (fulfillmentRoleCanCarryTaskCriteriaV2(operation.fulfillment_role!)) {
        kernelAssertV2(Boolean(parent.delegation_authority_id)
          && operation.delegation_authority_id === parent.delegation_authority_id,
        "operation_delegation_authority_invalid", "A fulfillment child requires the exact parent-issued delegation authority.");
      } else {
        kernelAssertV2(!operation.delegation_authority_id,
          "operation_support_delegation_forbidden", "Supporting children cannot retain task-fulfillment delegation authority.");
      }
    }
  }
  if (operation.request_identity) {
    kernelAssertV2(operation.request_identity.capability_id === operation.capability_id,
      "operation_request_capability_mismatch", "Operation request identity must preserve its admitted capability.");
    kernelAssertV2(Boolean(operation.request_identity.request_signature.trim()),
      "operation_request_signature_missing", "Operation request identity requires a stable signature.");
  }
  if (operation.retry_of_operation_id) {
    const prior = snapshot.operations[operation.retry_of_operation_id];
    kernelAssertV2(prior?.settlement_state === "settled" && prior.persistent_effect === "none", "operation_retry_unsafe", "A retry requires a settled no-effect predecessor.");
    kernelAssertV2(Boolean(operation.retry_basis), "operation_retry_basis_missing", "A retry must state the material correction that permits it.");
    if (operation.retry_basis === "corrected_input") {
      const gap = prior?.result?.input_schema_gap;
      kernelAssertV2(Boolean(gap)
        && operation.capability_id === prior?.capability_id
        && operation.request_identity?.method === gap?.method
        && operation.request_identity?.path === gap?.path
        && operation.request_identity?.request_signature !== gap?.request_signature,
      "operation_corrected_input_retry_invalid", "Corrected-input retry must bind to the exact schema-rejected capability and route with materially changed input.");
    }
  } else {
    kernelAssertV2(!operation.retry_basis, "operation_retry_basis_unbound", "Retry basis requires a predecessor operation.");
  }
  if (operation.purpose === "verification") {
    const subject = operation.verification_of_operation_id
      ? snapshot.operations[operation.verification_of_operation_id]
      : undefined;
    kernelAssertV2(subject?.requested_effect === "apply"
      && subject.persistent_effect === "applied"
      && subject.settlement_state === "settled",
    "operation_verification_subject_invalid", "Verification must bind to one settled applied operation.");
    kernelAssertV2(Boolean(operation.target.target_id)
      && operation.target.target_id === subject.target.target_id
      && operation.target.document_fingerprint === subject.target.document_fingerprint,
    "operation_verification_target_mismatch", "Verification must inspect the exact applied target in the same document.");
  } else {
    kernelAssertV2(!operation.verification_of_operation_id,
      "operation_verification_relation_unbound", "Only a verification operation may cite an applied operation.");
  }
  kernelAssertV2(operation.admission_state === "admitted" && operation.dispatch_state === "not_dispatched", "operation_admission_shape_invalid", "A newly admitted operation must not already claim dispatch.");
  kernelAssertV2(operation.persistent_effect === "none" && operation.settlement_state === "open" && !operation.settled_at && !operation.result, "operation_admission_effect_invalid", "A newly admitted operation cannot claim a result, persistent effect, or settlement.");
}

function validateResult(snapshot: AssignmentSnapshotV2, operation: OperationV2, result: OperationResultV2): void {
  kernelAssertV2(result.operation_id === operation.operation_id, "operation_result_identity_mismatch", "Result operation identity is incorrect.");
  kernelAssertV2(sameAssignmentBindingV2(operation.binding, result.binding), "operation_result_binding_mismatch", "Result binding is incorrect.");
  const unresolvedBlockingChildren = Object.values(snapshot.operations).filter((candidate) =>
    candidate.parent_operation_id === operation.operation_id
    && candidate.blocks_parent_settlement !== false
    && candidate.settlement_state !== "settled");
  kernelAssertV2(unresolvedBlockingChildren.length === 0,
    "operation_parent_blocked_by_child", "A parent operation cannot settle while a blocking child operation is unresolved.");
  if (operation.request_identity) {
    kernelAssertV2(Boolean(result.request_identity)
      && canonicalJsonV2(result.request_identity) === canonicalJsonV2(operation.request_identity),
    "operation_result_request_identity_mismatch", "Result request identity does not match the exact admitted operation.");
  }
  if (result.status === "completed_without_native_dispatch") {
    kernelAssertV2(result.dispatch_state === "not_dispatched" && result.persistent_effect === "none"
      && result.native_transaction_state === "not_applicable" && result.observation_required === false
      && !result.authority.startsWith("native"),
    "operation_result_non_native_invalid", "A controller-only result cannot claim native dispatch, persistent effect, or authoritative Observation truth.");
  } else if (result.status === "failed_before_dispatch") {
    kernelAssertV2(result.dispatch_state === "not_dispatched" && result.persistent_effect === "none", "operation_result_predispatch_invalid", "Pre-dispatch failure must prove no effect.");
  } else if (result.dispatch_state === "dispatching") {
    kernelAssertV2(operation.dispatch_state === "dispatching", "operation_result_dispatch_unproven", "An indeterminate dispatch result requires an operation at the MCP dispatch boundary.");
    kernelAssertV2(result.status !== "succeeded" && result.persistent_effect === (operation.requested_effect === "apply" ? "unknown" : "none"),
      "operation_result_dispatch_indeterminate_invalid", "Indeterminate dispatch may be unknown only for apply and cannot claim success.");
  } else {
    kernelAssertV2(operation.dispatch_state === "dispatched" && result.dispatch_state === "dispatched", "operation_result_dispatch_unproven", "A post-dispatch result requires an explicit native dispatch event.");
  }
  if (operation.requested_effect === "read") {
    kernelAssertV2(result.persistent_effect === "none" && result.native_transaction_state !== "committed", "operation_read_effect_invalid", "Read result cannot claim a persistent effect.");
  }
  if (result.persistent_effect === "applied") {
    kernelAssertV2(operation.requested_effect === "apply" && result.native_transaction_state === "committed", "operation_apply_authority_invalid", "Applied effect requires a committed apply result.");
  }
  if (operation.requested_effect === "preview" && result.status === "succeeded") {
    kernelAssertV2(result.persistent_effect === "none" && result.native_transaction_state === "rolled_back", "operation_preview_settlement_invalid", "Successful preview requires authoritative rollback.");
  }
  if (result.input_schema_gap) {
    const gap = result.input_schema_gap;
    kernelAssertV2(result.status === "failed_before_dispatch" && result.dispatch_state === "not_dispatched"
      && result.persistent_effect === "none" && result.observation_required === false,
    "operation_input_schema_gap_effect_invalid", "An input-schema gap is valid only for a proven no-effect pre-dispatch rejection.");
    kernelAssertV2(gap.schema === OPERATION_INPUT_SCHEMA_GAP_V2_SCHEMA
      && gap.gap_id === `input-schema:${operation.operation_id}`
      && gap.operation_id === operation.operation_id
      && gap.capability_id === operation.capability_id
      && Boolean(gap.input_schema_id.trim())
      && /^[a-f0-9]{64}$/.test(gap.input_schema_digest)
      && gap.method === operation.request_identity?.method
      && gap.path === operation.request_identity?.path
      && gap.request_signature === operation.request_identity?.request_signature
      && gap.dispatch === false && gap.effect === "none" && gap.issues.length > 0 && gap.issues.length <= 64,
    "operation_input_schema_gap_invalid", "Input-schema gap identity and schema provenance must bind to the rejected operation.");
    for (const issue of gap.issues) {
      kernelAssertV2(Boolean(issue.field_path.trim()) && Boolean(issue.expected_type.trim()) && Boolean(issue.actual_type.trim())
        && issue.field_path.length <= 512 && issue.expected_type.length <= 160 && issue.actual_type.length <= 160
        && ["provider_corrected_arguments_required", "declared_deterministic_coercion"].includes(issue.safe_correction_eligibility)
        && ["provider_resubmit", "wrap_scalar_as_singleton_array"].includes(issue.correction_action)
        && Boolean(issue.expected_constraint?.kind),
      "operation_input_schema_issue_invalid", "Input-schema issues require structured path, expected type, actual type, and correction eligibility.");
      const constraint = issue.expected_constraint;
      const allowedConstraintKeys = new Set([
        "kind", "type", "allowed_values", "minimum", "maximum", "min_length", "max_length", "min_items", "max_items"
      ]);
      kernelAssertV2([
        "required", "json_type", "enum", "numeric_range", "string_length", "array_length", "schema_depth", "schema_bounds"
      ].includes(constraint.kind)
        && Object.keys(constraint).every((key) => allowedConstraintKeys.has(key))
        && canonicalJsonV2(constraint).length <= 4_096,
      "operation_input_schema_constraint_invalid", "Input-schema expected constraint must use the bounded reviewed shape.");
      if (constraint.allowed_values !== undefined) {
        kernelAssertV2(Array.isArray(constraint.allowed_values) && constraint.allowed_values.length <= 32
          && constraint.allowed_values.every((value) => value === null || typeof value === "boolean"
            || (typeof value === "number" && Number.isFinite(value))
            || (typeof value === "string" && value.length <= 256)),
        "operation_input_schema_constraint_invalid", "Input-schema enum constraints must be bounded JSON scalars.");
      }
      for (const numeric of [constraint.minimum, constraint.maximum, constraint.min_length, constraint.max_length, constraint.min_items, constraint.max_items]) {
        kernelAssertV2(numeric === undefined || (typeof numeric === "number" && Number.isFinite(numeric)),
          "operation_input_schema_constraint_invalid", "Input-schema numeric constraints must be finite.");
      }
      kernelAssertV2(issue.safe_correction_eligibility === "declared_deterministic_coercion"
        ? issue.correction_action === "wrap_scalar_as_singleton_array"
        : issue.correction_action === "provider_resubmit",
      "operation_input_schema_correction_invalid", "Input-schema correction action must match the declared safe correction eligibility.");
    }
  }
}

function mergeEvaluation(previous: CriterionEvaluationV2 | undefined, next: CriterionEvaluationV2): CriterionEvaluationV2 {
  if (!previous || previous.status === next.status || ["needs_input", "needs_review", "partial", "uncertain"].includes(previous.status)) return next;
  if (previous.status === "pass" && next.status === "pass") return next;
  return {
    ...next,
    status: "uncertain",
    basis: "policy",
    supporting_operation_ids: [...new Set([...previous.supporting_operation_ids, ...next.supporting_operation_ids])].sort(),
    supporting_facts: [...previous.supporting_facts, ...next.supporting_facts],
    reason: `Conflicting authoritative criterion evaluations: ${previous.status} versus ${next.status}.`
  };
}

function projectWorkUnitCriteria(snapshot: AssignmentSnapshotV2): AssignmentSnapshotV2 {
  const states = { ...snapshot.work_unit_states };
  for (const unit of snapshot.spec.work_units) {
    if (unit.criterion_ids.length === 0) continue;
    const evaluations = unit.criterion_ids.map(id => snapshot.criteria[id]).filter(Boolean);
    if (evaluations.length !== unit.criterion_ids.length) continue;
    if (evaluations.every(row => row!.status === "pass" || row!.status === "not_applicable")) {
      states[unit.work_unit_id] = "complete";
    } else if (unit.safe_to_retain && evaluations.some(row => row!.status === "pass" || row!.status === "partial")) {
      states[unit.work_unit_id] = "retained";
    }
  }
  return { ...snapshot, work_unit_states: states };
}

function validateCriterionEvaluation(snapshot: AssignmentSnapshotV2, evaluation: CriterionEvaluationV2): void {
  const criterion = snapshot.spec.criteria.find((candidate) => candidate.criterion_id === evaluation.criterion_id);
  kernelAssertV2(criterion, "criterion_unknown", "Criterion is not in AssignmentSpecV2.");
  kernelAssertV2(criterion.accepted_evaluator_authority_ids.includes(evaluation.evaluator_authority), "criterion_evaluator_untrusted", "Criterion evaluator authority is not admitted by AssignmentSpecV2.");
  const citedFacts = new Set<string>();
  for (const operationId of evaluation.supporting_operation_ids) {
    const operation = snapshot.operations[operationId];
    kernelAssertV2(operation?.settlement_state === "settled", "criterion_operation_unsettled", "Criterion cites an unknown or unsettled operation.");
  }
  for (const fact of evaluation.supporting_facts) {
    const observation = snapshot.observations[fact.observation_id];
    kernelAssertV2(observation && criterion.accepted_observation_authority_ids.includes(observation.authority), "criterion_observation_untrusted", "Criterion cites an unknown or untrusted observation.");
    kernelAssertV2(evaluation.supporting_operation_ids.includes(observation.operation_id), "criterion_fact_operation_unbound", "Criterion fact must bind to a cited operation.");
    kernelAssertV2(observation.facts.some((candidate) => candidate.fact_id === fact.fact_id), "criterion_fact_unknown", "Criterion cites an unknown semantic fact.");
    citedFacts.add(fact.fact_id);
  }
  if (snapshot.spec.semantic_evidence_contract === SEMANTIC_EVIDENCE_CONTRACT_V2) {
    const citedObservationIds = [...new Set(evaluation.supporting_facts.map((fact) => fact.observation_id))];
    for (const observationId of citedObservationIds) {
      const observation = snapshot.observations[observationId]!;
      const admission = observationAdmissibilityForCriterionV2({
        snapshot,
        criterion,
        observation,
        evaluated_at: evaluation.evaluated_at
      });
      kernelAssertV2(admission.admissible, "criterion_evidence_not_admissible", `Criterion cites inadmissible evidence: ${admission.reason}.`);
    }
  }
  if (evaluation.status === "pass") {
    for (const requirement of criterion.semantic_fact_requirements) kernelAssertV2(citedFacts.has(requirement), "criterion_required_fact_missing", "Passing criterion omits a required semantic fact.");
    kernelAssertV2(evaluation.supporting_facts.length > 0 || ["user_input", "policy"].includes(evaluation.basis), "criterion_pass_unsupported", "Passing criterion requires semantic fact support.");
  }
  if (evaluation.basis === "desired_state_equivalence") {
    kernelAssertV2(snapshot.spec.requested_effect === "apply", "criterion_noop_not_apply", "Desired-state equivalence is only meaningful for an apply Assignment.");
    const requiredVariables = new Set(snapshot.spec.work_units.flatMap((unit) => unit.input_variable_ids));
    for (const variableId of requiredVariables) kernelAssertV2(Object.prototype.hasOwnProperty.call(snapshot.input_values, variableId), "criterion_noop_desired_state_missing", "Desired-state equivalence requires every admitted desired-state input.");
  }
}

function applyEvent(state: ReducerStateV2, event: AssignmentEventV2): void {
  validateVersion(state, event);
  if (event.event_type === "assignment_created") {
    kernelAssertV2(!state.snapshot, "assignment_already_created", "Assignment creation is unique.");
    kernelAssertV2(event.assignment_id === event.spec.binding.assignment_id && sameAssignmentBindingV2(event.binding, event.spec.binding), "assignment_spec_binding_mismatch", "Creation event and spec binding disagree.");
    if (event.spec.semantic_evidence_contract === SEMANTIC_EVIDENCE_CONTRACT_V2) {
      for (const criterion of event.spec.criteria) {
        const policy = criterion.evidence_policy;
        kernelAssertV2(Boolean(policy), "criterion_evidence_policy_missing", "Semantic-evidence criteria require one explicit evidence policy.");
        kernelAssertV2(policy?.schema === CRITERION_EVIDENCE_POLICY_V2_SCHEMA,
          "criterion_evidence_policy_schema_invalid", "Criterion evidence policy schema must be the current shared contract.");
        kernelAssertV2(canonicalJsonV2([...(policy?.required_fact_ids ?? [])].sort())
          === canonicalJsonV2([...criterion.semantic_fact_requirements].sort()),
        "criterion_evidence_policy_fact_mismatch", "Criterion fact requirements and evidence-policy requirements must be identical.");
        kernelAssertV2((policy?.allowed_evidence_classes.length ?? 0) > 0
          && (policy?.allowed_fulfillment_roles.length ?? 0) > 0
          && (policy?.allowed_fact_classes.length ?? 0) > 0,
        "criterion_evidence_policy_empty", "Criterion evidence policy must declare evidence, fulfillment, and fact classes.");
        kernelAssertV2(!(policy?.allowed_fact_classes.includes("control")),
          "criterion_control_fact_forbidden", "User-task criteria cannot admit control facts as acceptance evidence.");
        for (const values of [
          policy?.allowed_evidence_classes ?? [], policy?.allowed_fulfillment_roles ?? [],
          policy?.allowed_fact_classes ?? [], policy?.allowed_capability_ids ?? [],
          policy?.allowed_result_schema_ids ?? [], policy?.required_fact_ids ?? []
        ]) {
          kernelAssertV2(new Set(values).size === values.length,
            "criterion_evidence_policy_duplicate", "Criterion evidence policy entries must be unique.");
        }
      }
    }
    const inputValues = Object.fromEntries(event.spec.input_variables.filter((input) => input.value_state === "known").map((input) => [input.variable_id, input.value]));
    state.snapshot = withDerivedState({
      schema: ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
      assignment_version: event.assignment_version,
      spec: structuredClone(event.spec),
      current_binding: structuredClone(event.binding),
      input_values: inputValues,
      pending_input_variable_ids: event.spec.input_variables.filter((input) => input.required && input.value_state !== "known").map((input) => input.variable_id).sort(),
      clarifications: {},
      work_unit_states: Object.fromEntries(event.spec.work_units.map((unit) => [unit.work_unit_id, "pending"])),
      pending_review_ids: [],
      provider_call_ids: [], provider_calls: {}, in_flight_provider_call_ids: [], provider_budget_exhausted: false,
      progress_epochs: [],
      operations: {}, observations: {}, observation_versions: {}, criteria: {}, criterion_evaluation_versions: {}, outcome: "active", terminal: false,
      operation_children: {}, blocking_child_operation_ids: [],
      in_flight_operation_ids: [], unresolved_unknown_operation_ids: [], quiescent: true
    });
    return;
  }

  let snapshot = current(state);
  kernelAssertV2(!snapshot.terminal, "assignment_terminal_immutable", "A terminal V2 Assignment cannot accept another event.");
  if (event.event_type === "run_started") {
    kernelAssertV2(state.superseded, "assignment_run_not_superseded", "A new run requires explicit supersession.");
    kernelAssertV2(event.binding.assignment_id === snapshot.current_binding.assignment_id
      && event.binding.session_id === snapshot.current_binding.session_id
      && event.binding.principal_id === snapshot.current_binding.principal_id
      && event.binding.document_fingerprint === snapshot.current_binding.document_fingerprint
      && event.binding.generation > snapshot.current_binding.generation,
    "assignment_run_binding_invalid", "New run must preserve trusted scope and advance generation.");
    snapshot = { ...snapshot, current_binding: structuredClone(event.binding), assignment_version: event.assignment_version };
    state.superseded = false;
  } else {
    kernelAssertV2(!state.superseded, "assignment_run_superseded", "Only a new trusted run may follow run supersession.");
    requireCurrentBinding(snapshot, event);
    snapshot = { ...snapshot, assignment_version: event.assignment_version };
    switch (event.event_type) {
      case "run_superseded":
        kernelAssertV2(event.superseded_by_generation > event.binding.generation, "assignment_generation_not_advanced", "Supersession must advance generation.");
        kernelAssertV2(snapshot.quiescent, "assignment_run_not_quiescent", "A run cannot be superseded while operations are unresolved.");
        state.superseded = true;
        break;
      case "work_unit_state_changed":
        kernelAssertV2(Object.prototype.hasOwnProperty.call(snapshot.work_unit_states, event.work_unit_id), "work_unit_unknown", "Work unit is not in AssignmentSpecV2.");
        snapshot = { ...snapshot, work_unit_states: { ...snapshot.work_unit_states, [event.work_unit_id]: event.state } };
        break;
      case "input_requested": {
        const input = snapshot.spec.input_variables.find((candidate) => candidate.variable_id === event.variable_id);
        kernelAssertV2(input, "input_variable_unknown", "Input variable is not in AssignmentSpecV2.");
        kernelAssertV2(!state.clarificationByVariable.has(event.variable_id), "input_clarification_already_pending", "Input variable already has an unresolved clarification.");
        state.clarificationByVariable.set(event.variable_id, event.clarification_id);
        snapshot = {
          ...snapshot,
          pending_input_variable_ids: [...new Set([...snapshot.pending_input_variable_ids, event.variable_id])].sort(),
          clarifications: { ...snapshot.clarifications, [event.clarification_id]: {
            clarification_id: event.clarification_id, variable_id: event.variable_id,
            question: event.question, requested_at: event.occurred_at
          } }
        };
        break;
      }
      case "input_supplied":
        kernelAssertV2(state.clarificationByVariable.get(event.variable_id) === event.clarification_id, "clarification_binding_invalid", "Input does not resolve the current clarification.");
        state.clarificationByVariable.delete(event.variable_id);
        snapshot = {
          ...snapshot,
          input_values: { ...snapshot.input_values, [event.variable_id]: structuredClone(event.value) },
          pending_input_variable_ids: snapshot.pending_input_variable_ids.filter((id) => id !== event.variable_id),
          clarifications: {
            ...snapshot.clarifications,
            [event.clarification_id]: { ...snapshot.clarifications[event.clarification_id]!, resolved_at: event.occurred_at }
          }
        };
        break;
      case "provider_call_recorded":
        kernelAssertV2(event.call_id.trim().length > 0, "provider_call_identity_missing", "Provider-call telemetry requires a stable call identity.");
        snapshot = {
          ...snapshot,
          provider_call_ids: [...new Set([...snapshot.provider_call_ids, event.call_id])].sort(),
          provider_calls: snapshot.provider_calls[event.call_id] ? snapshot.provider_calls : {
            ...snapshot.provider_calls,
            [event.call_id]: {
              schema: PROVIDER_CALL_V2_SCHEMA,
              call_id: event.call_id,
              binding: structuredClone(snapshot.current_binding),
              state: "completed",
              provider: event.provider,
              model: event.model,
              reasoning_effort: event.reasoning_effort,
              gap_ids: [], criterion_ids: [], expected_information: [],
              admitted_at: event.occurred_at,
              completed_at: event.occurred_at,
              success: event.success
            }
          }
        };
        break;
      case "provider_call_state_recorded":
        snapshot = applyProviderState(snapshot, event);
        break;
      case "provider_call_receipt_recorded":
        kernelAssertV2(sameAssignmentBindingV2(snapshot.current_binding, event.call.binding), "provider_call_binding_mismatch", "Provider receipt binding is not current.");
        kernelAssertV2(event.call.state === "completed" && Boolean(event.call.completed_at), "provider_call_receipt_incomplete", "Provider receipt must represent a completed upstream call.");
        kernelAssertV2(event.call.gap_ids.length > 0 && event.call.criterion_ids.length > 0 && event.call.expected_information.length > 0,
          "provider_call_progress_binding_missing", "Provider receipt must retain its admission justification.");
        kernelAssertV2(!snapshot.provider_calls[event.call.call_id], "provider_call_duplicate_admission", "Provider call identity is already retained.");
        snapshot = {
          ...snapshot,
          provider_calls: { ...snapshot.provider_calls, [event.call.call_id]: structuredClone(event.call) },
          provider_call_ids: [...new Set([...snapshot.provider_call_ids, event.call.call_id])].sort()
        };
        break;
      case "provider_budget_exhausted":
        kernelAssertV2(event.limit > 0 && snapshot.provider_call_ids.length >= event.limit,
          "provider_budget_exhaustion_invalid", "Provider budget exhaustion requires the durable call count to reach the configured limit.");
        snapshot = { ...snapshot, provider_budget_exhausted: true };
        break;
      case "progress_epoch_recorded":
        kernelAssertV2(sameAssignmentBindingV2(snapshot.current_binding, event.epoch.binding), "progress_epoch_binding_mismatch", "Progress epoch binding is not current.");
        kernelAssertV2(event.epoch.before_assignment_version < event.epoch.after_assignment_version && event.epoch.after_assignment_version < event.assignment_version, "progress_epoch_version_invalid", "Progress epoch must describe an earlier bounded snapshot transition.");
        kernelAssertV2(!snapshot.progress_epochs.some((epoch) => epoch.epoch_id === event.epoch.epoch_id), "progress_epoch_duplicate", "Progress epoch identity already exists.");
        snapshot = { ...snapshot, progress_epochs: [...snapshot.progress_epochs, structuredClone(event.epoch)] };
        break;
      case "progress_blocked":
        kernelAssertV2(snapshot.quiescent, "progress_blocked_not_quiescent", "Progress can be blocked only at a quiescent checkpoint.");
        kernelAssertV2(event.code.trim().length > 0, "progress_blocker_code_missing", "Progress blocker requires a stable code.");
        snapshot = { ...snapshot, progress_blocker: { code: event.code, gap_ids: [...new Set(event.gap_ids)].sort(), recorded_at: event.occurred_at } };
        break;
      case "operation_admitted":
        validateOperationAdmission(snapshot, event.operation);
        snapshot = {
          ...snapshot,
          operations: { ...snapshot.operations, [event.operation.operation_id]: structuredClone(event.operation) },
          work_unit_states: { ...snapshot.work_unit_states, [event.operation.work_unit_id]: "active" }
        };
        break;
      case "operation_dispatch_started": {
        const operation = snapshot.operations[event.operation_id];
        kernelAssertV2(operation && operation.settlement_state === "open" && operation.dispatch_state === "not_dispatched", "operation_dispatch_start_invalid", "Dispatch start requires one newly admitted operation.");
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: {
          ...operation, dispatch_state: "dispatching", settlement_state: "awaiting_result"
        } } };
        break;
      }
      case "native_dispatch_recorded": {
        const operation = snapshot.operations[event.operation_id];
        kernelAssertV2(operation && operation.settlement_state !== "settled"
          && (operation.dispatch_state === "not_dispatched" || operation.dispatch_state === "dispatching"),
        "operation_dispatch_invalid", "Native dispatch requires one admitted, unsettled operation.");
        const unresolvedBlockingChildren = Object.values(snapshot.operations).filter((candidate) =>
          candidate.parent_operation_id === operation.operation_id
          && candidate.blocks_parent_settlement !== false
          && candidate.settlement_state !== "settled");
        kernelAssertV2(unresolvedBlockingChildren.length === 0,
          "operation_parent_blocked_by_child", "A parent operation cannot dispatch while a blocking child operation is unresolved.");
        const persistentEffect = operation.requested_effect === "read" ? "none" : "unknown";
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: { ...operation, dispatch_state: "dispatched", dispatch_authority: "native", persistent_effect: persistentEffect, settlement_state: "awaiting_result", dispatched_at: event.occurred_at } } };
        break;
      }
      case "operation_dispatch_recorded": {
        const operation = snapshot.operations[event.operation_id];
        kernelAssertV2(operation && operation.settlement_state !== "settled"
          && (operation.dispatch_state === "not_dispatched" || operation.dispatch_state === "dispatching"),
        "operation_dispatch_invalid", "Operation dispatch requires one admitted, unsettled operation.");
        const unresolvedBlockingChildren = Object.values(snapshot.operations).filter((candidate) =>
          candidate.parent_operation_id === operation.operation_id
          && candidate.blocks_parent_settlement !== false
          && candidate.settlement_state !== "settled");
        kernelAssertV2(unresolvedBlockingChildren.length === 0,
          "operation_parent_blocked_by_child", "A parent operation cannot dispatch while a blocking child operation is unresolved.");
        kernelAssertV2(operation.requested_effect === "read", "operation_non_native_mutation_dispatch_forbidden", "A mutation cannot establish dispatch without native or dynamic-runtime authority.");
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: {
          ...operation, dispatch_state: "dispatched", dispatch_authority: event.authority,
          persistent_effect: "none", settlement_state: "awaiting_result", dispatched_at: event.occurred_at
        } } };
        break;
      }
      case "operation_result_recorded": {
        const operation = snapshot.operations[event.result.operation_id];
        kernelAssertV2(operation && operation.settlement_state !== "settled" && !operation.result, "operation_result_unmatched", "Result requires one unsettled admitted operation without a prior result.");
        validateResult(snapshot, operation, event.result);
        const settlementState = event.result.observation_required ? "retaining_observation" : "settled";
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: {
          ...operation,
          dispatch_state: event.result.dispatch_state,
          persistent_effect: event.result.persistent_effect,
          settlement_state: settlementState,
          result: structuredClone(event.result),
          ...(event.observation_commit ? {
            observation_commit: structuredClone(event.observation_commit),
            observation_commit_attempts: 0
          } : {}),
          settled_at: settlementState === "settled" ? event.result.completed_at : undefined
        } } };
        break;
      }
      case "observation_retained": {
        const operation = snapshot.operations[event.observation.operation_id];
        kernelAssertV2(operation && operation.settlement_state === "retaining_observation" && operation.result, "observation_operation_unsettled", "Observation requires an operation awaiting authoritative retention.");
        kernelAssertV2(operation.result.result_schema_id === event.observation.result_schema_id && operation.result.raw_payload_hash === event.observation.raw_payload_hash, "observation_result_mismatch", "Observation must describe the exact recorded operation result.");
        kernelAssertV2(operation.result.authority === event.observation.authority, "observation_authority_mismatch", "Observation authority must match the exact native result authority.");
        kernelAssertV2(sameAssignmentBindingV2(snapshot.current_binding, event.observation.binding), "observation_binding_mismatch", "Observation binding is not current.");
        kernelAssertV2(!snapshot.observations[event.observation.observation_id], "observation_duplicate", "Observation identity already exists.");
        if (snapshot.spec.semantic_evidence_contract === SEMANTIC_EVIDENCE_CONTRACT_V2) {
          kernelAssertV2(Boolean(operation.fulfillment_role) && event.observation.fulfillment_role === operation.fulfillment_role,
            "observation_fulfillment_role_mismatch", "Observation must retain the admitted operation fulfillment role.");
          kernelAssertV2(Boolean(event.observation.evidence_class)
            && event.observation.evidence_class === evidenceClassForFulfillmentRoleV2(operation.fulfillment_role!),
          "observation_evidence_class_mismatch", "Observation evidence class must be derived from the admitted operation.");
          kernelAssertV2(event.observation.capability_id === operation.capability_id,
            "observation_capability_mismatch", "Observation must retain the admitted capability identity.");
          kernelAssertV2(canonicalJsonV2(event.observation.eligible_criterion_ids ?? []) === canonicalJsonV2(operation.eligible_criterion_ids ?? []),
            "observation_criterion_eligibility_mismatch", "Observation criterion eligibility must equal the immutable operation contract.");
        }
        const settledOperation = {
          ...operation,
          settlement_state: "settled" as const,
          settled_at: event.occurred_at,
          observation_retention_error: undefined,
          observation_ids: [...operation.observation_ids, event.observation.observation_id]
        };
        const operations = { ...snapshot.operations, [operation.operation_id]: settledOperation };
        if (operation.verification_of_operation_id) {
          const subject = operations[operation.verification_of_operation_id];
          kernelAssertV2(subject, "operation_verification_subject_missing", "Verification subject disappeared before settlement.");
          operations[subject.operation_id] = {
            ...subject,
            verification_operation_ids: [...new Set([...subject.verification_operation_ids, operation.operation_id])].sort()
          };
        }
        snapshot = {
          ...snapshot,
          observations: { ...snapshot.observations, [event.observation.observation_id]: structuredClone(event.observation) },
          observation_versions: { ...snapshot.observation_versions, [event.observation.observation_id]: event.assignment_version },
          operations,
          work_unit_states: {
            ...snapshot.work_unit_states,
            ...(snapshot.spec.work_units.find(unit => unit.work_unit_id === operation.work_unit_id)?.independently_useful
              ? { [operation.work_unit_id]: "retained" as const }
              : {})
          }
        };
        break;
      }
      case "observation_commit_retry_recorded": {
        const operation = snapshot.operations[event.operation_id];
        kernelAssertV2(operation && operation.settlement_state === "retaining_observation" && operation.result && operation.observation_commit,
          "observation_commit_operation_invalid", "Observation commit retry requires one durable result awaiting authoritative retention.");
        kernelAssertV2(operation.result.result_id === event.result_id && operation.observation_commit.result_id === event.result_id,
          "observation_commit_result_mismatch", "Observation commit retry must remain bound to the exact durable result.");
        kernelAssertV2(event.attempt === (operation.observation_commit_attempts ?? 0) + 1,
          "observation_commit_attempt_out_of_order", "Observation commit attempts must be monotonic.");
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: {
          ...operation,
          observation_commit_attempts: event.attempt,
          observation_retention_error: event.error_code.slice(0, 240)
        } } };
        break;
      }
      case "observation_commit_failed": {
        const operation = snapshot.operations[event.operation_id];
        kernelAssertV2(operation && operation.settlement_state === "retaining_observation" && operation.result,
          "observation_commit_operation_invalid", "Observation commit failure requires one durable result awaiting authoritative retention.");
        kernelAssertV2(operation.result.result_id === event.result_id
          && (!operation.observation_commit || operation.observation_commit.result_id === event.result_id),
          "observation_commit_result_mismatch", "Observation commit failure must remain bound to the exact durable result.");
        kernelAssertV2(event.attempt === (operation.observation_commit_attempts ?? 0) + 1,
          "observation_commit_attempt_out_of_order", "Observation commit attempts must be monotonic.");
        snapshot = {
          ...snapshot,
          progress_blocker: { code: "observation_commit_failed", gap_ids: [...operation.resolves_gap_ids], recorded_at: event.occurred_at },
          operations: { ...snapshot.operations, [operation.operation_id]: {
            ...operation,
            settlement_state: "observation_commit_failed",
            observation_commit_attempts: event.attempt,
            observation_retention_error: event.error_code.slice(0, 240)
          } }
        };
        break;
      }
      case "observation_retention_failed": {
        const operation = snapshot.operations[event.operation_id];
        kernelAssertV2(operation && operation.settlement_state === "retaining_observation" && operation.result,
          "observation_retention_operation_invalid", "Observation-retention failure requires an operation awaiting authoritative retention.");
        kernelAssertV2(event.error_code.trim().length > 0, "observation_retention_error_missing", "Observation-retention failure requires a bounded error code.");
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: {
          ...operation,
          settlement_state: "settled",
          settled_at: event.occurred_at,
          observation_retention_error: event.error_code.slice(0, 240)
        } } };
        break;
      }
      case "criterion_evaluated": {
        validateCriterionEvaluation(snapshot, event.evaluation);
        snapshot = projectWorkUnitCriteria({
          ...snapshot,
          criteria: { ...snapshot.criteria, [event.evaluation.criterion_id]: mergeEvaluation(snapshot.criteria[event.evaluation.criterion_id], structuredClone(event.evaluation)) },
          criterion_evaluation_versions: { ...snapshot.criterion_evaluation_versions, [event.evaluation.criterion_id]: event.assignment_version }
        });
        break;
      }
      case "review_requested":
        for (const workUnitId of event.work_unit_ids) kernelAssertV2(Object.prototype.hasOwnProperty.call(snapshot.work_unit_states, workUnitId), "review_work_unit_unknown", "Review cites an unknown work unit.");
        snapshot = { ...snapshot, pending_review_ids: [...new Set([...snapshot.pending_review_ids, event.review_id])].sort() };
        break;
      case "review_resolved":
        kernelAssertV2(snapshot.pending_review_ids.includes(event.review_id), "review_resolution_unknown", "Review resolution does not match a pending review.");
        snapshot = { ...snapshot, pending_review_ids: snapshot.pending_review_ids.filter((id) => id !== event.review_id) };
        break;
      case "reconciliation_recorded": {
        const operation = snapshot.operations[event.operation_id];
        kernelAssertV2(operation?.persistent_effect === "unknown", "reconciliation_operation_invalid", "Reconciliation requires an unknown-effect operation.");
        for (const observationId of event.observation_ids) kernelAssertV2(snapshot.observations[observationId], "reconciliation_observation_unknown", "Reconciliation cites an unknown observation.");
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: { ...operation, persistent_effect: event.resolved_effect } } };
        break;
      }
      case "outcome_derived": {
        const derived = deriveAssignmentOutcomeV2(withDerivedState(snapshot));
        kernelAssertV2(event.outcome === derived, "assignment_outcome_claim_invalid", "Outcome event contradicts the pure criterion projection.");
        break;
      }
      case "assignment_terminal": {
        const derivedSnapshot = withDerivedState(snapshot);
        kernelAssertV2(derivedSnapshot.quiescent, "assignment_terminal_not_quiescent", "Terminal settlement requires quiescence.");
        kernelAssertV2(event.outcome === derivedSnapshot.outcome, "assignment_terminal_outcome_invalid", "Terminal outcome contradicts the pure criterion projection.");
        snapshot = { ...derivedSnapshot, terminal: true, terminal_reason: event.reason, finished_at: event.occurred_at };
        break;
      }
    }
  }
  state.snapshot = withDerivedState(snapshot);
}

export function reduceAssignmentEventsV2(events: readonly AssignmentEventV2[]): AssignmentSnapshotV2 {
  const state: ReducerStateV2 = { superseded: false, clarificationByVariable: new Map() };
  for (const event of events) applyEvent(state, structuredClone(event));
  return structuredClone(current(state));
}

export class AssignmentJournalV2 {
  readonly #events: AssignmentEventV2[] = [];

  constructor(events: readonly AssignmentEventV2[] = []) {
    for (const event of events) this.append(event);
  }

  append(event: AssignmentEventV2): AssignmentSnapshotV2 {
    const existing = this.#events.find((candidate) => candidate.event_id === event.event_id);
    if (existing) {
      kernelAssertV2(canonicalJsonV2(existing) === canonicalJsonV2(event), "assignment_event_id_conflict", "Event identity was reused with different content.");
      return this.snapshot();
    }
    const proposed = [...this.#events, structuredClone(event)];
    const snapshot = reduceAssignmentEventsV2(proposed);
    this.#events.push(structuredClone(event));
    return snapshot;
  }

  events(): readonly AssignmentEventV2[] { return structuredClone(this.#events); }
  snapshot(): AssignmentSnapshotV2 { return reduceAssignmentEventsV2(this.#events); }
}
