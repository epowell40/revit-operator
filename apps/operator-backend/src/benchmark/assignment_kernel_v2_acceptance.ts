import type { GeneralRevitExpectedEffect } from "./general_revit_capability_acceptance.js";
import { nativeOperationIdentityFromResultSchemaV2 } from "./assignment_kernel_v2_native_evidence.js";
import {
  ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA,
  ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
  parseAssignmentKernelPublicationV2
} from "@revitoperator/assignment-kernel-v2-contracts";
import { BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA } from "./assignment_kernel_v2_collection.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function bindingMatches(left: JsonRecord, right: JsonRecord): boolean {
  return ["assignment_id", "run_id", "generation", "session_id", "principal_id"]
    .every((key) => left[key] === right[key]);
}

export type AssignmentKernelAcceptanceTruthV2 = Readonly<{
  present: boolean;
  malformed: boolean;
  completed: boolean;
  verified: boolean;
  blocked: boolean;
  outcome_unknown: boolean;
  dispatched: boolean;
  apply_dispatched: boolean;
  requested_effects: readonly GeneralRevitExpectedEffect[];
  successful_task_paths: readonly string[];
}>;

const EMPTY: AssignmentKernelAcceptanceTruthV2 = Object.freeze({
  present: false,
  malformed: false,
  completed: false,
  verified: false,
  blocked: false,
  outcome_unknown: false,
  dispatched: false,
  apply_dispatched: false,
  requested_effects: [],
  successful_task_paths: []
});

/**
 * Reads benchmark acceptance truth from exact Assignment Kernel V2
 * publications. The relationship checks deliberately mirror the kernel's
 * causal chain: an admitted task operation, its task-result Observation, and
 * the required criterion evaluations must all agree. A terminal flag or a
 * successful payload alone is insufficient.
 */
