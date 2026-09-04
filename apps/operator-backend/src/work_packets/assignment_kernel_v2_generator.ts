import { createHash } from "node:crypto";
import type { AssignmentSnapshotV2, OperationV2 } from "../domain/assignment-kernel/index.js";
import {
  affectedOperationTargetIdentitiesV2,
  reportedOperationTargetIdentitiesV2
} from "../domain/assignment-kernel/operation_target_identity.js";
import { readEvidenceRef } from "../evidence/evidence_store.js";
import type { EvidenceRefV1 } from "../evidence/evidence_ref.js";
import type { GoalRecord } from "../goals/service.js";
import {
  VERIFIED_WORK_PACKET_SCHEMA,
  VERIFIED_WORK_PACKET_VERSION,
  type PacketEvidenceReference,
  type VerifiedWorkAction,
  type VerifiedWorkAcceptanceCriterion,
  type VerifiedWorkIssue,
  type VerifiedWorkPacketStatus,
  type VerifiedWorkPacketV1,
  type VerifiedWorkTrust
} from "./contract.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonical(nested)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function releaseIdentity(): string {
  return String(process.env.OPERATOR_RELEASE_ID || process.env.OPERATOR_SOURCE_REVISION
    || process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || "assignment-kernel-v2").trim();
}

function evidenceId(rawRef: string): string | null {
  const match = /^evidence:(ev1_[A-Za-z0-9_-]{32})$/.exec(rawRef);
  return match?.[1] ?? null;
}

function trust(ref: EvidenceRefV1): VerifiedWorkTrust {
  if (ref.trust_level === "authoritative_readback") return "independently_verified";
  if (["authoritative_native", "host_observed", "trusted_projection"].includes(ref.trust_level)) return "native_execution_evidence";
  return "agent_reported";
}

function reference(id: string): PacketEvidenceReference {
  try {
    const ref = readEvidenceRef(id);
    return {
      evidence_id: id, content_hash: ref.content_hash, byte_count: ref.byte_count,
      media_type: ref.media_type, artifact_location: ref.artifact_location,
      trust: trust(ref), verification_relevance: ref.verification_relevance,
      bounded_summary: ref.bounded_summary
    };
  } catch {
    return { evidence_id: id, content_hash: null, byte_count: null, media_type: null, artifact_location: null,
      trust: "uncertain_or_missing", verification_relevance: null, bounded_summary: null };
  }
}

function operationEvidence(snapshot: AssignmentSnapshotV2, operation: OperationV2): PacketEvidenceReference[] {
  return operation.observation_ids.flatMap(id => {
    const raw = snapshot.observations[id]?.raw_payload_ref;
    const refId = raw ? evidenceId(raw) : null;
    return refId ? [reference(refId)] : [];
  });
}

function purpose(operation: OperationV2): VerifiedWorkAction["purpose"] {
  return operation.purpose === "work" ? "action" : operation.purpose;
}

