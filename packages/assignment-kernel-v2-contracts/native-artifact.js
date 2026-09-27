export const NATIVE_ARTIFACT_RECEIPT_V1_SCHEMA = "revit-operator.native-artifact-receipt.v1";
const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const absolute = value => typeof value === "string" && value.length > 1 && value.length <= 2000
  && !/[\u0000-\u001f]/.test(value) && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value);
const samePath = (left, right) => left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
const documentIdentity = value => typeof value.session_id === "string" && value.session_id.trim().length > 0
  && value.session_id.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(value.session_id)
  && hash(value.project_fingerprint) && (value.path === "" || absolute(value.path));
const savedDocument = (value, path) => {
  const r = record(value), before = record(r.before), after = record(r.after);
  return r.native_save_returned === true && documentIdentity(before) && documentIdentity(after)
    && r.same_document === true && samePath(after.path, path)
    && r.document_session_changed === (before.session_id !== after.session_id)
    && r.document_path_changed === !samePath(before.path, after.path)
    && r.project_binding_changed === (before.project_fingerprint !== after.project_fingerprint);
};

/** The wire receipt describes native file effects, never a Revit transaction. */
export function nativeArtifactReceiptEffectV1(value, method, path, requestedEffect) {
  const r = record(value);
  if (method !== "POST" || !["/revit/export-pdf", "/revit/print", "/revit/export-elements-xlsx", "/revit/save-as"].includes(path) || r.schema !== NATIVE_ARTIFACT_RECEIPT_V1_SCHEMA
      || r.method !== method || r.path !== path) return null;
  const paths = r.expected_output_paths;
  if (path === "/revit/save-as" && ["apply", "preview"].includes(requestedEffect) && r.phase === requestedEffect
      && r.status === "not_started" && r.save_io_not_started === true && r.not_started_reason === "save_preflight_failed"
      && r.save_document == null
      && Array.isArray(paths) && paths.length === 0 && r.expected_export_calls === 0
      && Array.isArray(r.export_calls) && r.export_calls.length === 0 && Array.isArray(r.outputs) && r.outputs.length === 0) return "none";
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
      && r.export_calls.length === 0 && r.outputs.length === 0) {
    if (path === "/revit/save-as" && (paths.length !== 1 || r.expected_export_calls !== 1 || r.save_document != null)) return null;
    return "none";
  }
  if (requestedEffect !== "apply" || r.phase !== "apply" || r.status !== "complete"
      || (path === "/revit/print" && r.print_settings_restored !== true)
      || r.export_calls.length !== r.expected_export_calls || !r.export_calls.every(c => c === true)
      || r.outputs.length !== paths.length) return null;
  if (path === "/revit/save-as" && (paths.length !== 1 || r.expected_export_calls !== 1 || !savedDocument(r.save_document, paths[0]))) return null;
  return r.outputs.every((entry, i) => {
    const file = record(entry);
    return file.path === paths[i] && Number.isSafeInteger(file.size_bytes) && file.size_bytes > 0
      && hash(file.sha256) && file.fresh_output === true && (path !== "/revit/save-as" || file.stable_read === true);
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

/** A successful native document checkpoint, not a generic artifact export. */
export function nativeDocumentCheckpointResultV2(value) {
  const r = record(value), receipt = record(r.native_artifact_receipt);
  return r.status === "succeeded" && receipt.path === "/revit/save-as"
    && record(receipt.save_document).same_document === true
    && nativeArtifactResultEffectV2(value) === "applied";
}