export function assignmentKernelAcceptanceTruthV2(value: unknown): AssignmentKernelAcceptanceTruthV2 {
  const bundle = record(value);
  if (Object.keys(bundle).length === 0) return EMPTY;
  if (bundle.schema !== BENCHMARK_ASSIGNMENT_KERNEL_V2_BUNDLE_SCHEMA) return { ...EMPTY, present: true, malformed: true };

  const publications = records(bundle.assignments);
  const assignmentIds = strings(bundle.assignment_ids);
  const failures = records(bundle.failures);
  if (assignmentIds.length === 0 && publications.length === 0) {
    return { ...EMPTY, present: failures.length > 0, malformed: failures.length > 0 };
  }
  if (publications.length === 0 || failures.length > 0) {
    return { ...EMPTY, present: true, malformed: true };
  }

  let malformed = false;
  let completed = false;
  let verified = false;
  let blocked = false;
  let outcomeUnknown = false;
  let dispatched = false;
  let applyDispatched = false;
  const requestedEffects = new Set<GeneralRevitExpectedEffect>();
  const successfulTaskPaths = new Set<string>();

  for (const candidate of publications) {
    let publication: JsonRecord;
    try {
      publication = record(parseAssignmentKernelPublicationV2(candidate));
    } catch {
      malformed = true;
      continue;
    }
    const snapshot = record(publication.snapshot);
    const binding = record(snapshot.current_binding);
    const providerLedger = record(publication.provider_ledger);
    const assignmentId = String(publication.assignment_id ?? "").trim();
    const snapshotVersion = Number(snapshot.assignment_version);
    if (publication.schema !== ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA
        || snapshot.schema !== ASSIGNMENT_SNAPSHOT_V2_SCHEMA
        || !assignmentId
        || !assignmentIds.includes(assignmentId)
        || binding.assignment_id !== assignmentId
        || providerLedger.assignment_id !== assignmentId
        || Number(publication.assignment_version) !== snapshotVersion
        || !Number.isSafeInteger(snapshotVersion)) {
      malformed = true;
      continue;
    }

    const spec = record(snapshot.spec);
    const requestedEffect = String(spec.requested_effect ?? "").trim() as GeneralRevitExpectedEffect;
    if (!["read", "preview", "apply"].includes(requestedEffect)) {
      malformed = true;
      continue;
    }
    requestedEffects.add(requestedEffect);

    const operations = record(snapshot.operations);
    const observations = record(snapshot.observations);
    const criteria = record(snapshot.criteria);
    const criterionSpecs = records(spec.criteria);
    const requiredCriterionIds = criterionSpecs
      .filter((criterion) => criterion.required === true)
      .map((criterion) => String(criterion.criterion_id ?? "").trim())
      .filter(Boolean);
    const successfulTaskOperationIds = new Set<string>();

    for (const operationValue of Object.values(operations)) {
      const operation = record(operationValue);
      const operationId = String(operation.operation_id ?? "").trim();
      const result = record(operation.result);
      const operationBinding = record(operation.binding);
      const resultBinding = record(result.binding);
      const eligibleCriterionIds = strings(operation.eligible_criterion_ids);
      if (!operationId
          || operation.fulfillment_role !== "delegated_task_execution"
          || operation.dispatch_state !== "dispatched"
          || operation.settlement_state !== "settled"
          || result.status !== "succeeded"
          || result.dispatch_state !== "dispatched"
          || result.operation_id !== operationId
          || !bindingMatches(binding, operationBinding)
          || !bindingMatches(binding, resultBinding)
          || eligibleCriterionIds.length === 0) continue;

      const matchingObservations = Object.values(observations).map(record).filter((observation) =>
        observation.operation_id === operationId
        && observation.evidence_class === "task_result"
        && observation.fulfillment_role === "delegated_task_execution"
        && bindingMatches(binding, record(observation.binding))
        && strings(observation.eligible_criterion_ids).some((criterionId) => eligibleCriterionIds.includes(criterionId))
        && String(observation.result_schema_id ?? "") === String(result.result_schema_id ?? ""));
      if (matchingObservations.length === 0) continue;

      const observationIds = new Set(matchingObservations.map((observation) => String(observation.observation_id ?? "")));
      const supported = eligibleCriterionIds.every((criterionId) => {
        const evaluation = record(criteria[criterionId]);
        return evaluation.status === "pass"
          && strings(evaluation.supporting_operation_ids).includes(operationId)
          && records(evaluation.supporting_facts).some((fact) => observationIds.has(String(fact.observation_id ?? "")));
      });
      if (!supported) continue;

      successfulTaskOperationIds.add(operationId);
      const path = nativeOperationIdentityFromResultSchemaV2(result.result_schema_id)?.path ?? null;
      if (path) successfulTaskPaths.add(path);
    }

    const requiredCriteriaPassed = requiredCriterionIds.length > 0 && requiredCriterionIds.every((criterionId) => {
      const evaluation = record(criteria[criterionId]);
      return evaluation.status === "pass";
    });
    const terminalSuccess = snapshot.terminal === true
      && snapshot.quiescent === true
      && ["complete", "complete_with_issues", "verified_noop"].includes(String(snapshot.outcome ?? ""))
      && strings(snapshot.in_flight_operation_ids).length === 0
      && strings(snapshot.unresolved_unknown_operation_ids).length === 0;
    const terminalBlocked = snapshot.terminal === true
      && ["blocked", "failed"].includes(String(snapshot.outcome ?? ""));
    const unknown = strings(snapshot.unresolved_unknown_operation_ids).length > 0;

    dispatched ||= successfulTaskOperationIds.size > 0;
    applyDispatched ||= requestedEffect === "apply" && successfulTaskOperationIds.size > 0;
    completed ||= terminalSuccess && requiredCriteriaPassed && successfulTaskOperationIds.size > 0;
    verified ||= terminalSuccess && requiredCriteriaPassed && successfulTaskOperationIds.size > 0;
    blocked ||= terminalBlocked;
    outcomeUnknown ||= unknown;
  }

  return {
    present: true,
    malformed,
    completed: completed && !malformed,
    verified: verified && !malformed,
    blocked,
    outcome_unknown: outcomeUnknown,
    dispatched,
    apply_dispatched: applyDispatched,
    requested_effects: [...requestedEffects],
    successful_task_paths: [...successfulTaskPaths]
  };
}
