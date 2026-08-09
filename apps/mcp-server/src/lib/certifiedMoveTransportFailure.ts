import { RevitBridgeCallError } from "./revitClient.js";
import { RevitCourierError } from "./revitCourier.js";

export type CertifiedMoveTransportFailureBinding = Readonly<{
  requestInstanceHash: string;
  phase: "preview" | "apply";
  familyId: string;
  familyHash: string;
  admissionSessionId: string;
  documentFingerprint: string;
  documentSessionId: string;
  sourceScopedId: string;
  elementId: number;
  observationId: string;
  observationBindingHash: string;
  nativeAttestationKeyId: string;
  previewInstanceHash: string | null;
  previewReceiptHash: string | null;
  policyHash: string | null;
  policyRecordHash: string | null;
  evidenceRecordHash: string | null;
  effectHash: string | null;
  outboundBodySha256: string;
  channel: string;
  alias: string | null;
}>;

function certificationBindingProjection(binding: CertifiedMoveTransportFailureBinding): Readonly<Record<string, unknown>> {
  return Object.freeze({
    family_id: binding.familyId,
    family_hash: binding.familyHash,
    request_instance_hash: binding.requestInstanceHash,
    admission_session_id: binding.admissionSessionId,
    document_fingerprint: binding.documentFingerprint,
    document_session_id: binding.documentSessionId,
    source_scoped_id: binding.sourceScopedId,
    element_id: binding.elementId,
    observation_id: binding.observationId,
    observation_binding_hash: binding.observationBindingHash,
    native_attestation_key_id: binding.nativeAttestationKeyId,
    preview_instance_hash: binding.previewInstanceHash,
    preview_receipt_hash: binding.previewReceiptHash,
    policy_hash: binding.policyHash,
    policy_record_hash: binding.policyRecordHash,
    evidence_record_hash: binding.evidenceRecordHash,
    effect_hash: binding.effectHash,
    outbound_body_sha256: binding.outboundBodySha256,
    channel: binding.channel,
    alias: binding.alias
  });
}

/** Preserves machine-readable mutation outcome truth at the typed MCP boundary. */
export function certifiedMoveTransportFailurePayload(
  error: unknown,
  binding: CertifiedMoveTransportFailureBinding
): Readonly<Record<string, unknown>> | null {
  if (!(error instanceof RevitBridgeCallError) && !(error instanceof RevitCourierError)) return null;
  const outcomeUnknown = error.outcome_unknown === true;
  const dispatchId = error instanceof RevitCourierError ? error.job_id : (error.correlation_id ?? null);
  return Object.freeze({
    code: error.code,
    error: error.message,
    phase: error instanceof RevitBridgeCallError
      ? (error.phase ?? (outcomeUnknown ? "transport_post_dispatch" : "transport_pre_dispatch_or_known"))
      : (outcomeUnknown ? "courier_post_dispatch" : "courier_pre_dispatch_or_known"),
    request_instance_hash: binding.requestInstanceHash,
    request_phase: binding.phase,
    dispatch_id: dispatchId,
    correlation_id: dispatchId,
    certification_binding: certificationBindingProjection(binding),
    outcome_unknown: outcomeUnknown,
    retryable: outcomeUnknown ? false : error.retryable,
    reconciliation_required: outcomeUnknown
  });
}

export function certifiedMovePostDispatchVerificationFailurePayload(
  error: unknown,
  binding: CertifiedMoveTransportFailureBinding,
  context: Readonly<{ dispatchId: string; correlationId: string }> | null
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    code: "CERTIFICATION_EXECUTION_OUTCOME_UNKNOWN",
    error: String(error),
    phase: "certification_post_dispatch",
    request_instance_hash: binding.requestInstanceHash,
    request_phase: binding.phase,
    dispatch_id: context?.dispatchId ?? null,
    correlation_id: context?.correlationId ?? null,
    certification_binding: certificationBindingProjection(binding),
    outcome_unknown: true,
    retryable: false,
    reconciliation_required: true
  });
}
