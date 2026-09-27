import { createHash } from "node:crypto";
import { nativeCompletionReconciliationEffectV1, type NativeCompletionDispatchV1, type NativeCompletionReconciliationV1 } from "@revitoperator/assignment-kernel-v2-contracts";
import { readLateNativeCompletionV1, readNativeCompletionDispatchV1, retainLateNativeCompletionV1 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
import { readNativeTerminalCompletionV1, type NativeBridgeHttpResult } from "../brains/native_revit_transport.js";
import { getOrCreateOperatorToken } from "../operator_token.js";
import { storeEvidence } from "../evidence/evidence_store.js";
import { canonicalJsonV2, sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2 } from "../domain/assignment-kernel/index.js";
import { leaseFromOperation } from "./assignment_kernel_v2_execution.js";
import { appendCurrentAssignmentKernelEventV2, getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";

export type NativeCompletionLookupV1 = (dispatch: NativeCompletionDispatchV1) => Promise<NativeBridgeHttpResult>;
const digest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const fail: () => never = () => { throw new Error("assignment_native_completion_invalid"); };

/** Only exact direct native operations are recoverable. Dynamic aggregate
 * unknowns and other native children remain independent unresolved work. */
export async function recoverLateNativeCompletionV1(
  workspace: string, key: string, snapshot: AssignmentSnapshotV2, operation: OperationV2,
  lookup: NativeCompletionLookupV1 = dispatch => readNativeTerminalCompletionV1(dispatch, { token: getOrCreateOperatorToken(), timeoutMs: 10_000 })
): Promise<AssignmentSnapshotV2 | null> {
  if (operation.persistent_effect !== "unknown" || operation.settlement_state !== "settled"
    || operation.result?.authority !== "native-host" || !["apply", "preview"].includes(operation.requested_effect)) return null;
  const lease = leaseFromOperation(operation), dispatch = readNativeCompletionDispatchV1(workspace, key, lease);
  if (!dispatch) return null;
  if (canonicalJsonV2(dispatch.identity) !== canonicalJsonV2({ binding: lease.binding, operation_id: lease.operation_id, request_identity: lease.request_identity })
    || dispatch.native.request_id !== operation.result.native_correlation_id) fail();
  const previous = readLateNativeCompletionV1(workspace, key, lease);
  // Even a locally retained late receipt must pass the same-epoch lookup before
  // first reconciliation. A native restart cannot inherit this v1 authority.
  const response = await lookup(dispatch);
  const payload = object(JSON.parse(response.bodyText));
  if (payload.schema !== "revit-operator.native-completion-lookup-result/v1") fail();
  if ((response.statusCode === 202 && payload.state === "pending") || (response.statusCode === 404 && payload.state === "not_found")) return null;
  if (response.statusCode !== 200 || payload.state !== "completed" || typeof payload.record_json !== "string"
    || Buffer.byteLength(payload.record_json, "utf8") > 20 * 1024 * 1024 || digest(payload.record_json) !== payload.record_sha256) fail();
  const retained = { record_json: payload.record_json as string, record_sha256: payload.record_sha256 as string };
  if (previous && canonicalJsonV2(previous) !== canonicalJsonV2(retained)) fail();
  if (digest(retained.record_json) !== retained.record_sha256) fail();
  const record = object(JSON.parse(retained.record_json)), terminal = object(record.terminal);
  if (record.schema !== "revit-operator.native-terminal-completion/v1" || typeof terminal.body_json !== "string"
    || Buffer.byteLength(terminal.body_json, "utf8") > 16 * 1024 * 1024 || digest(terminal.body_json) !== terminal.body_sha256) fail();
  const body = object(JSON.parse(terminal.body_json));
  const { body_json: _raw, ...terminalMetadata } = terminal;
  const completion: NativeCompletionReconciliationV1 = {
    schema: "revit-operator.native-completion-reconciliation/v1", original_result_id: operation.result.result_id,
    dispatch, record_sha256: retained.record_sha256,
    // Validate before any evidence publication. Real evidence identity replaces
    // this syntactically valid placeholder only after exact raw bytes persist.
    evidence_id: `ev1_${"0".repeat(32)}`,
    receipt: { ...record, terminal: terminalMetadata },
    proof: { canonical_attempt_settlement: body.canonical_attempt_settlement,
      ...(body.transaction !== undefined ? { transaction: body.transaction } : {}),
      ...(body.artifact_receipt !== undefined ? { artifact_receipt: body.artifact_receipt } : {}) }
  };
  if (Buffer.byteLength(JSON.stringify(completion), "utf8") > 64 * 1024) fail();
  if (nativeCompletionReconciliationEffectV1(completion, operation) === null) return null;
  // A changed task binding during the read cannot publish a current receipt.
  const fresh = getAssignmentKernelSnapshotV2(lease.assignment_id);
  if (!fresh || fresh.terminal || !sameAssignmentBindingV2(fresh.current_binding, snapshot.current_binding)) fail();
  const current = fresh.operations[operation.operation_id];
  if (current?.native_completion_reconciliation?.record_sha256 === retained.record_sha256) return fresh;
  if (!current || current.persistent_effect !== "unknown" || current.result?.result_id !== operation.result.result_id) fail();
  retainLateNativeCompletionV1(workspace, key, lease, retained);
  const evidence = storeEvidence({ scope: { session_id: lease.binding.session_id, assignment_id: lease.assignment_id,
    run_id: lease.binding.run_id, generation: lease.binding.generation, attempt_id: lease.operation_id },
    source: "native-completion-recovery", media_type: "application/json", trust_level: "authoritative_native",
    bounded_summary: "Retained terminal native receipt after the original unknown result; no task success inferred.",
    verification_relevance: "supporting", raw: retained.record_json });
  const accepted = appendCurrentAssignmentKernelEventV2({ goal_id: lease.assignment_id, binding: lease.binding,
    actor: "native-completion-recovery", event_id: `native-completion:${lease.operation_id}:${retained.record_sha256}`,
    body: { event_type: "native_completion_reconciled", operation_id: lease.operation_id,
      completion: { ...completion, evidence_id: evidence.ref.evidence_id } } });
  if (!accepted.accepted) throw new Error(accepted.quarantined_reason_code ?? "native_completion_reconciliation_rejected");
  return accepted.snapshot;
}
