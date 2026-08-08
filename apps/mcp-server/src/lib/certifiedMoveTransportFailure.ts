import { RevitBridgeCallError } from "./revitClient.js";
import { RevitCourierError } from "./revitCourier.js";

export type CertifiedMoveTransportFailureBinding = Readonly<{
  requestInstanceHash: string;
  phase: "preview" | "apply";
}>;

/** Preserves machine-readable mutation outcome truth at the typed MCP boundary. */
export function certifiedMoveTransportFailurePayload(
  error: unknown,
  binding: CertifiedMoveTransportFailureBinding
): Readonly<Record<string, unknown>> | null {
  if (!(error instanceof RevitBridgeCallError) && !(error instanceof RevitCourierError)) return null;
  const outcomeUnknown = error.outcome_unknown === true;
  return Object.freeze({
    code: error.code,
    error: error.message,
    phase: error instanceof RevitBridgeCallError
      ? (error.phase ?? (outcomeUnknown ? "transport_post_dispatch" : "transport_pre_dispatch_or_known"))
      : (outcomeUnknown ? "courier_post_dispatch" : "courier_pre_dispatch_or_known"),
    request_instance_hash: binding.requestInstanceHash,
    request_phase: binding.phase,
    outcome_unknown: outcomeUnknown,
    retryable: outcomeUnknown ? false : error.retryable,
    reconciliation_required: outcomeUnknown
  });
}
