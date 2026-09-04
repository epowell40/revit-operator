import { createHash } from "node:crypto";
import { payloadDigestV2, payloadRepresentationDigestV2 } from "@revitoperator/payload-digest-v2";
import type { ChatRequest, ChatResponse } from "../contracts.js";
import { getActiveGoalForSession } from "../goals/service.js";
import type { ProviderDynamicProgramV1 } from "../dynamic_runtime/provider_dynamic_program.js";
import { journalAssignmentActions, journalAssignmentToolResults } from "./turn_journal.js";
import { settleAssignmentTurn } from "./turn_settlement.js";
import {
  ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
  failAssignmentKernelOperationV2,
  markAssignmentKernelOperationDispatchStartedV2,
  openAssignmentKernelOperationV2,
  settleAssignmentKernelOperationV2,
  type AssignmentKernelOperationLeaseV2
} from "./assignment_kernel_v2_execution.js";
import { getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";
import { OPERATION_RESULT_V2_SCHEMA } from "../domain/assignment-kernel/index.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function openProviderDynamicRuntimeOperationV2(
  req: ChatRequest,
  program: ProviderDynamicProgramV1
): AssignmentKernelOperationLeaseV2 | null {
  if (!req.assignment_id || !req.assignment_run_id || !req.assignment_generation) return null;
  const snapshot = getAssignmentKernelSnapshotV2(req.assignment_id);
  if (!snapshot
      || snapshot.current_binding.run_id !== req.assignment_run_id
      || snapshot.current_binding.generation !== req.assignment_generation
      || snapshot.current_binding.session_id !== req.session_id) {
    throw new Error("assignment_kernel_v2_dynamic_runtime_binding_invalid");
  }
  return openAssignmentKernelOperationV2({
    snapshot,
    controller_request_id: `dynamic:${req.message_id}`,
    provider_turn_id: req.message_id,
    capability_id: "dynamic_revit_program",
    classified_effect: program.apply ? "apply" : "preview",
    arguments: {
      program_schema: program.schema,
      source_sha256: digest(program.source),
      category: program.category,
      parameters: program.parameters,
      limit: program.limit,
      apply: program.apply
    }
  });
}

export function markProviderDynamicRuntimeDispatchingV2(lease: AssignmentKernelOperationLeaseV2 | null): void {
  if (lease) markAssignmentKernelOperationDispatchStartedV2(lease);
}

export function failProviderDynamicRuntimeOperationV2(
  lease: AssignmentKernelOperationLeaseV2 | null,
  error: unknown,
  dispatch: "not_dispatched" | "dispatching" | "dispatched" = "dispatching"
): void {
  if (lease) failAssignmentKernelOperationV2(lease, error, dispatch);
}

/** Projects the trusted Dynamic Runtime supervisor receipt through the same
 * Assignment attempt/effect reducer used by typed and generic Revit calls. */