function actions(snapshot: AssignmentSnapshotV2): VerifiedWorkAction[] {
  return Object.values(snapshot.operations).sort((left, right) => left.opened_at.localeCompare(right.opened_at)).map(operation => {
    const refs = operationEvidence(snapshot, operation);
    const targetIds = reportedOperationTargetIdentitiesV2(operation);
    const affectedTargetIds = affectedOperationTargetIdentitiesV2(operation);
    const authority = operation.result?.authority === "native-host" ? "native_host"
      : operation.result?.authority === "dynamic-runtime" ? "worker" : "control_plane";
    const verification = operation.purpose === "verification"
      && operation.result?.status === "succeeded"
      && operation.observation_ids.length > 0
      && Boolean(operation.verification_of_operation_id)
      ? "passed" : operation.purpose === "verification" ? "inconclusive" : "not_requested";
    return {
      attempt_id: operation.operation_id,
      run_id: operation.binding.run_id,
      generation: operation.binding.generation,
      purpose: purpose(operation),
      requested_effect: operation.requested_effect,
      action_path: "",
      tool_identity: operation.capability_id,
      action_signature: `sha256:${digest({ capability_id: operation.capability_id, input: operation.input })}`,
      target_fingerprint: `sha256:${digest(operation.target)}`,
      target_identities: [...targetIds],
      affected_target_identities: [...affectedTargetIds],
      attempt_state: operation.settlement_state,
      admission: { state: operation.admission_state, reason: null, authority: "assignment-spec-v2" },
      dispatch: { state: operation.dispatch_state, reason: operation.result?.error_code ?? null, dispatch_id: operation.result?.native_correlation_id ?? null },
      effect: {
        state: operation.persistent_effect,
        reason: operation.result?.status ?? operation.settlement_state,
        authority,
        authority_id: operation.result?.receipt_id ?? null
      },
      verification: { state: verification, reason: null },
      receipt_references: operation.result?.receipt_id ? [{
        evidence_id: operation.result.receipt_id, content_hash: null, byte_count: null, media_type: null,
        artifact_location: null, trust: authority === "native_host" ? "native_execution_evidence" : "uncertain_or_missing",
        verification_relevance: "receipt", bounded_summary: "OperationResultV2 receipt identity."
      }] : [],
      evidence_references: refs,
      retry_of_attempt_id: operation.retry_of_operation_id ?? null,
      retry_delta: operation.retry_basis === "corrected_input" ? "corrected_schema"
        : operation.retry_basis === "corrected_admission" ? "corrected_confirmation"
          : operation.retry_basis === "new_target" ? "new_target_evidence"
            : operation.retry_basis === "reconciled_none" ? "reconciliation_none"
              : operation.retry_basis === "changed_plan" ? "changed_plan"
                : operation.retry_basis === "authorization_restored" ? "recovered_authorization"
                  : operation.retry_basis === "host_recovered" ? "resolved_host_state" : null,
      reconciliation_of_attempt_id: operation.reconciliation_of_operation_id ?? null,
      result: operation.result?.status ?? operation.settlement_state,
      trust: refs.some(ref => ref.trust === "independently_verified") ? "independently_verified"
        : refs.some(ref => ref.trust === "native_execution_evidence") ? "native_execution_evidence"
          : operation.result?.authority === "native-host" ? "native_execution_evidence" : "uncertain_or_missing"
    };
  });
}

function criteria(snapshot: AssignmentSnapshotV2): VerifiedWorkAcceptanceCriterion[] {
  return snapshot.spec.criteria.map(spec => {
    const evaluation = snapshot.criteria[spec.criterion_id];
    const refs = [...new Set((evaluation?.supporting_facts ?? []).flatMap(fact => {
      const raw = snapshot.observations[fact.observation_id]?.raw_payload_ref;
      const id = raw ? evidenceId(raw) : null;
      return id ? [id] : [];
    }))].map(reference);
    const status = evaluation?.status === "pass" ? "pass"
      : evaluation?.status === "failed" ? "fail"
        : evaluation?.status === "not_applicable" ? "not_applicable" : "uncertain";
    return {
      requirement: spec.requirement,
      status,
      authority: evaluation?.evaluator_authority ?? "missing_authority",
      trust: refs.some(ref => ref.trust === "independently_verified") ? "independently_verified"
        : refs.some(ref => ref.trust === "native_execution_evidence") ? "native_execution_evidence" : "uncertain_or_missing",
      observed_value: evaluation?.supporting_facts.map(fact => ({ observation_id: fact.observation_id, fact_id: fact.fact_id })) ?? null,
      expected_value: spec.semantic_fact_requirements,
      evidence_references: refs,
      reason: evaluation?.reason ?? "Criterion has not been evaluated by an admitted authority."
    };
  });
}

function status(snapshot: AssignmentSnapshotV2): VerifiedWorkPacketStatus {
  if (snapshot.outcome === "complete") return "verified_complete";
  if (snapshot.outcome === "complete_with_issues") return "complete_with_issues";
  if (snapshot.outcome === "verified_noop") return "verified_no_op";
  if (snapshot.outcome === "blocked") return "blocked_truthfully";
  if (snapshot.outcome === "awaiting_user_input" || snapshot.outcome === "awaiting_user_review") return "awaiting_clarification";
  return "failed";
}

