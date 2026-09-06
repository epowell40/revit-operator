import assert from "node:assert/strict";
import test from "node:test";
import { nativeArtifactReceiptEffectV1, nativeArtifactResultEffectV2 } from "@revitoperator/assignment-kernel-v2-contracts";
import { nativeArtifactPostconditionV2, artifactTargetTokensV2 } from "../src/verification/native_artifact_contract_v2.js";
import { operationTargetIdentityAliasesV2 } from "../src/domain/assignment-kernel/operation_target_identity.js";
import { verificationCapabilityAdmissionForPathsV2, verificationCapabilityGuidanceV2 } from "../src/verification/verification_capability_admission_v2.js";

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