export function journalProviderDynamicRuntimeSettlement(
  req: ChatRequest,
  program: ProviderDynamicProgramV1,
  response: ChatResponse,
  v2Lease: AssignmentKernelOperationLeaseV2 | null = null
): void {
  const receipt = response.dynamic_program_execution_receipt;
  if (!receipt) return;
  if (v2Lease) {
    const completed = receipt.status === "completed";
    const persistentEffect = completed && program.apply ? "applied"
      : receipt.outcome_unknown && program.apply ? "unknown" : "none";
    const dispatchState = receipt.request_dispatched ? "dispatched" : "not_dispatched";
    const normalizedPayload = completed ? payloadDigestV2(response) : null;
    const sourcePayload = completed
      ? payloadRepresentationDigestV2(Buffer.from(JSON.stringify(response), "utf8"), "utf8_json_bytes")
      : null;
    const result = {
      schema: OPERATION_RESULT_V2_SCHEMA,
      result_id: `resultv2_${digest({ operation_id: v2Lease.operation_id, receipt })}`,
      operation_id: v2Lease.operation_id,
      binding: v2Lease.binding,
      status: completed ? "succeeded" : receipt.request_dispatched ? "failed_after_dispatch" : "failed_before_dispatch",
      dispatch_state: dispatchState,
      persistent_effect: persistentEffect,
      native_transaction_state: persistentEffect === "applied" ? "committed"
        : v2Lease.requested_effect === "preview" && completed ? "rolled_back"
          : persistentEffect === "unknown" ? "unknown" : "not_applicable",
      authority: "dynamic-runtime",
      result_schema_id: "operator-dynamic-runtime/provider-program/v2",
      observation_required: completed,
      ...(completed && normalizedPayload && sourcePayload ? {
        raw_payload_hash: normalizedPayload.digest,
        payload_provenance: {
          schema: "revit-operator.payload-provenance/v2",
          source: sourcePayload,
          normalized: normalizedPayload,
          transformation_id: "revit-operator.parsed-json-to-canonical-payload",
          transformation_version: "2"
        }
      } : {}),
      ...(receipt.evidence_sha256 ? { receipt_id: `dynamic-evidence:${receipt.evidence_sha256}` } : {}),
      affected_target_identities: receipt.affected_target_identities ?? [],
      request_identity: v2Lease.request_identity,
      completed_at: new Date().toISOString(),
      ...(!completed ? { error_code: receipt.failure || "dynamic_runtime_not_completed" } : {})
    };
    settleAssignmentKernelOperationV2(v2Lease, {
      content: [],
      structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: result,
        ...(completed ? {
          observation: {
            raw_payload: response,
            semantic_facts: [
              { fact_id: "task.result_available", fact_class: "domain", value: true },
              { fact_id: "dynamic_runtime.status", fact_class: "domain", value: receipt.status },
              ...(receipt.evidence_sha256 ? [{ fact_id: "dynamic_runtime.evidence_hash", fact_class: "domain", value: receipt.evidence_sha256 }] : [])
            ],
            target_scope: {},
            verification_relevance: ["task_result"]
          }
        } : {})
      }
    });
    return;
  }
  const goal = getActiveGoalForSession(req.session_id);
  const declared = `${goal?.work_budget?.requested_effect || ""}`;
  const requestedEffect: "read" | "preview" | "apply" = program.apply ? "apply" : declared === "preview" ? "preview" : "read";
  const attemptId = `dynamic:${digest({ message_id: req.message_id, source: program.source, receipt }).slice(0, 32)}`;
  const action = {
    action_id: attemptId,
    method: "POST" as const,
    path: "/revit/dynamic-program",
    request_effect: requestedEffect,
    body: { category: program.category, parameters: program.parameters, limit: program.limit, apply: program.apply }
  };
  journalAssignmentActions(req.session_id, [action], "dynamic_runtime_supervisor");
  const completed = receipt.status === "completed";
  const nativeSettlement = {
    schema: "revit-operator.native-attempt-settlement.v1",
    attempt_id: attemptId,
    requested_effect: requestedEffect,
    method: "POST",
    path: "/revit/dynamic-program",
    request_dispatched: receipt.request_dispatched,
    effect_state: completed ? (program.apply ? "applied" : "none") : receipt.outcome_unknown ? "unknown" : "none",
    effect_reason: completed
      ? program.apply ? "trusted_dynamic_runtime_apply_receipt" : "trusted_dynamic_runtime_no_persistent_effect"
      : receipt.failure || "dynamic_runtime_not_completed",
    effect_authority: completed ? "native_receipt" : receipt.outcome_unknown ? "native_host" : "transport_pre_dispatch",
    affected_target_identities: receipt.affected_target_identities ?? [],
    receipt_refs: [
      ...(receipt.evidence_sha256 ? [`dynamic-evidence:sha256:${receipt.evidence_sha256.replace(/^sha256:/, "")}`] : []),
      ...(receipt.evidence_binding_sha256 ? [`dynamic-binding:${receipt.evidence_binding_sha256}`] : [])
    ],
    evidence_refs: receipt.evidence_sha256 ? [`dynamic-evidence:sha256:${receipt.evidence_sha256.replace(/^sha256:/, "")}`] : []
  };
  journalAssignmentToolResults(req.session_id, [{
    action_id: attemptId,
    method: "POST",
    path: "/revit/dynamic-program",
    request_effect: requestedEffect,
    status: completed ? "done" : "failed",
    request_dispatched: receipt.request_dispatched,
    outcome_unknown: receipt.outcome_unknown,
    reconciliation_required: receipt.outcome_unknown,
    result_json: { dynamic_program_execution_receipt: receipt, canonical_attempt_settlement: nativeSettlement },
    error: receipt.failure ?? undefined
  }], "dynamic_runtime_supervisor");
  if (completed && program.apply && receipt.evidence_sha256) {
    settleAssignmentTurn(req.session_id, "apply", {
      schema: "revit-operator.teammate-loop-receipt.v1",
      turn_kind: "mutation", context_state: "live", stage: "report", preview_action_ids: [],
      apply_action_id: attemptId, verification_action_ids: [attemptId], apply_attempts: 1, verified: true,
      verification_mode: "trusted_dynamic_program_receipt", verification_action_id: attemptId,
      verification_evidence_sha256: `sha256:${receipt.evidence_sha256.replace(/^sha256:/, "")}`, blocked_reason: null
    });
  }
}