function issues(snapshot: AssignmentSnapshotV2, rows: VerifiedWorkAcceptanceCriterion[]): VerifiedWorkIssue[] {
  const output: VerifiedWorkIssue[] = [];
  const executionFailureId = snapshot.execution_failure_ids.at(-1);
  const executionFailure = executionFailureId ? snapshot.execution_failures[executionFailureId] : undefined;
  if (executionFailure) output.push({
    kind: "execution_failure",
    summary: `Execution stopped at ${executionFailure.phase}: ${executionFailure.code}.`,
    affected_attempt_ids: [],
    evidence_references: [],
    user_action_required: null
  });
  if (snapshot.pending_input_variable_ids.length > 0) output.push({
    kind: "user_action_required", summary: `Required input: ${snapshot.pending_input_variable_ids.join(", ")}.`,
    affected_attempt_ids: [], evidence_references: [], user_action_required: "Supply the requested value to resume this Assignment."
  });
  if (snapshot.unresolved_unknown_operation_ids.length > 0) output.push({
    kind: "verification_uncertainty", summary: "One or more operations require target-bound reconciliation before replay or completion.",
    affected_attempt_ids: [...snapshot.unresolved_unknown_operation_ids], evidence_references: [], user_action_required: null
  });
  for (const row of rows.filter(row => row.status !== "pass" && row.status !== "not_applicable")) output.push({
    kind: row.status === "fail" ? "execution_failure" : "verification_uncertainty",
    summary: `${row.requirement}: ${row.reason}`, affected_attempt_ids: [], evidence_references: row.evidence_references, user_action_required: null
  });
  return output;
}

type ProviderUsageMetric = "input_tokens" | "output_tokens" | "total_tokens" | "estimated_cost_usd";

function assertProviderLedgerCoherent(snapshot: AssignmentSnapshotV2): void {
  const ids = [...snapshot.provider_call_ids];
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error("V2 provider ledger contains duplicate call identities.");
  const recordIds = Object.keys(snapshot.provider_calls);
  if (recordIds.length !== ids.length || recordIds.some(callId => !uniqueIds.has(callId))) {
    throw new Error("V2 provider ledger call identities and records do not match.");
  }
  for (const callId of ids) {
    const call = snapshot.provider_calls[callId];
    if (!call || call.call_id !== callId) throw new Error("V2 provider ledger call identity is inconsistent.");
    const usage = call.usage;
    if (!usage) continue;
    for (const metric of ["input_tokens", "output_tokens", "total_tokens"] as const) {
      const value = usage[metric];
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`V2 provider ledger contains invalid ${metric}.`);
      }
    }
    if (usage.estimated_cost_usd !== null
        && (!Number.isFinite(usage.estimated_cost_usd) || usage.estimated_cost_usd < 0)) {
      throw new Error("V2 provider ledger contains invalid estimated_cost_usd.");
    }
  }
}

