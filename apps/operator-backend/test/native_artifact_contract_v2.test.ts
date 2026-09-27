import assert from "node:assert/strict";
import test from "node:test";
import { nativeArtifactReceiptEffectV1, nativeArtifactResultEffectV2, nativeDocumentCheckpointResultV2 } from "@revitoperator/assignment-kernel-v2-contracts";
import { nativeArtifactPostconditionV2, artifactTargetTokensV2 } from "../src/verification/native_artifact_contract_v2.js";
import { operationTargetIdentityAliasesV2 } from "../src/domain/assignment-kernel/operation_target_identity.js";
import { verificationCapabilityAdmissionForPathsV2, verificationCapabilityGuidanceV2 } from "../src/verification/verification_capability_admission_v2.js";

function checkpointResult() {
  const file = "C:/fixture/checkpoint.rvt", identity = { session_id: "native-document", project_fingerprint: "a".repeat(64), path: file };
  return { status: "succeeded", authority: "native-host", dispatch_state: "dispatched", native_transaction_state: "not_applicable",
    observation_required: true, raw_payload_hash: "b".repeat(64), result_schema_id: "operator-native/POST:/revit/save-as/v2",
    request_identity: { method: "POST", path: "/revit/save-as" }, persistent_effect: "applied",
    native_artifact_receipt: { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: "/revit/save-as",
      phase: "apply", status: "complete", expected_output_paths: [file], expected_export_calls: 1, export_calls: [true],
      outputs: [{ path: file, size_bytes: 1024, sha256: "c".repeat(64), fresh_output: true, stable_read: true }],
      save_document: { native_save_returned: true, same_document: true, document_session_changed: false,
        before: identity, after: identity, document_path_changed: false, project_binding_changed: false } } };
}

test("document checkpoint discrimination retains complete native artifact validation", () => {
  const result = checkpointResult();
  assert.equal(nativeDocumentCheckpointResultV2(result), true);
  for (const mutate of [
    (r: typeof result) => { r.native_artifact_receipt.outputs[0]!.stable_read = false; },
    (r: typeof result) => { r.native_artifact_receipt.save_document.same_document = false; },
    (r: typeof result) => { r.native_artifact_receipt.outputs = []; },
    (r: typeof result) => { r.status = "failed_after_dispatch"; },
    (r: typeof result) => { r.authority = "operator-mcp-transport"; }
  ]) { const invalid = structuredClone(result); mutate(invalid); assert.equal(nativeDocumentCheckpointResultV2(invalid), false); }
});

test("valid export receipts with extra save metadata remain exports, never document checkpoints", () => {
  for (const route of ["/revit/export-pdf", "/revit/export-elements-xlsx"]) {
    const exported = checkpointResult();
    exported.native_artifact_receipt.path = route; exported.request_identity.path = route;
    exported.result_schema_id = `operator-native/POST:${route}/v2`;
    assert.equal(nativeArtifactResultEffectV2(exported), "applied", "existing generic artifact validation is unchanged");
    assert.equal(nativeDocumentCheckpointResultV2(exported), false);
  }
});

