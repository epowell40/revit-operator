export const NATIVE_ARTIFACT_RECEIPT_V1_SCHEMA = "revit-operator.native-artifact-receipt.v1";
const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const absolute = value => typeof value === "string" && value.length > 1 && value.length <= 2000
  && !/[\u0000-\u001f]/.test(value) && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value);

/** The wire receipt describes native file effects, never a Revit transaction. */
export function nativeArtifactReceiptEffectV1(value, method, path, requestedEffect) {
  const r = record(value);
  if (method !== "POST" || !["/revit/export-pdf", "/revit/print", "/revit/export-elements-xlsx"].includes(path) || r.schema !== NATIVE_ARTIFACT_RECEIPT_V1_SCHEMA
      || r.method !== method || r.path !== path) return null;
  const paths = r.expected_output_paths;
  if (path === "/revit/print" && ["apply", "preview"].includes(requestedEffect) && r.phase === requestedEffect
      && r.status === "not_started" && r.print_settings_untouched === true
      && ["interactive_printer_destination", "printer_capability_unavailable", "printer_unavailable", "no_printer_configured"].includes(r.not_started_reason)
      && Array.isArray(paths) && paths.length === 0 && r.expected_export_calls === 0
      && Array.isArray(r.export_calls) && r.export_calls.length === 0 && Array.isArray(r.outputs) && r.outputs.length === 0) return "none";
  if (!Array.isArray(paths) || !paths.length || paths.length > 2000 || !paths.every(absolute)
      || new Set(paths.map(p => p.toLowerCase())).size !== paths.length
      || !Number.isInteger(r.expected_export_calls) || r.expected_export_calls < 1 || r.expected_export_calls > paths.length
      || !Array.isArray(r.export_calls) || !Array.isArray(r.outputs)) return null;
  if (requestedEffect === "preview" && r.phase === "preview" && r.status === "not_started"
      && r.export_calls.length === 0 && r.outputs.length === 0) return "none";
  if (requestedEffect !== "apply" || r.phase !== "apply" || r.status !== "complete"
      || (path === "/revit/print" && r.print_settings_restored !== true)
      || r.export_calls.length !== r.expected_export_calls || !r.export_calls.every(c => c === true)
      || r.outputs.length !== paths.length) return null;
  return r.outputs.every((entry, i) => {
    const file = record(entry);
    return file.path === paths[i] && Number.isSafeInteger(file.size_bytes) && file.size_bytes > 0
      && hash(file.sha256) && file.fresh_output === true;
  }) ? "applied" : null;
}

/** Additional authority required before accepting transaction-free artifact effects. */
export function nativeArtifactResultEffectV2(value) {
  const r = record(value), identity = record(r.request_identity), receipt = record(r.native_artifact_receipt);
  if (r.authority !== "native-host" || r.dispatch_state !== "dispatched" || r.native_transaction_state !== "not_applicable"
      || r.observation_required !== true || !hash(r.raw_payload_hash)
      || r.result_schema_id !== `operator-native/POST:${identity.path}/v2`) return null;
  const effect = nativeArtifactReceiptEffectV1(receipt, identity.method, identity.path, receipt.phase);
  return effect !== null && r.persistent_effect === effect ? effect : null;
}