function sumProviderUsage(snapshot: AssignmentSnapshotV2, metric: ProviderUsageMetric): number | null {
  const values = snapshot.provider_call_ids.map(callId => snapshot.provider_calls[callId]?.usage?.[metric]);
  return values.every((value): value is number => typeof value === "number")
    ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function generateVerifiedWorkPacketFromKernelV2(goal: GoalRecord, snapshot: AssignmentSnapshotV2, parentPacketId: string | null): VerifiedWorkPacketV1 {
  if (!snapshot.terminal) throw new Error("Verified Work Packet requires a settled V2 Assignment.");
  assertProviderLedgerCoherent(snapshot);
  const actionRows = actions(snapshot);
  const criterionRows = criteria(snapshot);
  const providerUsage = {
    input_tokens: sumProviderUsage(snapshot, "input_tokens"), output_tokens: sumProviderUsage(snapshot, "output_tokens"),
    total_tokens: sumProviderUsage(snapshot, "total_tokens"), estimated_cost_usd: sumProviderUsage(snapshot, "estimated_cost_usd")
  };
  const evidence = Object.values(snapshot.observations).flatMap(observation => {
    const id = evidenceId(observation.raw_payload_ref);
    return id ? [reference(id)] : [];
  });
  const body: Omit<VerifiedWorkPacketV1, "packet_id" | "packet_hash"> = {
    schema: VERIFIED_WORK_PACKET_SCHEMA,
    packet_version: VERIFIED_WORK_PACKET_VERSION,
    parent_packet_id: parentPacketId,
    identity: {
      assignment_id: goal.id,
      run_id: snapshot.current_binding.run_id,
      generation: snapshot.current_binding.generation,
      project_document_fingerprint: snapshot.current_binding.document_fingerprint ?? null,
      created_at: snapshot.finished_at ?? goal.updated_at,
      source_release_identity: releaseIdentity()
    },
    assignment: {
      normalized_user_request: snapshot.spec.source_user_request,
      requested_effect: snapshot.spec.requested_effect,
      scope: snapshot.spec.target_binding ? [JSON.stringify(canonical(snapshot.spec.target_binding))] : [],
      exclusions: [...goal.non_goals], constraints: [],
      authorization_envelope: { policy_id: snapshot.spec.authorization_policy_id, deviation_policy_id: snapshot.spec.deviation_policy_id ?? null }
    },
    status: status(snapshot),
    status_reason: snapshot.terminal_reason ?? `assignment_kernel_v2_${snapshot.outcome}`,
    grounded_targets: [...new Set(actionRows.flatMap(action => action.target_identities))].map(identity => ({
      identity, element_id: /^id:\d+$/.test(identity) ? identity.slice(3) : /^\d+$/.test(identity) ? identity : null, view_id: null, sheet_id: null,
      family_id: null, type_id: null, system_id: null, room_id: null, space_id: null,
      level_id: null, host_id: null, side: null, orientation: null, circuit_id: null,
      before_state_references: []
    })),
    actions: actionRows,
    acceptance_criteria: criterionRows,
    collateral_checks: [],
    artifacts: evidence.map(ref => ({
      role: "raw_evidence", path: ref.artifact_location, content_hash: ref.content_hash,
      byte_count: ref.byte_count, media_type: ref.media_type, evidence_reference: ref, navigation_target: null
    })),
    issues: issues(snapshot, criterionRows),
    rollback: {
      available: actionRows.some(action => action.requested_effect !== "read"),
      authority_or_transaction_identity: actionRows.find(action => action.effect.state === "applied")?.effect.authority_id ?? null,
      affected_target_identities: actionRows.flatMap(action => action.affected_target_identities),
      completed: false, evidence_references: []
    },
    performance: {
      elapsed_ms: snapshot.finished_at ? Math.max(0, Date.parse(snapshot.finished_at) - Date.parse(snapshot.spec.created_at)) : null,
      model_calls: snapshot.provider_call_ids.length,
      revit_calls: Object.values(snapshot.operations).filter(operation => operation.dispatch_authority === "native").length,
      ...providerUsage,
      telemetry_complete: Object.values(providerUsage).every(value => value !== null), human_intervention: null
    },
    trust_presentation: {
      overall: snapshot.terminal && criterionRows.length > 0 && criterionRows.every(row => row.status === "pass")
        ? "independently_verified" : "uncertain_or_missing",
      agent_reported: "Reported by an agent; never authoritative execution truth.",
      native_execution_evidence: "Bound to one OperationV2 and an authoritative retained ObservationV2.",
      independently_verified: "Accepted by the criterion model using exact Operation and Observation fact identities.",
      uncertain_or_missing: "Required authority, criterion support, or reconciliation is absent."
    }
  };
  const hash = digest(body);
  return { ...body, packet_id: `vwp1_${Buffer.from(hash, "hex").toString("base64url").slice(0, 32)}`, packet_hash: `sha256:${hash}` };
}
