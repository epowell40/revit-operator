import type { TeammateLoopState } from "./teammate_loop_runtime.js";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { verificationObservationPayloadV2 } from "./teammate_verification_evidence.js";
import { canonicalTeammateFinalVerification, type TeammateTaskRequest } from "./teammate_assignment_inputs.js";
import { nativeArtifactResultEffectV2 } from "@revitoperator/assignment-kernel-v2-contracts";
import type { AssignmentSnapshotV2 } from "./domain/assignment-kernel/snapshot.js";
import { sameAssignmentBindingV2 } from "./domain/assignment-kernel/identity.js";

/** Compatibility presentation follows the exact canonical verification result.
 * A useful native read can succeed without satisfying the apply postcondition. */
export function reconcileCanonicalToolVerification(state: TeammateLoopState | undefined,
  snapshot: AssignmentSnapshotV2, operationId: string): void {
  const operation = snapshot.operations[operationId];
  const subject = operation?.verification_of_operation_id ? snapshot.operations[operation.verification_of_operation_id] : undefined;
  if (!state?.apply_succeeded || !state.apply_call || !operation || !subject
      || operation.purpose !== "verification" || operation.fulfillment_role !== "verification"
      || operation.requested_effect !== "read" || operation.settlement_state !== "settled"
      || operation.result?.status !== "succeeded" || operation.persistent_effect !== "none"
      || !sameAssignmentBindingV2(operation.binding, snapshot.current_binding)
      || state.key.slice(0, state.key.lastIndexOf("::")) !== operation.binding.session_id
      || subject.request_identity?.path !== state.apply_call.path
      || payloadDigestV2(subject.input.body ?? subject.input).digest !== payloadDigestV2(state.apply_call.raw_body).digest) return;
  const proof = operation.observation_ids.map(id => snapshot.observations[id]).find(observation => observation
    && observation.operation_id === operationId && observation.authority === "native-host"
    && sameAssignmentBindingV2(observation.binding, operation.binding)
    && observation.raw_payload_hash === operation.result!.raw_payload_hash
    && observation.facts.some(fact => fact.fact_id === "verification.postcondition_satisfied"
      && fact.fact_class === "verification" && fact.value === true));
  state.verified = Boolean(proof);
  state.verification_mode = proof ? "target_bound_readback" : "none";
  state.verification_action_id = proof ? operationId : null;
  state.verification_evidence_sha256 = proof ? `sha256:${proof.raw_payload_hash}` : null;
  if (proof) state.completed_apply_signatures.add(state.apply_signature);
  else state.completed_apply_signatures.delete(state.apply_signature);
  // Retain accumulated native values and attempt accounting for the next read.
  state.contract.stage = proof ? "report" : "verify";
}

export function retainApplyArtifactReceipt(state: TeammateLoopState, succeeded: boolean, evidence: unknown, path: string): void {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = object(object(object(evidence).structuredContent).operation_result_v2);
  if (succeeded && nativeArtifactResultEffectV2(result) === "applied" && object(result.request_identity).path === path)
    state.apply_artifact_receipt = structuredClone(result.native_artifact_receipt);
}

export function markVerified(state: TeammateLoopState, mode: Exclude<TeammateLoopState["verification_mode"], "none">,
  actionId: string, evidence: unknown): void {
  state.verified = true;
  state.verification_mode = mode;
  state.verification_action_id = actionId;
  state.verification_evidence_sha256 = `sha256:${payloadDigestV2(verificationObservationPayloadV2(evidence)).digest}`;
  if (state.apply_signature) state.completed_apply_signatures.add(state.apply_signature);
  state.contract.stage = "report";
}

export function reconcileCanonicalFinalVerification(state: TeammateLoopState, req: TeammateTaskRequest): void {
  if (!state.apply_succeeded || state.verified) return;
  const proof = canonicalTeammateFinalVerification(req);
  if (!proof) return;
  state.verified = true;
  state.verification_mode = "target_bound_readback";
  state.verification_action_id = proof.id;
  state.verification_evidence_sha256 = `sha256:${proof.hash.replace(/^sha256:/, "")}`;
  if (state.apply_signature) state.completed_apply_signatures.add(state.apply_signature);
  state.blocked_reason = null;
  state.contract.stage = "report";
}

export function clearVerification(state: TeammateLoopState): void {
  state.verified = false;
  state.verification_mode = "none";
  state.verification_action_id = null;
  state.verification_evidence_sha256 = null;
  state.verification_observed_target_tokens.clear();
  state.verification_observed_values.clear();
  state.verification_has_substantive_readback = false;
}


export function clearKnownNoEffectApply(state: TeammateLoopState): void {
  state.stage_apply_attempts = Math.max(0, state.stage_apply_attempts - 1);
  state.apply_action_id = null;
  state.apply_succeeded = false;
  state.apply_signature = "";
  state.apply_target_tokens.clear();
  state.apply_target_tokens_inferred = false;
  state.apply_expected_values.clear();
  state.apply_call = null;
  state.apply_artifact_receipt = undefined;
  clearVerification(state);
  state.blocked_reason = null;
  state.contract.stage = state.successful_preview_signatures.size > 0 ? "preview" : "apply";
}

