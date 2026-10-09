import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { directKernelPublicationsV2 } from "./protocol_v2_kernel.js";
import { assignmentKernelNativeEvidenceProjectionV2 } from "./assignment_kernel_v2_native_evidence.js";

type Row = Record<string, unknown>;
function row(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
const keys = ["assignment_id", "run_id", "generation", "session_id", "principal_id", "document_fingerprint"] as const;
function sameBinding(a: Row, b: Row): boolean { return keys.every(key => a[key] !== undefined && a[key] === b[key]); }

export type BoundNativeReviewEvidence = {
  assignment_id: string;
  operation_id: string;
  path: string;
  requested_effect: "read" | "preview" | "apply";
  document_fingerprint: string;
  dispatched_at: string;
  completed_at: string;
  payload_hash: string;
  observation_ids: string[];
  payload: Row;
};

/** Resolves evidence, never task acceptance. Callers must separately prove each
 * requested outcome, ordering, target identity, delivery, and collateral scope.
 * A failed/unknown sibling operation is not erased by resolving another receipt.
 */
export function boundNativeReviewEvidence(bundle: unknown, resolvePayload?: (reference: string) => unknown): BoundNativeReviewEvidence[] {
  const native = assignmentKernelNativeEvidenceProjectionV2(bundle);
  if (!native.present || native.malformed) return [];
  let publications: Row[];
  try { publications = directKernelPublicationsV2({ durable_assignment_kernel_v2: bundle }); }
  catch { return []; }
  const resolved: BoundNativeReviewEvidence[] = [];
  for (const evidence of native.operations) {
    if (evidence.outcome !== "completed") continue;
    const publicationsForId = publications.filter(p => p.assignment_id === evidence.assignment_id);
    if (publicationsForId.length !== 1) return [];
    const snapshot = row(publicationsForId[0]!.snapshot), binding = row(snapshot.current_binding);
    const operation = row(row(snapshot.operations)[evidence.operation_id]), result = row(operation.result);
    const document = binding.document_fingerprint;
    if (typeof document !== "string" || !document.trim() || result.authority !== "native-host"
      || result.result_id !== evidence.result_id || !sameBinding(binding, row(operation.binding))
      || !sameBinding(binding, row(result.binding))) continue;
    const request = row(operation.request_identity), resultRequest = row(result.request_identity);
    if (request.path !== evidence.path || request.method !== evidence.method
      || resultRequest.path !== evidence.path || resultRequest.method !== evidence.method) continue;
    if (evidence.requested_effect === "apply") {
      if (operation.persistent_effect !== "applied" || result.persistent_effect !== "applied"
        || result.native_transaction_state !== "committed") continue;
    } else if (operation.persistent_effect !== "none" || result.persistent_effect !== "none") continue;
    const boundObservations = evidence.observation_ids.map(id => row(row(snapshot.observations)[id]))
      .filter(observation => observation.authority === "native-host" && sameBinding(binding, row(observation.binding))
        && observation.raw_payload_hash === result.raw_payload_hash);
    let rawPayload = row(operation.observation_commit).raw_payload;
    if (rawPayload === undefined && resolvePayload) {
      const refs = [...new Set(boundObservations.map(o => o.raw_payload_ref)
        .filter((ref): ref is string => typeof ref === "string" && ref.startsWith("evidence:")))];
      if (refs.length !== 1) continue;
      try { rawPayload = resolvePayload(refs[0]!); } catch { continue; }
    }
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) continue;
    const payload = row(rawPayload);
    const hash = payloadDigestV2(payload).digest;
    if (hash !== result.raw_payload_hash) continue;
    const observationIds = evidence.observation_ids.filter(id => {
      const observation = row(row(snapshot.observations)[id]);
      return observation.authority === "native-host" && sameBinding(binding, row(observation.binding)) && observation.raw_payload_hash === hash;
    });
    if (!observationIds.length) continue;
    const start = Date.parse(evidence.dispatched_at ?? ""), end = Date.parse(evidence.completed_at ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    resolved.push({ assignment_id: evidence.assignment_id, operation_id: evidence.operation_id,
      path: evidence.path, requested_effect: evidence.requested_effect, document_fingerprint: document,
      dispatched_at: evidence.dispatched_at!, completed_at: evidence.completed_at!, payload_hash: hash,
      observation_ids: observationIds, payload });
  }
  return resolved;
}
