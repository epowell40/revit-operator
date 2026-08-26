import { canonicalJsonV2 } from "./canonical.js";
import type { AssignmentEventV2 } from "./events.js";
import { kernelAssertV2 } from "./errors.js";
import { sameAssignmentBindingV2 } from "./identity.js";
import type { CriterionEvaluationV2 } from "./criteria.js";
import { deriveAssignmentOutcomeV2 } from "./outcome.js";
import type { OperationResultV2, OperationV2 } from "./operation.js";
import { ASSIGNMENT_SNAPSHOT_V2_SCHEMA, type AssignmentSnapshotV2 } from "./snapshot.js";

const EFFECT_RANK = { read: 0, preview: 1, apply: 2 } as const;

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
    .filter((operation) => operation.settlement_state !== "settled")
    .map((operation) => operation.operation_id)
    .sort();
  const unknown = Object.values(snapshot.operations)
    .filter((operation) => operation.persistent_effect === "unknown")
    .map((operation) => operation.operation_id)
    .sort();
  const next: AssignmentSnapshotV2 = {
    ...snapshot,
    in_flight_operation_ids: inFlight,
    unresolved_unknown_operation_ids: unknown,
    quiescent: inFlight.length === 0 && unknown.length === 0
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
  const workUnit = snapshot.spec.work_units.find((candidate) => candidate.work_unit_id === operation.work_unit_id);
  kernelAssertV2(workUnit, "operation_work_unit_unknown", "Operation work unit is not in AssignmentSpecV2.");
  kernelAssertV2(operation.requested_effect === workUnit.requested_effect, "operation_effect_mismatch", "Operation effect must come from its admitted work unit.");
  kernelAssertV2(EFFECT_RANK[operation.requested_effect] <= EFFECT_RANK[snapshot.spec.requested_effect], "operation_effect_exceeds_assignment", "Operation effect exceeds the Assignment effect envelope.");
  for (const dependencyId of workUnit.dependency_ids) kernelAssertV2(["complete", "retained"].includes(snapshot.work_unit_states[dependencyId] ?? ""), "operation_dependency_incomplete", "Operation dependencies must be complete or retained.");
  for (const variableId of workUnit.input_variable_ids) kernelAssertV2(Object.prototype.hasOwnProperty.call(snapshot.input_values, variableId), "operation_input_missing", "Operation requires a known stable input variable.");
  if (operation.retry_of_operation_id) {
    const prior = snapshot.operations[operation.retry_of_operation_id];
    kernelAssertV2(prior?.settlement_state === "settled" && prior.persistent_effect === "none", "operation_retry_unsafe", "A retry requires a settled no-effect predecessor.");
    kernelAssertV2(Boolean(operation.retry_basis), "operation_retry_basis_missing", "A retry must state the material correction that permits it.");
  } else {
    kernelAssertV2(!operation.retry_basis, "operation_retry_basis_unbound", "Retry basis requires a predecessor operation.");
  }
  kernelAssertV2(operation.admission_state === "admitted" && operation.dispatch_state === "not_dispatched", "operation_admission_shape_invalid", "A newly admitted operation must not already claim dispatch.");
  kernelAssertV2(operation.persistent_effect === "none" && operation.settlement_state === "open" && !operation.settled_at && !operation.result, "operation_admission_effect_invalid", "A newly admitted operation cannot claim a result, persistent effect, or settlement.");
}

function validateResult(operation: OperationV2, result: OperationResultV2): void {
  kernelAssertV2(result.operation_id === operation.operation_id, "operation_result_identity_mismatch", "Result operation identity is incorrect.");
  kernelAssertV2(sameAssignmentBindingV2(operation.binding, result.binding), "operation_result_binding_mismatch", "Result binding is incorrect.");
  if (result.status === "failed_before_dispatch") {
    kernelAssertV2(result.dispatch_state === "not_dispatched" && result.persistent_effect === "none", "operation_result_predispatch_invalid", "Pre-dispatch failure must prove no effect.");
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
    const inputValues = Object.fromEntries(event.spec.input_variables.filter((input) => input.value_state === "known").map((input) => [input.variable_id, input.value]));
    state.snapshot = withDerivedState({
      schema: ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
      assignment_version: event.assignment_version,
      spec: structuredClone(event.spec),
      current_binding: structuredClone(event.binding),
      input_values: inputValues,
      pending_input_variable_ids: event.spec.input_variables.filter((input) => input.required && input.value_state !== "known").map((input) => input.variable_id).sort(),
      work_unit_states: Object.fromEntries(event.spec.work_units.map((unit) => [unit.work_unit_id, "pending"])),
      pending_review_ids: [],
      operations: {}, observations: {}, criteria: {}, outcome: "active", terminal: false,
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
        snapshot = { ...snapshot, pending_input_variable_ids: [...new Set([...snapshot.pending_input_variable_ids, event.variable_id])].sort() };
        break;
      }
      case "input_supplied":
        kernelAssertV2(state.clarificationByVariable.get(event.variable_id) === event.clarification_id, "clarification_binding_invalid", "Input does not resolve the current clarification.");
        state.clarificationByVariable.delete(event.variable_id);
        snapshot = {
          ...snapshot,
          input_values: { ...snapshot.input_values, [event.variable_id]: structuredClone(event.value) },
          pending_input_variable_ids: snapshot.pending_input_variable_ids.filter((id) => id !== event.variable_id)
        };
        break;
      case "operation_admitted":
        validateOperationAdmission(snapshot, event.operation);
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [event.operation.operation_id]: structuredClone(event.operation) } };
        break;
      case "native_dispatch_recorded": {
        const operation = snapshot.operations[event.operation_id];
        kernelAssertV2(operation && operation.settlement_state === "open", "operation_dispatch_invalid", "Dispatch requires one newly admitted operation.");
        const persistentEffect = operation.requested_effect === "read" ? "none" : "unknown";
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: { ...operation, dispatch_state: "dispatched", persistent_effect: persistentEffect, settlement_state: "awaiting_result", dispatched_at: event.occurred_at } } };
        break;
      }
      case "operation_result_recorded": {
        const operation = snapshot.operations[event.result.operation_id];
        kernelAssertV2(operation && operation.settlement_state !== "settled" && !operation.result, "operation_result_unmatched", "Result requires one unsettled admitted operation without a prior result.");
        validateResult(operation, event.result);
        const settlementState = event.result.observation_required ? "retaining_observation" : "settled";
        snapshot = { ...snapshot, operations: { ...snapshot.operations, [operation.operation_id]: {
          ...operation,
          dispatch_state: event.result.dispatch_state,
          persistent_effect: event.result.persistent_effect,
          settlement_state: settlementState,
          result: structuredClone(event.result),
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
        snapshot = {
          ...snapshot,
          observations: { ...snapshot.observations, [event.observation.observation_id]: structuredClone(event.observation) },
          operations: { ...snapshot.operations, [operation.operation_id]: { ...operation, settlement_state: "settled", settled_at: event.occurred_at, observation_ids: [...operation.observation_ids, event.observation.observation_id] } }
        };
        break;
      }
      case "criterion_evaluated": {
        validateCriterionEvaluation(snapshot, event.evaluation);
        snapshot = { ...snapshot, criteria: { ...snapshot.criteria, [event.evaluation.criterion_id]: mergeEvaluation(snapshot.criteria[event.evaluation.criterion_id], structuredClone(event.evaluation)) } };
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