test("Save As requires native return, the same active document, and fresh stable file evidence without rebinding", () => {
  const path = "C:/fixture/Unit-HVAC-Draft.rvt", route = "/revit/save-as";
  const before = { session_id: "native-document-1", project_fingerprint: "a".repeat(64), path: "C:/fixture/source.rvt" };
  const after = { ...before, path };
  const saved = { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: route,
    phase: "apply", status: "complete", expected_output_paths: [path], expected_export_calls: 1, export_calls: [true],
    outputs: [{ path, size_bytes: 18739200, sha256: "b".repeat(64), fresh_output: true, stable_read: true }],
    save_document: { native_save_returned: true, same_document: true, document_session_changed: false, before, after, document_path_changed: true, project_binding_changed: false } };
  const effect = (r: unknown) => nativeArtifactReceiptEffectV1(r, "POST", route, "apply");
  assert.equal(effect(saved), "applied");
  // A path-derived project identity can change on Save As. Record that change; this receipt does not authorize a new assignment binding.
  assert.equal(effect({ ...saved, save_document: { ...saved.save_document, after: { ...after, project_fingerprint: "c".repeat(64) }, project_binding_changed: true } }), "applied");
  assert.equal(effect({ ...saved, save_document: { ...saved.save_document, after: { ...after, session_id: "native-after-save" }, document_session_changed: true } }), "applied");
  for (const change of [{ native_save_returned: false }, { same_document: false }, { after: { ...after, path: before.path } },
    { after: { ...after, session_id: "other-document" } }, { project_binding_changed: true }, { document_path_changed: false },
    { before: { ...before, project_fingerprint: "invalid" } }])
    assert.equal(effect({ ...saved, save_document: { ...saved.save_document, ...change } }), null);
  for (const change of [{ save_document: undefined }, { export_calls: [] }, { export_calls: [false] }, { status: "unverified" },
    { outputs: [{ ...saved.outputs[0], stable_read: false }] }, { outputs: [{ ...saved.outputs[0], fresh_output: false }] }])
    assert.equal(effect({ ...saved, ...change }), null);
  assert.equal(effect({ status: "Success", path, overwrite: false, compact: false, maximumBackups: 3, saveAsCentral: false }), null);
  assert.equal(nativeArtifactReceiptEffectV1(saved, "POST", "/revit/export-pdf", "apply"), null);
  const blocked = { ...saved, status: "not_started", expected_output_paths: [], expected_export_calls: 0,
    export_calls: [], outputs: [], save_document: undefined, save_io_not_started: true, not_started_reason: "save_preflight_failed" };
  assert.equal(effect(blocked), "none");
  assert.equal(effect({ ...blocked, save_io_not_started: false }), null);
  assert.equal(effect({ ...blocked, save_document: saved.save_document }), null);
  const preview = { ...saved, phase: "preview", status: "not_started", export_calls: [], outputs: [], save_document: undefined };
  assert.equal(nativeArtifactReceiptEffectV1(preview, "POST", route, "preview"), "none");
  assert.equal(nativeArtifactReceiptEffectV1({ ...preview, save_document: saved.save_document }, "POST", route, "preview"), null);
  const result = { authority: "native-host", dispatch_state: "dispatched", native_transaction_state: "not_applicable",
    observation_required: true, raw_payload_hash: "d".repeat(64), result_schema_id: `operator-native/POST:${route}/v2`,
    request_identity: { method: "POST", path: route }, persistent_effect: "applied", native_artifact_receipt: saved };
  assert.equal(nativeArtifactResultEffectV2(result), "applied");
  assert.equal(nativeArtifactResultEffectV2({ ...result, native_transaction_state: "committed" }), null);
});

test("an untouched print preflight is no effect, never delivery or a post-submission cancellation receipt", () => {
  const refused = { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: "/revit/print", phase: "apply",
    status: "not_started", print_settings_untouched: true, not_started_reason: "interactive_printer_destination",
    expected_output_paths: [], expected_export_calls: 0, export_calls: [], outputs: [] };
  assert.equal(nativeArtifactReceiptEffectV1(refused, "POST", "/revit/print", "apply"), "none");
  assert.equal(nativeArtifactPostconditionV2(refused, { ok: true, files: [] }), false);
  for (const change of [{ print_settings_untouched: false }, { print_settings_untouched: "true" },
    { print_settings_untouched: undefined }, { not_started_reason: "canceled_after_submission" },
    { export_calls: [false] }, { outputs: [{ exists: false }] }, { expected_export_calls: 1 },
    { expected_output_paths: ["C:/fixture/M000.pdf"] }, { status: "unverified" }, { phase: "preview" }])
    assert.equal(nativeArtifactReceiptEffectV1({ ...refused, ...change }, "POST", "/revit/print", "apply"), null);
  assert.equal(nativeArtifactReceiptEffectV1(refused, "POST", "/revit/export-pdf", "apply"), null);
  const result = { authority: "native-host", dispatch_state: "dispatched", native_transaction_state: "not_applicable",
    observation_required: true, raw_payload_hash: "a".repeat(64), result_schema_id: "operator-native/POST:/revit/print/v2",
    request_identity: { method: "POST", path: "/revit/print" }, persistent_effect: "none", native_artifact_receipt: refused };
  assert.equal(nativeArtifactResultEffectV2(result), "none");
  for (const change of [{ authority: "model" }, { persistent_effect: "applied" }, { raw_payload_hash: "" },
    { dispatch_state: "not_dispatched" }, { native_transaction_state: "rolled_back" }])
    assert.equal(nativeArtifactResultEffectV2({ ...result, ...change }), null);
});

