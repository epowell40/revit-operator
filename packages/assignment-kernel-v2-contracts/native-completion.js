import { nativeArtifactReceiptEffectV1 } from "./native-artifact.js";

const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const hash = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

/** Pure receipt semantics only. The trusted edge authenticates the dispatch map,
 * native lookup and exact retained bytes before admitting this bounded proof.
 * Replayed journals recheck all identities/effect semantics with this predicate.
 * This establishes a known effect, never task success or criterion verification.
 */
export function nativeCompletionReconciliationEffectV1(value, operation) {
  const p = object(value), dispatch = object(p.dispatch), identity = object(dispatch.identity), n = object(dispatch.native);
  const r = object(p.receipt), request = object(r.request), doc = object(r.document), auth = object(r.authorization);
  const terminal = object(r.terminal), proof = object(p.proof), settlement = object(proof.canonical_attempt_settlement);
  const original = object(operation?.result), binding = object(operation?.binding), admitted = object(operation?.request_identity);
  if (p.schema !== "revit-operator.native-completion-reconciliation/v1"
    || dispatch.schema !== "revit-operator.native-completion-dispatch/v1" || r.schema !== "revit-operator.native-terminal-completion/v1"
    || p.original_result_id !== original.result_id || original.authority !== "native-host"
    || original.persistent_effect !== "unknown" || original.dispatch_state !== "dispatched"
    || !["apply", "preview"].includes(operation.requested_effect) || operation.settlement_state !== "settled"
    || !text(admitted.request_signature) || canonical(identity.binding) !== canonical(binding)
    || identity.operation_id !== operation.operation_id || canonical(identity.request_identity) !== canonical(admitted)
    || canonical(original.binding) !== canonical(binding) || canonical(original.request_identity) !== canonical(admitted)
    || original.native_correlation_id !== n.request_id || !/^[a-f0-9]{64}$/.test(n.request_id ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(n.server_epoch ?? "")
    || !hash(n.request_nonce_sha256) || !hash(n.source_body_sha256) || !hash(n.transport_receipt_sha256)
    || n.method !== admitted.method || n.path !== admitted.path || n.method !== "POST" || n.body_present !== true
    || !/^[a-f0-9]{64}$/.test(binding.document_fingerprint ?? "") || n.expected_document_fingerprint !== binding.document_fingerprint
    || doc.document_fingerprint !== binding.document_fingerprint || !text(doc.document_session_id)
    || doc.after_document_fingerprint !== doc.document_fingerprint || doc.after_document_session_id !== doc.document_session_id
    || !hash(p.record_sha256) || !/^ev1_[A-Za-z0-9_-]{32}$/.test(p.evidence_id ?? "")
    || !hash(terminal.body_sha256) || !Number.isSafeInteger(terminal.status_code) || terminal.status_code < 200 || terminal.status_code > 599
    || !hash(auth.authorization_hash) || !text(auth.exposure_profile) || auth.certification_envelope_hash !== null
    || !hash(request.authorized_body_sha256) || request.dispatched_body_sha256 !== n.source_body_sha256
    || !["generic_call", "typed_mcp"].includes(n.channel) || !text(n.alias)) return null;
  for (const key of ["request_id", "request_nonce_sha256", "server_epoch", "method", "path", "body_present", "source_body_sha256", "channel", "alias"])
    if (request[key] !== n[key]) return null;
  const start = Date.parse(r.dispatch_started_at_utc), finish = Date.parse(r.completed_at_utc), authorized = Date.parse(auth.authorized_at_utc);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || !Number.isFinite(authorized) || finish < start || authorized > start
    || settlement.schema !== "revit-operator.native-attempt-settlement.v1"
    || settlement.requested_effect !== operation.requested_effect || settlement.method !== n.method || settlement.path !== n.path
    || settlement.request_dispatched !== true || !["none", "applied"].includes(settlement.effect_state)) return null;
  const affected = settlement.affected_target_identities;
  if (!Array.isArray(affected) || affected.length > 256 || affected.some(id => !text(id)) || new Set(affected).size !== affected.length) return null;
  if (proof.artifact_receipt !== undefined) {
    if (operation.requested_effect !== "apply") return null;
    const effect = nativeArtifactReceiptEffectV1(proof.artifact_receipt, n.method, n.path, "apply");
    return effect !== null && effect === settlement.effect_state && settlement.effect_authority === "native_receipt"
      && settlement.effect_reason === (effect === "applied" ? "native_artifact_export_completed" : "native_artifact_export_not_started") ? effect : null;
  }
  const transaction = object(proof.transaction);
  if (operation.requested_effect === "apply" && transaction.status === "committed" && transaction.committed === true && settlement.effect_state === "applied"
    && settlement.effect_authority === "native_transaction" && settlement.effect_reason === "native_transaction_committed") return "applied";
  if (["rolled_back", "rolledback"].includes(transaction.status) && transaction.committed === false && settlement.effect_state === "none"
    && settlement.effect_authority === "native_rollback" && settlement.effect_reason === "verified_native_rollback") return "none";
  if (transaction.status === "not_started" && transaction.committed === false && affected.length === 0 && settlement.effect_state === "none"
    && ["native_transaction", "native_host"].includes(settlement.effect_authority) && settlement.effect_reason === "native_transaction_not_started") return "none";
  return null;
}