const receipt = { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: "/revit/export-pdf", phase: "apply", status: "complete",
  expected_output_paths: ["C:\\fixture\\M000.pdf"], expected_export_calls: 1, export_calls: [true],
  outputs: [{ path: "C:\\fixture\\M000.pdf", size_bytes: 8251486, sha256: "a".repeat(64), fresh_output: true }] };

test("Excel workbook file effects require a native receipt and independent exact-file verification", () => {
  const route = "/revit/export-elements-xlsx";
  const workbook = { ...receipt, path: route, expected_output_paths: ["C:/fixture/rooms.xlsx"],
    outputs: [{ ...receipt.outputs[0], path: "C:/fixture/rooms.xlsx" }] };
  const read = { schema: "revit-operator.exported-file-inspection.v1", ok: true, itemsComplete: true,
    requestedPaths: workbook.expected_output_paths, files: [{ ...workbook.outputs[0], exists: true, readable: true }] };
  assert.equal(nativeArtifactReceiptEffectV1(workbook, "POST", route, "apply"), "applied");
  assert.equal(nativeArtifactPostconditionV2(workbook, read), true);
  for (const change of [{ files: [] }, { itemsComplete: false }, { files: [{ ...read.files[0], sha256: "b".repeat(64) }] },
    { files: [{ ...read.files[0], path: "C:/fixture/other.xlsx" }] }, { files: [{ ...read.files[0], readable: false }] }])
    assert.equal(nativeArtifactPostconditionV2(workbook, { ...read, ...change }), false);
  for (const mutation of [{ status: "unverified" }, { outputs: [] }, { export_calls: [false] }, { path: "/revit/delete" }])
    assert.equal(nativeArtifactReceiptEffectV1({ ...workbook, ...mutation }, "POST", route, "apply"), null);
  assert(verificationCapabilityAdmissionForPathsV2(route, "/revit/inspect-exported-files").admissible);
  assert(!verificationCapabilityAdmissionForPathsV2(route, "/revit/get-element-summary").admissible);
  assert.match(verificationCapabilityGuidanceV2({ capability_id: "revit_call_tool", path: route })!, /Do not export again/);
});

test("native export receipt requires complete current-call evidence and exact operation authority", () => {
  const base = { authority: "native-host", dispatch_state: "dispatched", native_transaction_state: "not_applicable", observation_required: true,
    raw_payload_hash: "b".repeat(64), persistent_effect: "applied", result_schema_id: "operator-native/POST:/revit/export-pdf/v2",
    request_identity: { method: "POST", path: "/revit/export-pdf" }, native_artifact_receipt: receipt };
  assert.equal(nativeArtifactReceiptEffectV1(receipt, "POST", "/revit/export-pdf", "apply"), "applied");
  assert.equal(nativeArtifactResultEffectV2(base), "applied");
  for (const altered of [
    { ...base, authority: "controller" }, { ...base, dispatch_state: "not_dispatched" }, { ...base, native_transaction_state: "committed" },
    { ...base, observation_required: false }, { ...base, raw_payload_hash: "missing" }, { ...base, persistent_effect: "none" },
    { ...base, request_identity: { method: "POST", path: "/revit/set-parameter" } },
    { ...base, native_artifact_receipt: { ...receipt, export_calls: [false] } },
    { ...base, native_artifact_receipt: { ...receipt, outputs: [{ ...receipt.outputs[0], fresh_output: false }] } },
    { ...base, native_artifact_receipt: { ...receipt, outputs: [] } },
    { ...base, native_artifact_receipt: undefined }
  ]) assert.equal(nativeArtifactResultEffectV2(altered), null);
});

test("file postcondition requires exact full-set digests, not an exists flag or echoed request", () => {
  const read = { schema: "revit-operator.exported-file-inspection.v1", ok: true, itemsComplete: true,
    requestedPaths: ["c:/fixture/m000.pdf"], files: [{ ...receipt.outputs[0], path: "c:/fixture/m000.pdf", exists: true, readable: true }] };
  assert.equal(nativeArtifactPostconditionV2(receipt, read), true);
  for (const bad of [{ ok: true, exists: true }, { request: read }, { ...read, requestedPaths: [] }, { ...read, files: [] },
    { ...read, files: [...read.files, ...read.files] }, { ...read, itemsComplete: false },
    { ...read, files: [{ ...read.files[0], sha256: "c".repeat(64) }] },
    { ...read, files: [{ ...read.files[0], size_bytes: 1 }] },
    { ...read, files: [{ ...read.files[0], exists: false }] },
    { ...read, files: [{ ...read.files[0], readable: false }] },
    { ...read, files: [{ ...read.files[0], path: "C:/fixture/M001.pdf" }] }
  ]) assert.equal(nativeArtifactPostconditionV2(receipt, bad), false);
  assert.equal(nativeArtifactPostconditionV2({ status: "Success", verification: { exists: true } }, read), false);
});

test("artifact identities bind path separators and case without accepting a different file or view id", () => {
  const input = artifactTargetTokensV2({ body: { paths: ["C:\\fixture\\M000.pdf"] } });
  assert.deepEqual(input, ["artifact_path:c:/fixture/m000.pdf"]);
  assert(operationTargetIdentityAliasesV2("artifact_path:C:\\fixture\\M000.pdf").includes(input[0]!));
  assert.deepEqual(artifactTargetTokensV2({ request: { paths: ["C:/fixture/M000.pdf"] }, viewId: 1420963 }), []);
  assert(verificationCapabilityAdmissionForPathsV2("/revit/export-pdf", "/revit/inspect-exported-files").admissible);
  assert(!verificationCapabilityAdmissionForPathsV2("/revit/export-pdf", "/revit/get-element-summary").admissible);
  assert.match(verificationCapabilityGuidanceV2({ capability_id: "revit_call_tool", path: "/revit/export-pdf" })!, /Do not export again/);
});

test("driver print file verification requires restored settings and binds the exact print route", () => {
  const printed = { ...receipt, path: "/revit/print", print_settings_restored: true };
  const read = { schema: "revit-operator.exported-file-inspection.v1", ok: true, itemsComplete: true,
    requestedPaths: printed.expected_output_paths, files: [{ ...printed.outputs[0], exists: true, readable: true }] };
  assert.equal(nativeArtifactPostconditionV2(printed, read), true);
  for (const restored of [undefined, false, "true"])
    assert.equal(nativeArtifactPostconditionV2({ ...printed, print_settings_restored: restored }, read), false);
  assert.equal(nativeArtifactReceiptEffectV1(printed, "POST", "/revit/export-pdf", "apply"), null);
  assert(verificationCapabilityAdmissionForPathsV2("/revit/print", "/revit/inspect-exported-files").admissible);
  assert(!verificationCapabilityAdmissionForPathsV2("/revit/print", "/revit/get-element-summary").admissible);
  assert.match(verificationCapabilityGuidanceV2({ capability_id: "revit_call_tool", path: "/revit/print" })!, /Do not export again/);
});
