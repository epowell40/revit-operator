import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
test("requested family parameters are verified inside native placement instead of silently skipped", () => {
  const source = readFileSync(process.env.OPERATOR_PLACEMENT_HANDLER_SOURCE_FOR_TEST
    ?? new URL("../../../revit-bridge-addin/RevitBridge.Logic/Handlers/PlaceFamiliesHandler.cs", import.meta.url), "utf8");
  assert.ok(source.includes("ApplyRequestedParameters(doc, fi, instData.parameters, instResult, apply: true)"));
  assert.ok(source.includes("VerifyRequestedParameters(fi, parameterExpectations, instResult, afterCommit: false)"));
  assert.ok(source.includes("public bool success => PlacementParameterValues.ResultSucceeded(status, failedCount, parameterVerificationFailedCount)"));
});

test("Save As transport preserves exact nontransactional file proof and document transitions without rebinding", async () => {
  const route = "/revit/save-as", filePath = "C:/fixture/Unit-HVAC-Draft.rvt";
  const body = { filePath, overwrite: false, dryRun: false };
  const before = { session_id: "native-before-save", project_fingerprint: "a".repeat(64), path: "C:/fixture/source.rvt" };
  const after = { ...before, session_id: "native-after-save", path: filePath };
  const complete = { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: route, phase: "apply", status: "complete",
    expected_output_paths: [filePath], expected_export_calls: 1, export_calls: [true],
    outputs: [{ path: filePath, size_bytes: 18739200, sha256: "b".repeat(64), fresh_output: true, stable_read: true }],
    save_document: { native_save_returned: true, same_document: true, before, after,
      document_session_changed: true, document_path_changed: true, project_binding_changed: false } };
  for (const variant of ["complete", "blocked", "uncertain", "legacy"] as const) {
    const applied = variant === "complete", blocked = variant === "blocked";
    const receipt = blocked ? { ...complete, status: "not_started", expected_output_paths: [], expected_export_calls: 0,
      export_calls: [], outputs: [], save_document: undefined, save_io_not_started: true, not_started_reason: "save_preflight_failed" }
      : variant === "uncertain" ? { ...complete, status: "unverified", outputs: [{ ...complete.outputs[0], stable_read: false }] } : complete;
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, {
        status: applied || variant === "legacy" ? "Success" : "Blocked", path: filePath, overwrite: false, compact: false, maximumBackups: 3, saveAsCentral: false,
        ...(variant === "legacy" ? {} : { ok: applied, artifact_receipt: receipt }),
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
          effect_state: applied ? "applied" : blocked ? "none" : "unknown", effect_authority: applied || blocked ? "native_receipt" : "native_host",
          effect_reason: applied ? "native_artifact_export_completed" : blocked ? "native_artifact_export_not_started" : "native_artifact_export_unverified",
          request_dispatched: true, affected_target_identities: applied ? ["artifact_path:" + filePath] : [] }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, applied ? "applied" : blocked ? "none" : "unknown");
    assert.equal(result.native_transaction_state, applied || blocked ? "not_applicable" : "unknown");
    assert.equal(nativeArtifactResultEffectV2(result), applied ? "applied" : blocked ? "none" : null);
    if (applied) {
      assert.deepEqual(result.native_artifact_receipt.save_document, complete.save_document);
      assert.deepEqual(result.binding, binding);
      assert.notEqual(result.binding.session_id, after.session_id);
    }
  }
});
test("missing create-similar host is correctable only with authoritative not-started receipt", async () => {
  const route="/revit/create-similar-from-instance",body={exemplarElementId:1464223,placements:[{pointXyz:[-37.2,-2.7,42.32152230971508],label:"HRU403"}],levelName:"L4",dryRun:false};
  for(const confirmed of [true,false]) {
    const decorated=await runWithAssignmentKernelV2(meta("apply","work",{method:"POST",path:route,body}),async()=>{
      const request=await beginAssignmentKernelNativeRequestV2("POST",route,body,{classified_effect:"apply"});
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST",route,{
        status:"Blocked",success:false,applied:false,errorCode:"create_similar_host_required",
        error:"No host element was available for create-similar. No transaction was started.",
        ...(confirmed?{transaction:{status:"not_started",committed:false,affected_element_ids:[]}}:{}),
        canonical_attempt_settlement:{schema:"revit-operator.native-attempt-settlement.v1",requested_effect:"apply",
          effect_state:confirmed?"none":"unknown",effect_authority:confirmed?"native_transaction":"native_host",
          effect_reason:confirmed?"native_transaction_not_started":"native_handler_returned_without_authoritative_settlement",request_dispatched:true}
      },request);
      return decorateAssignmentKernelMcpResultV2({content:[]},"revit_call_tool") as any;
    });
    const result=decorated.structuredContent.operation_result_v2;
    assert.equal(result.status,"failed_after_dispatch");
    assert.equal(result.persistent_effect,confirmed?"none":"unknown");
    assert.equal(result.native_transaction_state,confirmed?"not_started":"unknown");
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((f:any)=>f.fact_id==="task.result_available"&&f.value===true),false);
  }
});
import { ductPreviewFixture } from "./mepDuctPreviewEvidence.fixtures.js";

test('atomic branch-network rollback is a failed operation; child commits and rollback prose cannot fabricate persistence', async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/c40-atomic-network-rollback.json',import.meta.url),'utf8'));
  for(const variant of ['confirmed','missing','failed'] as const){
    const route='/revit/mep-branch-network-workflow';
    const body=fixture.input.body;
    const confirmed=variant==='confirmed';
    const decorated=await runWithAssignmentKernelV2(meta('apply','work',{method:'POST',path:route,body}),async()=>{
      const request=await beginAssignmentKernelNativeRequestV2('POST',route,body,{classified_effect:'apply'});
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2('POST',route,{
        ...fixture.payload,status:variant==='failed'?'BlockedRollbackFailed':'BlockedRolledBack',atomicRollbackSucceeded:variant!=='failed',
        ...(variant==='missing'?{}:{transaction:{status:confirmed?'rolled_back':'atomic_group_rollback_unconfirmed',committed:confirmed?false:null,affected_element_ids:[]}}),
        canonical_attempt_settlement:{schema:'revit-operator.native-attempt-settlement.v1',requested_effect:'apply',
          effect_state:confirmed?'none':'unknown',effect_authority:confirmed?'native_rollback':'native_host',
          effect_reason:confirmed?'verified_native_rollback':'native_handler_returned_without_authoritative_settlement',request_dispatched:true,affected_target_identities:[]}
      },request);
      return decorateAssignmentKernelMcpResultV2({content:[]},'revit_call_tool') as any;
    });
    const result=decorated.structuredContent.operation_result_v2;
    assert.equal(result.status,'failed_after_dispatch');
    assert.equal(result.persistent_effect,confirmed?'none':'unknown');
    assert.equal(result.native_transaction_state,confirmed?'rolled_back':'unknown');
    assert.deepEqual(result.affected_target_identities,[]);
  }
});

test("single-duct and route previews preserve rollback authority and typed proof at the MCP boundary", async () => {
  for (const legacy of [false, true]) for (const variant of ["valid", "wrong_size", "missing_receipt"] as const) {
    const f = ductPreviewFixture(legacy);
    if (variant === "wrong_size") f.payload.segments[0].nativeSizeReadback.widthFt = 2;
    if (variant === "missing_receipt") {
      delete f.payload.transaction;
      f.payload.canonical_attempt_settlement.effect_state = "unknown";
      f.payload.canonical_attempt_settlement.effect_authority = "native_host";
      f.payload.canonical_attempt_settlement.effect_reason = "native_handler_returned_without_authoritative_settlement";
    }
    const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: f.path, body: f.body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", f.path, f.body, { classified_effect: "preview" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", f.path, f.payload, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, variant === "valid" ? "succeeded" : "failed_after_dispatch");
    assert.equal(result.persistent_effect, variant === "missing_receipt" ? "unknown" : "none");
    assert.equal(result.native_transaction_state, variant === "missing_receipt" ? "unknown" : "rolled_back");
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "task.preview_valid"), variant === "valid");
  }
});

test("C81 family placement preview settles with typed proof; mismatched placement stays blocked without replay", async () => {
  const route = "/revit/create-family-instance";
  const body = { familyName: "HeatRecoveryUnit", typeName: "Heat Recovery Unit (HRU)", levelName: "L4",
    x: -34.4, y: -7.5, z: 41.1666666667, rotationDegrees: 0, dryRun: true };
  const native = { status: "Dry Run", dryRun: true, requestedCount: 1, familyName: "HeatRecoveryUnit",
    symbolName: "Heat Recovery Unit (HRU)", levelName: "L4", targetView: null,
    planned: [{ index: 0, x: -34.4, y: -7.5, z: 41.1666666667, rotationDegrees: 0 }],
    transaction: { status: "rolled_back", committed: false, modified_element_ids: [], affected_element_ids: [],
      added_element_ids: [], deleted_element_ids: [] } };
  for (const altered of [false, true]) {
    const payload = structuredClone(native);
    if (altered) payload.planned[0]!.x = -31.4;
    const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "preview" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, {
        ...payload, canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "preview",
          effect_state: "none", effect_authority: "native_rollback",
          effect_reason: "verified_native_rollback", request_dispatched: true,
          affected_target_identities: []
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, altered ? "failed_after_dispatch" : "succeeded");
    assert.equal(result.persistent_effect, "none");
    assert.equal(result.native_transaction_state, "rolled_back");
    assert.equal(result.result_semantic_gap?.reason_code, altered ? "preview_result_contract_invalid" : undefined);
    assert.equal(result.result_semantic_gap?.native_replay_allowed, altered ? false : undefined);
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) =>
      fact.fact_id === "task.preview_valid" && fact.value === true), !altered);
  }
});

test("C81 bulk family preview retains native rollback authority and rejects mismatched spatial readback", async () => {
  const route = "/revit/place-families";
  const body = { levelName: "L4", viewId: 1363433, familySymbolId: 1365172,
    instances: [{ x: -37.4, y: -5.6, z: 44.1666667, coordinateMode: "absolute_model", rotationDegrees: 0 }], dryRun: true };
  const row = { index: 0, status: "planned", elementId: null, reason: "dryRun: rolled back",
    coordinateMode: "absolute_model", requestedLocationX: -37.4, requestedLocationY: -5.6,
    requestedLocationZ: 44.1666667, absoluteModelCorrectionDistanceFt: 0,
    absoluteModelLocationVerified: true, familySymbolId: 1365172, hostElementId: null,
    linkedHostElementId: null, locationX: -37.4, locationY: -5.6, locationZ: 44.1666667,
    inTargetViewCollector: true, viewSpecificBoundingBoxAvailable: true,
    bboxMinX: -39.1, bboxMinY: -7.9, bboxMinZ: 44.1666667,
    bboxMaxX: -35.6, bboxMaxY: -3.2, bboxMaxZ: 45.2, warnings: [] };
  const native = { status: "Planned", familyPlacementType: "OneLevelBased", requiresExplicitHost: false,
    unhostedWorkPlanePlacementAllowed: false, placedCount: 0, skippedCount: 0, failedCount: 0,
    selectedWorksetId: null, selectedWorksetName: null, elementIds: [], results: [row], warnings: [], error: null,
    transaction: { status: "rolled_back", committed: false, modified_element_ids: [], affected_element_ids: [],
      added_element_ids: [], deleted_element_ids: [] } };
  for (const altered of [false, true]) {
    const payload = structuredClone(native);
    if (altered) payload.results[0]!.locationY = -3.6;
    const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "preview" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, {
        ...payload, canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "preview",
          effect_state: "none", effect_authority: "native_rollback",
          effect_reason: "verified_native_rollback", request_dispatched: true,
          affected_target_identities: []
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, altered ? "failed_after_dispatch" : "succeeded");
    assert.equal(result.persistent_effect, "none");
    assert.equal(result.native_transaction_state, "rolled_back");
    assert.equal(result.result_semantic_gap?.reason_code, altered ? "preview_result_contract_invalid" : undefined);
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) =>
      fact.fact_id === "task.preview_valid" && fact.value === true), !altered);
  }
});

test("blocked MEP trial is a failed operation with its authoritative rollback, while missing transaction truth stays unknown", async () => {
  for (const confirmed of [false, true]) {
    const body = { kind: "duct", points: [{ xyz: [-26.62, -12.05, 42.125] }, { xyz: [13.79, -12.05, 42.125] }],
      ductTypeId: 139186, ductShape: "rectangular", ductSize: "12x10", apply: true, connectToExisting: false };
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/mep-route-workflow", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/mep-route-workflow", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/mep-route-workflow", {
        status: "Blocked", workflowMode: "applyRequested", executionOrder: ["resolve-routing-context", "dry-run-create-route"],
        dryRun: { status: "Blocked", error: "Selected duct type created shape 'round', but requested size/ductShape requires 'rectangular'.",
          dryRun: true, createdElementIds: [], rolledBack: true }, applyResult: null,
        visualVerification: { status: "SkippedBlockedDryRun", reason: "The dry-run did not pass, so no model write or visual export was attempted." },
        ...(confirmed ? { transaction: { status: "rolled_back", committed: false, modified_element_ids: [], affected_element_ids: [] } } : {}),
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "mep-trial-replay",
          requested_effect: "apply", effect_state: confirmed ? "none" : "unknown", effect_authority: confirmed ? "native_rollback" : "native_host",
          effect_reason: confirmed ? "verified_native_rollback" : "native_handler_returned_without_authoritative_settlement",
          request_dispatched: true, affected_target_identities: [] }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, "failed_after_dispatch");
    assert.equal(result.persistent_effect, confirmed ? "none" : "unknown");
    assert.equal(result.native_transaction_state, confirmed ? "rolled_back" : "unknown");
    assert.equal(result.error_code, "native_domain_operation_failed");
    assert.equal(result.observation_required, true);
    assert.deepEqual(result.affected_target_identities, []);
  }
});
import { completionOutboxKeyV2, readCompletionOutboxV2 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { revitRouteEffect } from "./revitRouteEffect.js";
import { nativeArtifactReceiptEffectV1, nativeArtifactResultEffectV2, operationInputSchemaGapErrorV2 } from "@revitoperator/assignment-kernel-v2-contracts";

test("queued native cancellation and started timeout retain distinct mutation authority", async () => {
  for (const started of [false, true]) {
    const route = "/revit/set-parameter", body = { changes: [{ elementId: 1365188, parameterName: "Mark", value: "TEST-AHU-01" }] };
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, {
        ok: false, code: started ? "revit_action_deadline_elapsed_outcome_unknown" : "revit_action_deadline_elapsed_before_dispatch",
        phase: started ? "revit_external_event" : "pre_dispatch", retryable: !started, outcome_unknown: started,
        request_dispatched: started, error: "Action deadline elapsed",
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
          effect_state: started ? "unknown" : "none", effect_authority: "native_host", request_dispatched: started }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, started ? "unknown" : "none");
    assert.equal(result.dispatch_state, started ? "dispatched" : "not_dispatched");
    assert.equal(result.status, started ? "failed_after_dispatch" : "failed_before_dispatch");
  }
});

test("parameter change inventory carries collateral identities beyond the requested edit", async () => {
  const route = "/revit/set-parameter", body = { changes: [{ elementId: 1365188, parameterName: "Mark", value: "TEST-AHU-01" }] };
  const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: route, body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "apply" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", route, {
      status: "Applied and Verified", changedElementIds: [1365188],
      transaction: { status: "committed", committed: true, modified_element_ids: [1365188, 49831], added_element_ids: [200],
        deleted_element_ids: [300], affected_element_ids: [200,300,49831,1365188] },
      changeTracking: { exhaustiveChangeInventory: true, matchingEventCount: 1, captureFailureCount: 0 },
      canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
        effect_state: "applied", effect_authority: "native_transaction", request_dispatched: true,
        affected_target_identities: ["element_id:200","element_id:300","element_id:49831","element_id:1365188"] }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.persistent_effect, "applied");
  for (const id of [200,300,49831,1365188]) assert.ok(result.affected_target_identities.includes(`element_id:${id}`));
  assert.equal(decorated.structuredContent.observation.raw_payload.changeTracking.exhaustiveChangeInventory, true);
});

test("drafting summary readback preserves native scale without inventing it for historical payloads", async () => {
  const replay = JSON.parse(readFileSync(new URL("../../../operator-backend/test/fixtures/drafting-view-summary-readback.json", import.meta.url), "utf8"));
  for (const payload of [replay.retained_read, replay.repaired_read]) {
    const body = { elementIds: [1542917] };
    const decorated = await runWithAssignmentKernelV2(meta("read", "verification", { method: "POST", path: "/revit/get-element-summary", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/get-element-summary", body, { classified_effect: "read" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/get-element-summary", {
        ...payload,
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "drafting-summary-read",
          requested_effect: "read", effect_state: "none", effect_authority: "native_host", request_dispatched: true }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
    assert.deepEqual(decorated.structuredContent.observation.raw_payload, payload);
  }
});

function pdfArtifactReceipt(phase: "apply" | "preview" = "apply") {
  return { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: "/revit/export-pdf", phase,
    status: phase === "apply" ? "complete" : "not_started", expected_output_paths: ["C:/fixture/M000.pdf"], expected_export_calls: 1,
    export_calls: phase === "apply" ? [true] : [],
    outputs: phase === "apply" ? [{ path: "C:/fixture/M000.pdf", size_bytes: 8251486, sha256: "a".repeat(64), fresh_output: true }] : [] };
}

test("native PDF and workbook exports and nonwriting plans retain artifact authority without inventing transactions", async () => {
  for (const route of ["/revit/export-pdf", "/revit/print", "/revit/export-elements-xlsx"]) for (const requested of ["apply", "preview"] as const) {
    const workbook = route === "/revit/export-elements-xlsx";
    const filePath = workbook ? "C:/fixture/rooms.xlsx" : "C:/fixture/M000.pdf";
    const receipt = pdfArtifactReceipt(requested), body = { ...(workbook ? { elementIds: [42], parameterNames: ["Area", "Number"], fileName: "rooms.xlsx" } : { viewIds: [1420963] }), dryRun: requested === "preview",
      ...(route === "/revit/print" ? { copies: 1, collate: true, printIndividually: false } : {}) };
    Object.assign(receipt, { path: route, ...(route === "/revit/print" ? { print_settings_restored: true } : {}) });
    receipt.expected_output_paths = [filePath];
    receipt.outputs = receipt.outputs.map(output => ({ ...output, path: filePath }));
    const decorated = await runWithAssignmentKernelV2(meta(requested, "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: requested });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, {
        status: requested === "apply" ? "Success" : "Dry Run", ok: true, dryRun: requested === "preview", artifact_receipt: receipt,
        warnings: route === "/revit/print" ? ["Collation is not applicable to a job with one view or one copy; the existing collation setting was left unchanged."] : [],
        selectedCount: 1, ...(workbook ? { path: filePath, selectedElementIds: [42], parameterNames: ["Area", "Number"], parameterCount: 2, requestedCount: 1, itemsComplete: true, issueCount: 0, sheets: ["Elements", "Issues", "Readme"] } : { selectedSheets: [{ viewId: 1420963, sheetNumber: "M000" }] }), preflight: { outputs: receipt.expected_output_paths },
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "export-native",
          requested_effect: requested, effect_state: requested === "apply" ? "applied" : "none", effect_authority: "native_receipt",
          effect_reason: requested === "apply" ? "native_artifact_export_completed" : "native_artifact_export_not_started",
          request_dispatched: true, affected_target_identities: requested === "apply" ? ["artifact_path:" + filePath] : [] }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, "succeeded"); assert.equal(result.native_transaction_state, "not_applicable");
    assert.equal(nativeArtifactResultEffectV2(result), requested === "apply" ? "applied" : "none");
    assert.deepEqual(result.native_artifact_receipt, receipt);
    assert.equal(decorated.structuredContent.observation.raw_payload.artifact_receipt.schema, receipt.schema);
    const facts = decorated.structuredContent.observation.semantic_facts;
    assert.ok(facts.some((fact: any) => fact.fact_id === "task.result_available" && fact.value === true));
    if (requested === "preview") {
      assert.ok(facts.some((fact: any) => fact.fact_id === "task.preview_valid" && fact.value === true));
      assert.ok(facts.some((fact: any) => fact.fact_id === "artifact.planned_output_count" && fact.value === 1));
    }
  }
});

test("interactive print preflight fails without a started effect or false completion evidence", async () => {
  for (const requested of ["apply", "preview"] as const) {
    const route = "/revit/print", body = { printerName: "Renamed PDF queue", dryRun: requested === "preview" };
    const receipt = { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: route, phase: requested,
      status: "not_started", print_settings_untouched: true, not_started_reason: "interactive_printer_destination",
      expected_output_paths: [], expected_export_calls: 0, export_calls: [], outputs: [] };
    const decorated = await runWithAssignmentKernelV2(meta(requested, "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: requested });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, {
        status: "PrintFailed", ok: false, dryRun: requested === "preview", printJobs: 0,
        preflight: { available: false, failureClass: "interactive_printer_destination", destinationPorts: "PORTPROMPT:" },
        artifact_receipt: receipt,
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: requested,
          effect_state: "none", effect_authority: "native_receipt", effect_reason: "native_artifact_export_not_started", request_dispatched: true }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, "failed_after_dispatch");
    assert.equal(result.persistent_effect, "none");
    assert.equal(result.native_transaction_state, "not_applicable");
    assert.equal(nativeArtifactResultEffectV2(result), "none");
    assert(!(decorated.structuredContent.observation?.semantic_facts ?? []).some((f: any) => f.fact_id === "task.result_available"));
  }
});

test("interactive print timeout remains unknown instead of becoming an untouched preflight", async () => {
  const route = "/revit/print", body = { printerName: "Microsoft Print to PDF", printToFile: true, dryRun: false };
  const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: route, body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "apply" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", route, {
      schema: "revit-operator.revit-bridge-failure.v1", ok: false, code: "revit_bridge_timeout", phase: "dispatch",
      retryable: false, request_dispatched: true, outcome_unknown: true, method: "POST", path: route,
      error: "POST /revit/print exceeded 120000 ms while waiting for the Revit bridge.",
      canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
        effect_state: "unknown", effect_authority: "native_host", request_dispatched: true }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "unknown");
  assert.equal(decorated.structuredContent.operation_result_v2.status, "failed_after_dispatch");
  assert(!(decorated.structuredContent.observation?.semantic_facts ?? []).some((f: any) => f.fact_id === "task.result_available"));
});

test("driver print PartialFailure and PrintFailed never become successful task evidence or erase unknown effects", async () => {
  for (const status of ["PartialFailure", "PrintFailed"]) {
    const body = { viewIds: [1420963], printToFile: true, printToFileName: "artifacts/prints/M000.pdf", dryRun: false };
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/print", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/print", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/print", {
        status, dryRun: false, selectedCount: 1, printerName: "Microsoft Print to PDF", printJobs: 1, failedCount: 1,
        results: [{ ok: false, viewId: 1420963, error: "InvalidOperationException: artifacts/prints/. Path does not exist." }],
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
          effect_state: "unknown", effect_authority: "native_host", request_dispatched: true }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    assert.equal(decorated.structuredContent.operation_result_v2.status, "failed_after_dispatch");
    assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "unknown");
    const facts = decorated.structuredContent.observation.semantic_facts;
    assert(facts.some((fact: any) => fact.fact_id === "control.domain_succeeded" && fact.value === false));
    assert(!facts.some((fact: any) => fact.fact_id === "task.result_available"));
  }
  const print = { ...pdfArtifactReceipt(), path: "/revit/print", print_settings_restored: true };
  assert.equal(nativeArtifactReceiptEffectV1(print, "POST", "/revit/print", "apply"), "applied");
  for (const restored of [undefined, false, "true"])
    assert.equal(nativeArtifactReceiptEffectV1({ ...print, print_settings_restored: restored }, "POST", "/revit/print", "apply"), null);
  assert.equal(nativeArtifactReceiptEffectV1(print, "POST", "/revit/export-pdf", "apply"), null);
});

test("driver print unaccepted staged or virtual output retains unknown effect even when settings restoration succeeds", async () => {
  for (const restored of [true, false]) for (const diagnostic of ["", " PrintToFile=False; expected path=C:/fixture/M000-singlecopy-check.pdf; actual path=C:/fixture/M000-singlecopy-check.pdf"]) {
    const body = { viewIds: [1420963], printToFile: true, copies: 1, collate: false, printIndividually: false,
      combinedFile: true, printToFileName: "C:/fixture/M000-singlecopy-check.pdf", dryRun: false };
    const receipt = { ...pdfArtifactReceipt(), path: "/revit/print", status: "unverified", print_settings_restored: restored,
      expected_output_paths: [body.printToFileName], export_calls: [],
      outputs: [{ path: body.printToFileName, size_bytes: 0, sha256: "", fresh_output: false, exists: false, readable: false }] };
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/print", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/print", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/print", {
        status: "PrintFailed", ok: false, dryRun: false, selectedCount: 1, selectedSheets: [{ viewId: 1420963, sheetNumber: "M000" }],
        printJobs: 1, failedCount: 1, artifact_receipt: receipt, print_settings_restored: restored,
        print_settings_restoration_errors: restored ? [] : ["Apply: failed"], path: body.printToFileName,
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
          effect_state: "unknown", effect_authority: "native_host", request_dispatched: true },
        warnings: ["Collation is not applicable to a job with one view or one copy; the existing collation setting was left unchanged.", "CopyNumber not applied: This property is not available."],
        results: [{ ok: false, viewId: 1420963, sheetNumber: "M000", error: "InvalidOperationException: Requested print-to-file settings were not accepted; no print was submitted." + diagnostic }]
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    assert.equal(decorated.structuredContent.operation_result_v2.status, "failed_after_dispatch");
    assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "unknown");
    assert(!(decorated.structuredContent.observation?.semantic_facts ?? []).some((fact: any) => fact.fact_id === "task.result_available"));
  }
});

test("PDF preview facts reject mismatched sheet scope or output plans while preserving no-write truth", async () => {
  for (const variant of ["missing_sheets", "wrong_sheet", "wrong_count", "wrong_output"] as const) {
    const receipt = pdfArtifactReceipt("preview"), body = { viewIds: [1420963], dryRun: true };
    const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: "/revit/export-pdf", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/export-pdf", body, { classified_effect: "preview" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/export-pdf", {
        status: "Dry Run", ok: true, dryRun: true, artifact_receipt: receipt,
        selectedCount: variant === "wrong_count" ? 2 : 1,
        selectedSheets: variant === "missing_sheets" ? [] : [{ viewId: variant === "wrong_sheet" ? 999 : 1420963 }],
        preflight: { outputs: variant === "wrong_output" ? ["C:/fixture/other.pdf"] : receipt.expected_output_paths },
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "export-native",
          requested_effect: "preview", effect_state: "none", effect_authority: "native_receipt",
          effect_reason: "native_artifact_export_not_started", request_dispatched: true }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, "failed_after_dispatch");
    assert.equal(result.persistent_effect, "none");
    assert.equal(result.native_transaction_state, "not_applicable");
    assert.equal(result.result_semantic_gap.reason_code, "preview_result_contract_invalid");
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((f: any) => f.fact_id === "task.preview_valid"), false);
  }
});

test("legacy successful-looking PDF export remains unknown and cannot fabricate a transaction", async () => {
  const body = { viewIds: [1420963], combine: true, outputFolder: "artifacts/prints", baseFileName: "M000", dryRun: false };
  const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/export-pdf", body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/export-pdf", body, { classified_effect: "apply" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/export-pdf", {
      status: "Success", files: ["M000.pdf"], verification: { ok: true, exists: true, sizeBytes: 8251486 },
      canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "export-native",
        requested_effect: "apply", effect_state: "unknown", effect_authority: "native_host",
        effect_reason: "native_handler_returned_without_authoritative_settlement", request_dispatched: true }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "unknown");
  assert.equal(decorated.structuredContent.operation_result_v2.native_transaction_state, "unknown");
  assert.equal(decorated.structuredContent.operation_result_v2.native_artifact_receipt, undefined);
});

test("artifact receipt validation rejects stale, partial, wrong-route and forged completion evidence", () => {
  const original = pdfArtifactReceipt();
  for (const change of [
    (r: any) => { r.export_calls = [false]; },
    (r: any) => { r.outputs[0].fresh_output = false; },
    (r: any) => { r.outputs[0].sha256 = "missing"; },
    (r: any) => { r.outputs[0].path = "C:/fixture/other.pdf"; },
    (r: any) => { r.outputs = []; },
    (r: any) => { r.expected_output_paths.push("C:/fixture/second.pdf"); },
    (r: any) => { r.expected_output_paths.push("c:/FIXTURE/m000.pdf"); },
    (r: any) => { r.phase = "preview"; },
    (r: any) => { r.status = "unverified"; },
    (r: any) => { r.path = "/revit/move-elements"; }
  ]) {
    const receipt = structuredClone(original); change(receipt);
    assert.equal(nativeArtifactReceiptEffectV1(receipt, "POST", "/revit/export-pdf", "apply"), null);
  }
  assert.equal(nativeArtifactReceiptEffectV1(original, "POST", "/revit/export-pdf", "preview"), null);
  assert.equal(nativeArtifactReceiptEffectV1(original, "GET", "/revit/export-pdf", "apply"), null);
  assert.equal(revitRouteEffect("/revit/inspect-exported-files", "POST", { paths: ["C:/fixture/M000.pdf"] }), "read");
});

import {
  ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
  ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
  ASSIGNMENT_KERNEL_V2_BINDING_META_KEY,
  ASSIGNMENT_KERNEL_V2_META_KEY,
  beginAssignmentKernelNativeRequestV2,
  currentAssignmentKernelTaskFulfillmentRoleV2,
  currentAssignmentKernelV2Binding,
  decorateAssignmentKernelMcpResultV2,
  markAssignmentKernelNativeRequestDispatchingV2,
  recordAssignmentKernelNativeResultV2,
  recordAssignmentKernelNativeFailureV2,
  runWithAssignmentKernelV2
} from "./assignmentKernelV2.js";

for (const effect of ["preview", "apply", "read"] as const) {
  for (const shape of ["direct", "bridgeDetails", "before_dispatch"] as const) {
    test(`native ${effect} timeout ${shape} preserves uncertain transaction outcome`, async () => {
      const route = effect === "read" ? "/revit/context" : "/revit/connect-existing-mep-branch";
      const method = effect === "read" ? "GET" : "POST";
      const body = effect === "read" ? undefined : { connectionMode: "air_terminal_on_duct", kind: "duct",
        mainElementId: 1542960, branchElementId: 1543055, branchConnectorId: 1,
        expectedBranchOriginXyz: [-33.01663333329998, 30.49999999999997, 41.18892769033334], dryRun: effect === "preview" };
      const details = { request_dispatched: shape !== "before_dispatch", outcome_unknown: shape !== "before_dispatch",
        phase: shape === "before_dispatch" ? "pre_dispatch" : "revit_external_event" };
      const error = { status: 408, code: "revit_action_deadline_elapsed_outcome_unknown",
        ...(shape === "bridgeDetails" ? { bridgeDetails: details } : details) };
      const decorated = await runWithAssignmentKernelV2(meta(effect, "work", { method, path: route, body }), async () => {
        const request = await beginAssignmentKernelNativeRequestV2(method, route, body, { classified_effect: effect });
        await markAssignmentKernelNativeRequestDispatchingV2(request);
        await recordAssignmentKernelNativeFailureV2(request, error);
        return decorateAssignmentKernelMcpResultV2({ isError: true, content: [] }, "revit_call_tool") as any;
      });
      const result = decorated.structuredContent.operation_result_v2;
      const unknown = effect !== "read" && shape !== "before_dispatch";
      assert.equal(result.status, shape === "before_dispatch" ? "failed_before_dispatch" : "failed_after_dispatch");
      assert.equal(result.persistent_effect, unknown ? "unknown" : "none");
      assert.equal(result.native_transaction_state, unknown ? "unknown" : "not_applicable");
      assert.equal(result.observation_required, false);
      assert.equal(decorated.structuredContent.observation, undefined);
    });
  }
}

for (const collation of [undefined, true, false]) test(`driver print conditional Collate ${collation} getter HTTP failure remains unknown without synthetic completion`, async () => {
  const body = { viewIds: [1420963], printToFile: true, dryRun: false,
    ...(collation === undefined ? {} : { copies: 1, collate: collation, printIndividually: false, combinedFile: true,
      printToFileName: "artifacts/prints/M000-collate-check.pdf", printerName: "Microsoft Print to PDF" }) };
  const error = { status: 500, request_dispatched: true, outcome_unknown: true, phase: "dispatch",
    message: "System.Reflection.TargetInvocationException: Collate is only available when there are more than 1 views and more than 1 copies." };
  const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/print", body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/print", body, { classified_effect: "apply" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeFailureV2(request, error);
    return decorateAssignmentKernelMcpResultV2({ isError: true, content: [{ type: "text", text: error.message }] }, "revit_call_tool") as any;
  });
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.status, "failed_after_dispatch");
  assert.equal(result.persistent_effect, "unknown");
  assert.equal(result.observation_required, false);
  assert(!(decorated.structuredContent.observation?.semantic_facts ?? []).some((fact: any) => fact.fact_id === "task.result_available"));
});

const binding = {
  assignment_id: "assignment-1",
  run_id: "run-1",
  generation: 1,
  session_id: "session-1",
  principal_id: "principal-1",
  document_fingerprint: "document-1"
};

function payloadRegressionFixture(name: string): any {
  const relative = path.join("contracts", "assignment-kernel-v2", "payload-digest", name);
  const candidates = [
    path.resolve(process.cwd(), "..", "..", relative),
    path.resolve(process.cwd(), "..", relative)
  ];
  const fixturePath = candidates.find(candidate => existsSync(candidate));
  assert.ok(fixturePath, `Missing payload regression fixture ${name}`);
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function meta(
  effect: "read" | "preview" | "apply" = "read",
  purpose = "work",
  nativeRequest?: { method: "GET" | "POST"; path: string; body?: unknown }
) {
  const fulfillmentRole = purpose === "verification" ? "verification"
    : purpose === "reconciliation" ? "reconciliation"
      : purpose === "discovery" || purpose === "evidence_read" ? "supporting_control"
        : "delegated_task_execution";
  const capabilityId = nativeRequest ? "revit_call_tool" : "inventory.read";
  return {
    [ASSIGNMENT_KERNEL_V2_META_KEY]: {
      schema: ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
      assignment_id: binding.assignment_id,
      binding,
      operation_id: "operation-1",
      capability_id: capabilityId,
      requested_effect: effect,
      purpose,
      operation_role: "root",
      fulfillment_role: fulfillmentRole,
      ...(fulfillmentRole === "delegated_task_execution" || fulfillmentRole === "verification"
        ? { delegation_authority_id: "delegation:operation-1" }
        : {}),
      eligible_criterion_ids: fulfillmentRole === "delegated_task_execution" || fulfillmentRole === "verification"
        ? ["criterion-inventory"]
        : [],
      root_operation_id: "operation-1",
      blocks_parent_settlement: false,
      request_identity: {
        capability_id: capabilityId,
        ...(nativeRequest ? { method: nativeRequest.method, path: nativeRequest.path } : {}),
        request_signature: nativeRequest
          ? payloadDigestV2({
              capability_id: capabilityId,
              method: nativeRequest.method,
              path: nativeRequest.path,
              body: nativeRequest.body ?? null
            }).digest
          : "inventory-read-request"
      },
      opened_at: "2026-08-26T15:00:00.000Z",
      deadline_at: "2026-08-26T15:04:00.000Z"
    }
  };
}

test("C54 native sheet query supplies complete collection evidence without promoting control or partial pages", async () => {
  const fixture=JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/c54-sheet-read-failure.json',import.meta.url),'utf8'));
  for(const variant of ["count","empty","list","partial","tail","wrong_filter","wrong_alias","wrong_request","control","metadata"] as const) {
    const route=variant==="metadata"?"/revit/context":"/revit/sheets";
    const body={...fixture.request};
    const payload={...structuredClone(fixture.response)};
    if(variant==="empty")Object.assign(payload,{totalSheets:40,totalMatches:0,total:0});
    if(["list","partial","tail"].includes(variant)) {
      body.action="list";
      Object.assign(payload,{action:"list",countOnly:false,returned:2,total:2,totalMatches:2,limit:500,
        items:[{id:1,sheetNumber:"M101",name:"HVAC L1"},{id:2,sheetNumber:"M102",name:"HVAC L2"}],
        paging:{offset:0,limit:500,returned:2,hasMore:false,nextOffset:null}});
      if(variant==="partial")Object.assign(payload,{total:17,totalMatches:17,hasMore:true,nextOffset:2,paging:{...payload.paging,hasMore:true,nextOffset:2}});
      if(variant==="tail")Object.assign(payload,{offset:15,total:17,totalMatches:17,paging:{...payload.paging,offset:15}});
    }
    if(variant==="wrong_filter")payload.sheetNumberPrefix="A";
    if(variant==="wrong_alias")payload.total=18;
    if(variant==="wrong_request")body.action="detail";
    const decorated=await runWithAssignmentKernelV2(meta("read",variant==="control"?"discovery":"work",{method:"POST",path:route,body}),async()=>{
      const request=await beginAssignmentKernelNativeRequestV2("POST",route,body,{classified_effect:"read"});
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST",route,{
        ...(variant==="metadata"?{document:{title:"Mechanical Controls",projectNumber:"123-M"}}:payload),
        canonical_attempt_settlement:{schema:"revit-operator.native-attempt-settlement.v1",attempt_id:`c54-${variant}`,
          requested_effect:"read",effect_state:"none",effect_authority:"native_host",request_dispatched:true}
      },request);
      return decorateAssignmentKernelMcpResultV2({content:[]},"revit_call_tool") as any;
    });
    const facts=decorated.structuredContent.observation.semantic_facts;
    const complete=facts.find((fact:any)=>fact.fact_id==="collection.complete")?.value===true;
    assert.equal(complete,["count","empty","list"].includes(variant),variant);
    if(complete) assert.equal(facts.find((fact:any)=>fact.fact_id==="collection.total")?.value,payload.totalMatches);
    if(variant==="metadata" || variant==="control")assert.equal(facts.some((fact:any)=>fact.fact_id==="model.content_observed"),false,variant);
  }
});

test("quantify result is normalized once into an explicit task-result Observation and inventory facts", async () => {
  const decorated = await runWithAssignmentKernelV2(meta("read", "work", { method: "POST", path: "/revit/quantify" }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/quantify");
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/quantify", {
      totalCount: 2,
      items: [
        { familyName: "Supply Diffuser", typeName: "24x24" },
        { family_name: "Supply Diffuser", type_name: "24x24" }
      ],
      canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1",
        attempt_id: "native-attempt-1",
        requested_effect: "read",
        effect_state: "none",
        effect_authority: "native_receipt",
        request_dispatched: true
      }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: "bounded model projection" }] }, "inventory.read") as any;
  });
  assert.equal(decorated.structuredContent.schema, ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA);
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "native-host");
  assert.equal(decorated.structuredContent.observation.evidence_class, "task_result");
  assert.ok(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "inventory.complete" && fact.value === true));
  assert.ok(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "inventory.total" && fact.value === 2));
  assert.ok(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "inventory.group" && fact.value === 2));
});

test("native affected target identities survive the MCP OperationResultV2 boundary", async () => {
  const decorated = await runWithAssignmentKernelV2(
    meta("apply", "work", { method: "POST", path: "/revit/create-text-note", body: { text: "Created" } }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/create-text-note", { text: "Created" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/create-text-note", {
        ok: true,
        createdElementId: 4242,
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "native-create-4242",
          requested_effect: "apply",
          effect_state: "applied",
          effect_authority: "native_transaction",
          request_dispatched: true,
          affected_target_identities: ["element_id:4242", "element_id:4242"]
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    }
  );
  assert.deepEqual(
    decorated.structuredContent.operation_result_v2.affected_target_identities,
    ["element_id:4242"]
  );
});

test("duplicated view settlement carries native created identities without promoting the source view", async () => {
  const body = { viewId: 1363433, newName: "M-COORDINATION COPY", withDetailing: true };
  const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/duplicate-view", body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/duplicate-view", body);
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/duplicate-view", {
      success: true, viewId: 1542917, sourceViewId: 1363433, name: "M-COORDINATION COPY", withDetailing: true,
      canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "native-duplicate-L4",
        requested_effect: "apply", effect_state: "applied", effect_authority: "native_transaction", request_dispatched: true,
        affected_target_identities: ["element_id:1542917", "element_id:1542918"]
      }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  assert.deepEqual(decorated.structuredContent.operation_result_v2.affected_target_identities, ["element_id:1542917", "element_id:1542918"]);
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "applied");
});

test("sheet duplication keeps the exact legacy uncertainty and committed or rolled-back neighbors", async () => {
  for (const [effect, authority, reason, success] of [
    ["unknown", "native_host", "native_handler_returned_without_authoritative_settlement", true],
    ["applied", "native_transaction", "native_transaction_committed", true],
    ["applied", "native_transaction", "native_transaction_committed", false],
    ["none", "native_rollback", "verified_native_rollback", false]
  ] as const) {
    const body = { sourceSheetId: 1420963, sourceSheetNumber: "M000", sourceQuery: "M000", option: "views_and_detailing",
      newNumber: "TEMP-M000", newName: "Cover Sheet - Working Copy", dryRun: false, verify: true };
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/duplicate-sheet", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/duplicate-sheet", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/duplicate-sheet", {
        ok: success, ...(effect === "unknown" ? {} : { success }), dryRun: false, applied: effect === "none" ? false : true, verified: success,
        ...(success ? { plan: { sourceSheetId: 1420963, sourceSheetNumber: "M000", option: "views_and_detailing", newNumber: "TEMP-M000" },
          sheet: { id: 1542977, number: "TEMP-M000", name: "COVER SHEET - WORKING COPY", viewportCount: 2, scheduleCount: 1 } }
          : { error: effect === "applied" ? "Sheet readback unavailable" : "Sheet number already exists" }),
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "native-sheet-copy",
          requested_effect: "apply", effect_state: effect, effect_authority: authority, effect_reason: reason, request_dispatched: true,
          affected_target_identities: effect === "applied" ? ["element_id:1542977", "element_id:1542978"] : [] }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, effect);
    assert.equal(result.native_transaction_state, effect === "applied" ? "committed" : effect === "none" ? "rolled_back" : "unknown");
    assert.deepEqual(result.affected_target_identities ?? [], effect === "applied" ? ["element_id:1542977", "element_id:1542978"] : []);
    if (!success) assert.equal(result.status, "failed_after_dispatch");
  }
});

test("malformed native affected target identities fail closed before settlement publication", async () => {
  await assert.rejects(
    () => runWithAssignmentKernelV2(
      meta("apply", "work", { method: "POST", path: "/revit/create-text-note", body: { text: "Created" } }),
      async () => {
        const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/create-text-note", { text: "Created" });
        await markAssignmentKernelNativeRequestDispatchingV2(request);
        await recordAssignmentKernelNativeResultV2("POST", "/revit/create-text-note", {
          ok: true,
          canonical_attempt_settlement: {
            schema: "revit-operator.native-attempt-settlement.v1",
            attempt_id: "native-create-malformed-target",
            requested_effect: "apply",
            effect_state: "applied",
            effect_authority: "native_transaction",
            request_dispatched: true,
            affected_target_identities: [4242]
          }
        }, request);
        return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
      }
    ),
    /assignment_kernel_v2_native_affected_targets_invalid/
  );
});

test("drafting view legacy success stays unknown while committed identity survives failed readback", async () => {
  for (const effect of ["unknown", "applied"] as const) {
    const body = { name: "OPERATOR HANDOFF CHECK", allowExisting: false };
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/create-drafting-view", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/create-drafting-view", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/create-drafting-view", {
        ...(effect === "unknown" ? { status: "Success", viewId: 1543005, name: "OPERATOR HANDOFF CHECK", created: true }
          : { success: false, applied: true, verified: false, error: "Committed drafting view readback failed" }),
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "native-drafting",
          requested_effect: "apply", effect_state: effect,
          effect_authority: effect === "unknown" ? "native_host" : "native_transaction",
          effect_reason: effect === "unknown" ? "native_handler_returned_without_authoritative_settlement" : "native_transaction_committed",
          request_dispatched: true, affected_target_identities: effect === "applied" ? ["element_id:1543005"] : []
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, effect);
    assert.deepEqual(result.affected_target_identities ?? [], effect === "applied" ? ["element_id:1543005"] : []);
    if (effect === "applied") assert.equal(result.status, "failed_after_dispatch");
  }
});

test("plan-only view response cannot manufacture native rollback or preview completion", async () => {
  for (const [effect, authority, reason, state] of [
    ["none", "native_transaction", "native_transaction_not_started", "not_started"],
    ["unknown", "native_host", "native_handler_returned_without_authoritative_settlement", "unknown"],
    ["none", "native_receipt", "no_effect_reported", "not_applicable"]
  ] as const) {
    const body = { action: "create_floor_plan", name: "M-LEVEL 2 COORDINATION", levelName: "Level 2", dryRun: true };
    const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: "/revit/create-view", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/create-view", body, { classified_effect: "preview" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/create-view", {
        status: "Dry Run", dryRun: true, plan: { name: body.name }, previewExecuted: false,
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "view-plan-only",
          requested_effect: "preview", effect_state: effect, effect_authority: authority, effect_reason: reason, request_dispatched: true }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, "failed_after_dispatch");
    assert.equal(result.native_transaction_state, state);
    assert.equal(result.persistent_effect, effect);
    assert.equal(result.error_code, "native_preview_execution_unproven");
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((f: any) => f.fact_id === "task.preview_valid" && f.value === true), false);
  }
});

test("retained C105 native stage receipt settles a real rollback preview in Assignment V2", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../src/lib/fixtures/c105-registered-stage-preview.json", import.meta.url), "utf8"));
  const route = "/revit/existing-conditions-mep-draft-workflow", body = fixture.request;
  const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: route, body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "preview" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", route, {
      ...fixture.payload, canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "preview",
        effect_state: "none", effect_authority: "native_rollback",
        effect_reason: "verified_native_rollback", request_dispatched: true,
        affected_target_identities: []
      }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.status, "succeeded");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.native_transaction_state, "rolled_back");
  assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) =>
    fact.fact_id === "task.preview_valid" && fact.value === true), true);
});

test("C109 blocked registered route remains a failed no-effect attempt without preview credit", async () => {
  const payload = JSON.parse(readFileSync(new URL("../../src/lib/fixtures/c109-registered-stage-blocked-rollback.json", import.meta.url), "utf8"));
  const route = "/revit/existing-conditions-mep-draft-workflow";
  const body = { stageKey: payload.stageKey, inputFingerprintSha256: payload.inputFingerprintSha256,
    dryRun: true, operations: [{ action_key: payload.failedOperation.actionKey, path: "/revit/create-mep-route" }] };
  const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: route, body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "preview" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", route, {
      ...payload, canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "preview",
        effect_state: "none", effect_authority: "native_rollback",
        effect_reason: "verified_native_rollback", request_dispatched: true,
        affected_target_identities: []
      }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.status, "failed_after_dispatch");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.native_transaction_state, "rolled_back");
  assert.equal(result.error_code, "native_domain_operation_failed");
  assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) =>
    fact.fact_id === "task.preview_valid" && fact.value === true), false);
});

test("C138 blocked interior tee is a failed no-effect preview and can be replanned", async () => {
  const payload = JSON.parse(readFileSync(new URL("../../src/lib/fixtures/c138-registered-branch-blocked-rollback.json", import.meta.url), "utf8"));
  const route = "/revit/existing-conditions-mep-draft-workflow";
  const body = { stageKey: payload.stageKey, inputFingerprintSha256: payload.inputFingerprintSha256,
    dryRun: true, operations: [{ action_key: payload.failedOperation.actionKey, path: "/revit/connect-mep-branch" }] };
  const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: route, body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "preview" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", route, {
      ...payload, canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "preview",
        effect_state: "none", effect_authority: "native_rollback",
        effect_reason: "verified_native_rollback", request_dispatched: true,
        affected_target_identities: []
      }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.status, "failed_after_dispatch");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.native_transaction_state, "rolled_back");
  assert.equal(result.error_code, "native_domain_operation_failed");
  assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) =>
    fact.fact_id === "task.preview_valid" && fact.value === true), false);
});

test("C115 registered route type preflight is no-effect and permits correction without preview credit", async () => {
  const payload = JSON.parse(readFileSync(new URL("../../src/lib/fixtures/c114-registered-stage-preflight-not-started.json", import.meta.url), "utf8"));
  const route = "/revit/existing-conditions-mep-draft-workflow";
  const body = { stageKey: payload.stageKey, inputFingerprintSha256: payload.inputFingerprintSha256,
    dryRun: true, operations: [{ action_key: payload.failedOperation.actionKey, path: "/revit/create-mep-route" }] };
  const decorated = await runWithAssignmentKernelV2(meta("preview", "work", { method: "POST", path: route, body }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "preview" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", route, {
      ...payload, canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "preview",
        effect_state: "none", effect_authority: "native_transaction",
        effect_reason: "native_transaction_not_started", request_dispatched: true,
        affected_target_identities: []
      }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.status, "failed_after_dispatch");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.native_transaction_state, "not_started");
  assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) =>
    fact.fact_id === "task.preview_valid" && fact.value === true), false);
});

test("schedule-cell no-match preflight retains no effect without claiming an executed preview", async () => {
  const body = { scheduleId: 1488968, rowKey: "HRU202", rowField: "Mark",
    targetField: "Supply Air Pressure Drop", value: "0.10 in. w.g.", apply: false, dryRun: true };
  const decorated = await runWithAssignmentKernelV2(meta("preview", "work", {
    method: "POST", path: "/revit/update-schedule-cell", body
  }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/update-schedule-cell", body, { classified_effect: "preview" });
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/update-schedule-cell", {
      status: "Not Found", applied: false, candidateCount: 0,
      blockedReason: "No unique editable schedule-backed cell matched the requested row and field.",
      transaction: { status: "not_started", affectedElementIds: [] },
      canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1",
        attempt_id: "schedule-no-match", requested_effect: "preview", effect_state: "none",
        effect_authority: "native_transaction", effect_reason: "native_transaction_not_started",
        request_dispatched: true }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  });
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.status, "failed_after_dispatch");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.native_transaction_state, "not_started");
  assert.equal(result.error_code, "native_domain_operation_failed");
  assert.equal(decorated.structuredContent.observation.semantic_facts.some((f: any) =>
    f.fact_id === "task.preview_valid" && f.value === true), false);
});

test("configure-schedule apply needs confirmed native commit to settle persistence", async () => {
  const body = { scheduleId: 1488968, addFields: ["Supply Air Pressure Drop"], dryRun: false };
  for (const confirmed of [false, true]) {
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", {
      method: "POST", path: "/revit/configure-schedule", body
    }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/configure-schedule", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/configure-schedule", {
        status: "Success", dryRun: false, schedule: { id: 1488968, name: "Equipment Schedule" },
        ...(confirmed ? { transaction: { status: "committed", committed: true, modified_element_ids: [1488968], affected_element_ids: [1488968] } } : {}),
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1", attempt_id: `configure-${confirmed}`,
          requested_effect: "apply", effect_state: confirmed ? "applied" : "unknown",
          effect_authority: confirmed ? "native_transaction" : "native_host",
          effect_reason: confirmed ? "native_transaction_committed" : "native_handler_returned_without_authoritative_settlement",
          request_dispatched: true, affected_target_identities: confirmed ? ["element_id:1488968"] : []
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, confirmed ? "applied" : "unknown");
    assert.equal(result.native_transaction_state, confirmed ? "committed" : "unknown");
    assert.deepEqual(result.affected_target_identities ?? [], confirmed ? ["element_id:1488968"] : []);
  }
});

test("Candidate 39 explicit native domain failure is retained without becoming task-completion evidence", async () => {
  const body = {
    elementId: 1421361,
    expectedOldText: "***An Autodesk Revit sample project***",
    newText: "Issued for Construction",
    dryRun: true,
    apply: false
  };
  const decorated = await runWithAssignmentKernelV2(
    meta("preview", "work", { method: "POST", path: "/revit/replace-text-note", body }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/replace-text-note", body);
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/replace-text-note", {
        ok: false,
        status: "Precondition Failed",
        errorCode: "expected_old_text_mismatch",
        actualText: "***An Autodesk Revit sample project***\r",
        expectedOldText: "***An Autodesk Revit sample project***",
        changed: false,
        dryRun: true,
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "candidate39-preview-attempt",
          requested_effect: "preview",
          effect_state: "none",
          effect_authority: "native_receipt",
          request_dispatched: true
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    }
  );

  const result = decorated.structuredContent.operation_result_v2;
  const facts = decorated.structuredContent.observation.semantic_facts;
  assert.equal(result.status, "failed_after_dispatch");
  assert.equal(result.dispatch_state, "dispatched");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.native_transaction_state, "not_applicable");
  assert.equal(result.observation_required, true);
  assert.equal(result.error_code, "expected_old_text_mismatch");
  assert.ok(facts.some((fact: any) => fact.fact_id === "control.domain_succeeded" && fact.value === false));
  assert.equal(facts.some((fact: any) => fact.fact_id === "task.result_available"), false);
  assert.equal(facts.some((fact: any) => fact.fact_id === "task.preview_valid"), false);
});

test("Candidate 48 shared classification lets an authoritative native preview claim its exact parent", async () => {
  const body = {
    elementId: 1421361,
    expectedOldText: "***An Autodesk Revit sample project***\r",
    newText: "Issued for Construction",
    dryRun: true,
    apply: false
  };
  const decorated = await runWithAssignmentKernelV2(
    meta("preview", "work", { method: "POST", path: "/revit/replace-text-note", body }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/replace-text-note", body, {
        classified_effect: revitRouteEffect("/revit/replace-text-note", "POST", body)
      });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/replace-text-note", {
        ok: true,
        status: "OK",
        dryRun: true,
        textNoteId: 1421361,
        before: "***An Autodesk Revit sample project***\r",
        after: "***An Autodesk Revit sample project***\r",
        proposedText: "Issued for Construction",
        changed: true,
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "successful-preview-attempt",
          requested_effect: "preview",
          effect_state: "none",
          effect_authority: "native_rollback",
          effect_reason: "verified_native_rollback",
          request_dispatched: true
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    }
  );

  const result = decorated.structuredContent.operation_result_v2;
  const facts = decorated.structuredContent.observation.semantic_facts;
  assert.equal(result.status, "succeeded");
  assert.equal(result.dispatch_state, "dispatched");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.native_transaction_state, "rolled_back");
  assert.ok(facts.some((fact: any) => fact.fact_id === "task.preview_valid" && fact.value === true));
  assert.ok(facts.some((fact: any) => fact.fact_id === "text_note.element_id" && fact.value === 1421361));
  assert.ok(facts.some((fact: any) => fact.fact_id === "text_note.before" && fact.value === "***An Autodesk Revit sample project***\r"));
  assert.ok(facts.some((fact: any) => fact.fact_id === "text_note.after" && fact.value === "***An Autodesk Revit sample project***\r"));
  assert.ok(facts.some((fact: any) => fact.fact_id === "text_note.proposed" && fact.value === "Issued for Construction"));
  assert.ok(facts.some((fact: any) => fact.fact_id === "text_note.changed" && fact.value === true));
});

test("Candidate 56 rolled-back preview without native proposal proof cannot satisfy the preview criterion", async () => {
  const requestedText = "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX";
  const before = "***An Autodesk Revit sample project***\r";
  const body = {
    elementId: 1421361,
    expectedOldText: before,
    newText: requestedText,
    dryRun: true,
    apply: false
  };
  const decorated = await runWithAssignmentKernelV2(
    meta("preview", "work", { method: "POST", path: "/revit/replace-text-note", body }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/replace-text-note", body, {
        classified_effect: revitRouteEffect("/revit/replace-text-note", "POST", body)
      });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/replace-text-note", {
        ok: true,
        status: "Dry Run",
        dryRun: true,
        textNoteId: 1421361,
        before,
        after: before,
        text: before,
        normalizedText: "***An Autodesk Revit sample project***\n",
        changed: true,
        transaction: {
          status: "rolled_back",
          committed: false,
          modified_element_ids: [],
          affected_element_ids: [1421361]
        },
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "candidate56-preview-attempt",
          requested_effect: "preview",
          effect_state: "none",
          effect_authority: "native_rollback",
          effect_reason: "verified_native_rollback",
          request_dispatched: true
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    }
  );

  const result = decorated.structuredContent.operation_result_v2;
  const facts = decorated.structuredContent.observation.semantic_facts;
  assert.equal(result.status, "failed_after_dispatch");
  assert.equal(result.error_code, "preview_result_contract_invalid");
  assert.equal(result.result_semantic_gap?.native_replay_allowed, false);
  assert.equal(facts.some((fact: any) => fact.fact_id === "task.result_available"), false);
  assert.ok(facts.some((fact: any) => fact.fact_id === "text_note.after" && fact.value === before));
  assert.equal(facts.some((fact: any) => fact.fact_id === "text_note.proposed"), false);
  assert.equal(facts.some((fact: any) => fact.fact_id === "task.preview_valid"), false);
});

test("text-note preview admits only an explicit native proposal matching the admitted request", async () => {
  const requestedText = "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX";
  const before = "***An Autodesk Revit sample project***\r";
  const body = {
    elementId: 1421361,
    expectedOldText: before,
    newText: requestedText,
    dryRun: true,
    apply: false
  };
  const decorated = await runWithAssignmentKernelV2(
    meta("preview", "work", { method: "POST", path: "/revit/replace-text-note", body }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/replace-text-note", body, {
        classified_effect: revitRouteEffect("/revit/replace-text-note", "POST", body)
      });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/replace-text-note", {
        ok: true,
        status: "Dry Run",
        dryRun: true,
        textNoteId: 1421361,
        before,
        after: before,
        proposedText: requestedText,
        changed: true,
        transaction: {
          status: "rolled_back",
          committed: false,
          modified_element_ids: [],
          affected_element_ids: [1421361]
        },
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "proposal-bound-preview-attempt",
          requested_effect: "preview",
          effect_state: "none",
          effect_authority: "native_rollback",
          effect_reason: "verified_native_rollback",
          request_dispatched: true
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    }
  );

  const facts = decorated.structuredContent.observation.semantic_facts;
  assert.equal(decorated.structuredContent.operation_result_v2.status, "succeeded");
  assert.equal(decorated.structuredContent.operation_result_v2.result_semantic_gap, undefined);
  assert.ok(facts.some((fact: any) => fact.fact_id === "text_note.proposed" && fact.value === requestedText));
  assert.ok(facts.some((fact: any) => fact.fact_id === "task.preview_valid" && fact.value === true));
});

test("Candidate 40 action-specific read cannot claim a preview parent or emit task preview evidence", async () => {
  const body = {
    action: "inspect",
    textNoteId: 1421361,
    text: "",
    typeName: "",
    newTypeName: "",
    baseTypeName: "",
    fontName: "",
    dryRun: true
  };
  const settled: any[] = [];
  let admission: any = null;
  const edge = {
    async openChild(input: any) {
      admission = structuredClone(input);
      return {
        ...meta("read", "work")[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: "candidate40-inspection-child",
        capability_id: input.capability_id,
        requested_effect: input.classified_effect,
        purpose: "work",
        operation_role: "child",
        fulfillment_role: input.fulfillment_role,
        eligible_criterion_ids: input.eligible_criterion_ids,
        parent_operation_id: "operation-1",
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: "candidate40-inspection-child-signature"
        }
      } as any;
    },
    async markDispatch() {},
    async settle(lease: any, result: any) {
      settled.push({ lease, result });
      return { settled: true };
    }
  };

  const decorated = await runWithAssignmentKernelV2(
    meta("preview", "work", { method: "POST", path: "/revit/create-text", body }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/create-text", body, {
        classified_effect: "read",
        fulfillment_role: currentAssignmentKernelTaskFulfillmentRoleV2()
      });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/create-text", {
        ok: true,
        action: "inspect",
        textNoteId: 1421361,
        text: "***An Autodesk Revit sample project***\r",
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "candidate40-inspection-attempt",
          requested_effect: "read",
          effect_state: "none",
          effect_authority: "native_receipt",
          request_dispatched: true
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    },
    edge
  );

  assert.equal(admission.classified_effect, "read");
  assert.equal(admission.fulfillment_role, "supporting_control");
  assert.deepEqual(admission.eligible_criterion_ids, []);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].lease.operation_id, "candidate40-inspection-child");
  assert.equal(settled[0].result.structuredContent.observation.evidence_class, "control");
  assert.equal(settled[0].result.structuredContent.observation.semantic_facts.some(
    (fact: any) => fact.fact_id === "task.preview_valid"
  ), false);
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.operation_result_v2.status, "completed_without_native_dispatch");
  assert.equal(decorated.structuredContent.observation, undefined);
});

test("count-only quantify summary is sufficient task evidence without rows or another Revit call", async () => {
  const body = {
    categories: ["OST_DuctTerminal"],
    group_by: ["family", "type"],
    intent: "count",
    scope: "host"
  };
  const decorated = await runWithAssignmentKernelV2(
    meta("read", "work", { method: "POST", path: "/revit/quantify", body }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/quantify", body);
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/quantify", {
        summary: {
          total: 509,
          groups: {
            "Supply Diffuser | 24x24": 371,
            "Return Grille | 16x4": 138
          }
        },
        rows: [],
        resultSetId: "count-only-result",
        warnings: [],
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "native-count-only-attempt",
          requested_effect: "read",
          effect_state: "none",
          effect_authority: "native_receipt",
          request_dispatched: true
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
    }
  );

  const facts = decorated.structuredContent.observation.semantic_facts;
  assert.ok(facts.some((fact: any) => fact.fact_id === "inventory.complete" && fact.value === true));
  assert.ok(facts.some((fact: any) => fact.fact_id === "inventory.total" && fact.value === 509));
  assert.deepEqual(
    facts.filter((fact: any) => fact.fact_id === "inventory.group"),
    [
      {
        fact_id: "inventory.group",
        fact_class: "domain",
        value: 138,
        dimensions: { family: "Return Grille", type: "16x4" }
      },
      {
        fact_id: "inventory.group",
        fact_class: "domain",
        value: 371,
        dimensions: { family: "Supply Diffuser", type: "24x24" }
      }
    ]
  );
});

test("quantify summary groups remain single-counted when list rows are also present", async () => {
  const body = {
    categories: ["OST_DuctTerminal"],
    group_by: ["family", "type"],
    intent: "count_and_list",
    scope: "host"
  };
  const decorated = await runWithAssignmentKernelV2(
    meta("read", "work", { method: "POST", path: "/revit/quantify", body }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/quantify", body);
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/quantify", {
        summary: { total: 2, groups: { "Supply Diffuser | 24x24": 2 } },
        rows: [
          { family: "Supply Diffuser", type: "24x24" },
          { family: "Supply Diffuser", type: "24x24" }
        ],
        resultSetId: "count-and-list-result",
        warnings: [],
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "native-count-and-list-attempt",
          requested_effect: "read",
          effect_state: "none",
          effect_authority: "native_receipt",
          request_dispatched: true
        }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
    }
  );

  assert.deepEqual(
    decorated.structuredContent.observation.semantic_facts.filter((fact: any) => fact.fact_id === "inventory.group"),
    [{
      fact_id: "inventory.group",
      fact_class: "domain",
      value: 2,
      dimensions: { family: "Supply Diffuser", type: "24x24" }
    }]
  );
});

test("Candidate 2 tool-registry payload uses the cross-process ordinal digest", async () => {
  const fixture = payloadRegressionFixture("candidate2-tool-registry-sanitized.json");
  const decorated = await runWithAssignmentKernelV2(
    meta("read", "discovery", { method: "GET", path: "/revit/tool-registry" }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("GET", "/revit/tool-registry");
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("GET", "/revit/tool-registry", fixture.payload, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
    }
  ) as any;
  assert.equal(
    decorated.structuredContent.operation_result_v2.raw_payload_hash,
    "a7c639107bc169b5077712e82bd0c2f9886c3d8bde34c7599dff966097e12f40"
  );
  const { canonical_attempt_settlement: _control, ...expectedObservationPayload } = fixture.payload;
  assert.deepEqual(decorated.structuredContent.observation.raw_payload, expectedObservationPayload);
  assert.equal(decorated.structuredContent.operation_result_v2.payload_provenance.source.representation, "utf8_json_bytes");
  assert.equal(decorated.structuredContent.operation_result_v2.payload_provenance.normalized.representation, "canonical_json");
  assert.equal(
    decorated.structuredContent.operation_result_v2.payload_provenance.transformation_id,
    "revit-operator.native-result-control-extraction"
  );
});

test("source field spelling aliases normalize to identical semantic fact identities", async () => {
  async function facts(payload: unknown) {
    return await runWithAssignmentKernelV2(meta("read", "work", { method: "POST", path: "/revit/quantify" }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/quantify");
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/quantify", {
        ...(payload as object),
        canonical_attempt_settlement: { attempt_id: "receipt", requested_effect: "read", effect_state: "none", request_dispatched: true }
      }, request);
      return (decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any).structuredContent.observation.semantic_facts;
    });
  }
  const camel = await facts({ totalCount: 1, items: [{ familyName: "A", typeName: "B" }] });
  const snake = await facts({ total_count: 1, items: [{ family_name: "A", type_name: "B" }] });
  const select = (rows: any[]) => rows.filter(row => row.fact_id === "inventory.total" || row.fact_id === "inventory.group");
  assert.deepEqual(select(camel), select(snake));
});

test("pre-dispatch schema rejection becomes a structured no-effect correction gap", async () => {
  const context = meta("read", "work");
  const operationContext = context[ASSIGNMENT_KERNEL_V2_META_KEY];
  const decorated = await runWithAssignmentKernelV2({
    [ASSIGNMENT_KERNEL_V2_META_KEY]: {
      ...operationContext,
      capability_id: "revit_call_tool",
      request_identity: {
        capability_id: "revit_call_tool",
        method: "POST",
        path: "/revit/quantify",
        request_signature: "invalid-scalar-array"
      }
    }
  }, async () => decorateAssignmentKernelMcpResultV2({
    isError: true,
    structuredContent: {
      schema: "revit-operator.mcp-pre-dispatch-failure.v1",
      ok: false,
      code: "mcp_request_validation_failed",
      phase: "request_validation",
      retryable: true,
      request_dispatched: false,
      outcome_unknown: false,
      method: "POST",
      path: "/revit/quantify",
      input_schema_id: "operator-native/POST:/revit/quantify/input/v1",
      input_schema_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      invalid_fields: ["body.categories"],
      validation_issues: [{
        field_path: "body.categories",
        expected_type: "array",
        actual_type: "string",
        safe_correction_eligibility: "provider_corrected_arguments_required",
        correction_action: "provider_resubmit",
        expected_constraint: { kind: "json_type", type: "array" }
      }],
      error: "body.categories must be of type array"
    },
    content: []
  }, "revit_call_tool") as any);
  const result = (decorated as any).structuredContent.operation_result_v2;
  assert.equal(result.status, "failed_before_dispatch");
  assert.equal(result.dispatch_state, "not_dispatched");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.observation_required, false);
  assert.deepEqual(result.input_schema_gap, {
    schema: "revit-operator.operation-input-schema-gap/v2",
    gap_id: "input-schema:operation-1",
    operation_id: "operation-1",
    capability_id: "revit_call_tool",
    input_schema_id: "operator-native/POST:/revit/quantify/input/v1",
    input_schema_digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    method: "POST",
    path: "/revit/quantify",
    request_signature: "invalid-scalar-array",
    dispatch: false,
    effect: "none",
    issues: [{
      field_path: "body.categories",
      expected_type: "array",
      actual_type: "string",
      safe_correction_eligibility: "provider_corrected_arguments_required",
      correction_action: "provider_resubmit",
      expected_constraint: { kind: "json_type", type: "array" }
    }]
  });
  assert.equal((decorated as any).structuredContent.observation, undefined);
});

test("retained placement schema alternative crosses the real MCP boundary without claiming native dispatch", async () => {
  const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), "../operator-backend/test/fixtures/unit403-predispatch-schema-gap.json"), "utf8"));
  const request = fixture.request;
  const decorated = await runWithAssignmentKernelV2(meta("apply", "work", request), async () =>
    decorateAssignmentKernelMcpResultV2({ isError: true, content: [], structuredContent: {
      schema: "revit-operator.mcp-pre-dispatch-failure.v1", code: "mcp_request_validation_failed",
      phase: "request_validation", request_dispatched: false, outcome_unknown: false,
      method: request.method, path: request.path,
      input_schema_id: fixture.input_schema_gap.input_schema_id,
      input_schema_digest: fixture.input_schema_gap.input_schema_digest,
      validation_issues: fixture.input_schema_gap.issues
    } }, "revit_call_tool") as any);
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.authority, "operator-mcp-transport");
  assert.equal(result.status, "failed_before_dispatch");
  assert.equal(result.persistent_effect, "none");
  assert.equal(result.dispatch_state, "not_dispatched");
  assert.equal(result.observation_required, false);
  assert.equal(operationInputSchemaGapErrorV2(result.input_schema_gap, result), null);
  assert.deepEqual(result.input_schema_gap.issues, fixture.input_schema_gap.issues);
  assert.equal(decorated.structuredContent.observation, undefined);
});

test("a predispatch-looking diagnostic cannot erase an actual dispatched native attempt without settlement", async () => {
  const request = { method: "POST" as const, path: "/revit/place-families", body: { dryRun: false, instances: [] } };
  const decorated = await runWithAssignmentKernelV2(meta("apply", "work", request), async () => {
    const native = await beginAssignmentKernelNativeRequestV2(request.method, request.path, request.body, { classified_effect: "apply" });
    await markAssignmentKernelNativeRequestDispatchingV2(native);
    await recordAssignmentKernelNativeResultV2(request.method, request.path, {
      status: "Success", code: "mcp_request_validation_failed",
      canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
        request_dispatched: true, effect_state: "unknown", effect_authority: "native_host",
        effect_reason: "native_handler_returned_without_authoritative_settlement" }
    }, native);
    return decorateAssignmentKernelMcpResultV2({ content: [], structuredContent: {
      schema: "revit-operator.mcp-pre-dispatch-failure.v1", code: "mcp_request_validation_failed",
      request_dispatched: false, validation_issues: [{ field_path: "body", expected_type: "object", actual_type: "null" }]
    } }, "revit_call_tool") as any;
  });
  const result = decorated.structuredContent.operation_result_v2;
  assert.equal(result.authority, "native-host");
  assert.equal(result.dispatch_state, "dispatched");
  assert.equal(result.persistent_effect, "unknown");
  assert.equal(result.input_schema_gap, undefined);
});

test("native request correlation is derived from the canonical Operation and survives result settlement", async () => {
  const decorated = await runWithAssignmentKernelV2(meta("read", "work", { method: "POST", path: "/revit/schedules" }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/schedules");
    assert.match(request?.request_id ?? "", /^[0-9a-f]{64}$/);
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/schedules", {
      schedules: [{ id: 1 }],
      canonical_attempt_settlement: {
        attempt_id: "native-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, request);
    const result = decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
    assert.equal(result.structuredContent.operation_result_v2.native_correlation_id, request?.request_id);
    return result;
  });
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
});

test("Candidate 1 prerequisite and parent native calls retain distinct operation identities", async () => {
  const childLeases: any[] = [];
  const settled: any[] = [];
  const edge = {
    async openChild(input: any) {
      const lease = {
        ...meta()[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: `child-${input.child_ordinal}`,
        capability_id: input.capability_id,
        requested_effect: "read",
        purpose: "discovery",
        operation_role: input.operation_role,
        fulfillment_role: input.fulfillment_role,
        delegation_authority_id: input.delegation_authority_id,
        eligible_criterion_ids: input.eligible_criterion_ids,
        parent_operation_id: input.parent_operation_id,
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: `child-signature-${input.child_ordinal}`
        }
      };
      childLeases.push(lease);
      return lease as any;
    },
    async markDispatch() {},
    async settle(lease: any, result: any) {
      settled.push({ lease, result });
      return { settled: true };
    }
  };
  const decorated = await runWithAssignmentKernelV2({
    [ASSIGNMENT_KERNEL_V2_META_KEY]: {
      ...meta()[ASSIGNMENT_KERNEL_V2_META_KEY],
      capability_id: "revit_call_tool",
      request_identity: {
        capability_id: "revit_call_tool",
        method: "POST",
        path: "/revit/quantify",
        request_signature: payloadDigestV2({
          capability_id: "revit_call_tool",
          method: "POST",
          path: "/revit/quantify",
          body: null
        }).digest
      }
    }
  }, async () => {
    const prerequisite = await beginAssignmentKernelNativeRequestV2("GET", "/revit/tool-registry", undefined, {
      operation_role: "prerequisite"
    });
    assert.notEqual(prerequisite?.operation_id, "operation-1");
    await markAssignmentKernelNativeRequestDispatchingV2(prerequisite);
    await recordAssignmentKernelNativeResultV2("GET", "/revit/tool-registry", {
      tools: [{ method: "POST", path: "/revit/quantify" }],
      canonical_attempt_settlement: {
        attempt_id: "registry-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, prerequisite);

    const parent = await beginAssignmentKernelNativeRequestV2("POST", "/revit/quantify");
    assert.equal(parent?.operation_id, "operation-1");
    await markAssignmentKernelNativeRequestDispatchingV2(parent);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/quantify", {
      total: 509,
      canonical_attempt_settlement: {
        attempt_id: "quantify-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, parent);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  }, edge);
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.observation.raw_payload.total, 509);
  assert.equal(decorated.structuredContent.child_operation_results_v2.length, 1);
  assert.notEqual(decorated.structuredContent.child_operation_results_v2[0].operation_id, "operation-1");
  assert.equal(childLeases[0].parent_operation_id, "operation-1");
  assert.equal(childLeases[0].fulfillment_role, "prerequisite");
  assert.deepEqual(childLeases[0].eligible_criterion_ids, []);
  assert.equal(settled[0].result.structuredContent.operation_result_v2.operation_id, childLeases[0].operation_id);
  assert.equal(settled[0].result.structuredContent.observation.evidence_class, "prerequisite");
  assert.equal(settled[0].result.structuredContent.observation.raw_payload.tools[0].path, "/revit/quantify");
});

test("typed MCP parent retains controller identity while its exact native action settles as a child", async () => {
  const settled: any[] = [];
  const edge = {
    async openChild(input: any) {
      return {
        ...meta()[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: "native-child-1",
        capability_id: input.capability_id,
        requested_effect: "read",
        purpose: "work",
        operation_role: "child",
        fulfillment_role: input.fulfillment_role,
        eligible_criterion_ids: input.eligible_criterion_ids,
        parent_operation_id: "operation-1",
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: "native-child-signature"
        }
      } as any;
    },
    async markDispatch() {},
    async settle(lease: any, result: any) {
      settled.push({ lease, result });
      return { operation_id: lease.operation_id, settled: true,
        evidence_projections: [{ schema: "revit-operator.evidence-projection.v1",
          source: `assignment_kernel_v2:${lease.capability_id}`,
          assignment_id: lease.binding.assignment_id, run_id: lease.binding.run_id,
          generation: lease.binding.generation, attempt_id: lease.operation_id,
          evidence_id: "ev1_native_child" }] };
    }
  };
  const decorated = await runWithAssignmentKernelV2(meta(), async () => {
    const native = await beginAssignmentKernelNativeRequestV2("POST", "/revit/find-elements", undefined, {
      fulfillment_role: "delegated_task_execution"
    });
    assert.equal(native?.operation_role, "child");
    assert.equal(native?.parent_operation_id, "operation-1");
    await markAssignmentKernelNativeRequestDispatchingV2(native);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/find-elements", {
      total: 2,
      canonical_attempt_settlement: {
        attempt_id: "typed-native-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, native);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
  }, edge);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].lease.fulfillment_role, "delegated_task_execution");
  assert.deepEqual(settled[0].lease.eligible_criterion_ids, ["criterion-inventory"]);
  assert.equal(settled[0].result.structuredContent.observation.evidence_class, "task_result");
  assert.equal(settled[0].result.structuredContent.operation_result_v2.operation_id, "native-child-1");
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.operation_result_v2.status, "completed_without_native_dispatch");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "operator-mcp-transport");
  assert.equal(decorated.structuredContent.child_operation_results_v2[0].operation_id, "native-child-1");
  assert.equal(decorated.structuredContent.child_operation_results_v2[0].evidence_projections[0].attempt_id, "native-child-1");
  assert.equal(decorated.structuredContent.observation, undefined);
});

test("a reviewed typed verification handler delegates its native read with the exact parent grant", async () => {
  const settled: any[] = [];
  const edge = {
    async openChild(input: any) {
      return {
        ...meta("read", "verification")[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: "native-verification-child",
        capability_id: input.capability_id,
        purpose: "verification",
        operation_role: "child",
        fulfillment_role: input.fulfillment_role,
        delegation_authority_id: input.delegation_authority_id,
        eligible_criterion_ids: input.eligible_criterion_ids,
        parent_operation_id: "operation-1",
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: "verification-child-signature"
        }
      } as any;
    },
    async markDispatch() {},
    async settle(lease: any, result: any) {
      settled.push({ lease, result });
      return { settled: true };
    }
  };
  await runWithAssignmentKernelV2(meta("read", "verification"), async () => {
    const native = await beginAssignmentKernelNativeRequestV2("POST", "/revit/find-elements", { ids: [1] }, {
      fulfillment_role: currentAssignmentKernelTaskFulfillmentRoleV2()
    });
    await markAssignmentKernelNativeRequestDispatchingV2(native);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/find-elements", {
      items: [{ id: 1 }],
      canonical_attempt_settlement: {
        attempt_id: "verification-receipt", requested_effect: "read", effect_state: "none", request_dispatched: true
      }
    }, native);
  }, edge);
  assert.equal(settled[0].lease.fulfillment_role, "verification");
  assert.equal(settled[0].lease.delegation_authority_id, "delegation:operation-1");
  assert.deepEqual(settled[0].lease.eligible_criterion_ids, ["criterion-inventory"]);
  assert.equal(settled[0].result.structuredContent.observation.evidence_class, "verification");
});

test("an unclassified native child is supporting control until the trusted caller delegates task fulfillment", async () => {
  let admission: any = null;
  const edge = {
    async openChild(input: any) {
      admission = structuredClone(input);
      return {
        ...meta()[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: "native-support-child",
        capability_id: input.capability_id,
        requested_effect: "read",
        purpose: "work",
        operation_role: "child",
        fulfillment_role: input.fulfillment_role,
        eligible_criterion_ids: input.eligible_criterion_ids,
        parent_operation_id: "operation-1",
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: "native-support-signature"
        }
      } as any;
    },
    async markDispatch() {},
    async settle() { return { settled: true }; }
  };
  await runWithAssignmentKernelV2(meta(), async () => {
    const child = await beginAssignmentKernelNativeRequestV2("POST", "/revit/unclassified-support", { probe: true });
    assert.equal(child?.operation_role, "child");
  }, edge);
  assert.equal(admission.fulfillment_role, "supporting_control");
  assert.deepEqual(admission.eligible_criterion_ids, []);
  assert.equal(admission.delegation_authority_id, undefined);
});

test("same native route with a different canonical body cannot claim the admitted generic parent", async () => {
  let admission: any = null;
  const edge = {
    async openChild(input: any) {
      admission = structuredClone(input);
      return {
        ...meta()[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: "body-mismatch-child",
        capability_id: input.capability_id,
        requested_effect: "read",
        purpose: "work",
        operation_role: "child",
        fulfillment_role: input.fulfillment_role,
        eligible_criterion_ids: input.eligible_criterion_ids,
        parent_operation_id: "operation-1",
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: "body-mismatch-child-signature"
        }
      } as any;
    },
    async markDispatch() {},
    async settle() { return { settled: true }; }
  };
  await runWithAssignmentKernelV2(
    meta("read", "work", { method: "POST", path: "/revit/quantify", body: { categories: ["OST_DuctTerminal"] } }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2(
        "POST", "/revit/quantify", { categories: ["OST_MechanicalEquipment"] },
        { fulfillment_role: "delegated_task_execution" }
      );
      assert.equal(request?.operation_id, "body-mismatch-child");
      assert.equal(request?.operation_role, "child");
    },
    edge
  );
  assert.deepEqual(admission.arguments.body, { categories: ["OST_MechanicalEquipment"] });
  assert.equal(admission.delegation_authority_id, "delegation:operation-1");
});

test("retained evidence retrieval settles as a non-native read and records one stable focused selection", async () => {
  const operationMeta = meta("read", "evidence_read") as any;
  operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].capability_id = "operator_retrieve_evidence";
  operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].request_identity = {
    capability_id: "operator_retrieve_evidence",
    request_signature: "candidate55-focused-evidence-selection"
  };
  const selection = {
    ok: true,
    result: {
      schema: "revit-operator.evidence-retrieval.v1",
      evidence_ref: { evidence_id: "ev1_BE1x2Z1tkNa3F6VVtnPi_cEvu7lCs-MG" },
      selection: { "payload.items": [{ elementId: 1421361, text: "Existing note" }] },
      returned_bytes: 128,
      complete: false
    }
  };
  const decorated = await runWithAssignmentKernelV2(operationMeta, async () =>
    decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: JSON.stringify(selection) }] }, "operator_retrieve_evidence") as any);
  assert.equal(decorated.structuredContent.operation_result_v2.status, "succeeded");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "operator-evidence-store");
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
  assert.equal(decorated.structuredContent.observation.evidence_class, "control");
  assert.deepEqual(
    decorated.structuredContent.observation.semantic_facts
      .filter((fact: any) => fact.fact_id === "control.evidence_selection_available")
      .map((fact: any) => fact.dimensions),
    [{ capability_id: "operator_retrieve_evidence", evidence_id: "ev1_BE1x2Z1tkNa3F6VVtnPi_cEvu7lCs-MG", selection_path: "payload.items" }]
  );
  assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_class === "domain"), false);
});

test("C59 interpretation and registration receipts retain distinct control observations without task-result authority", async () => {
  const evidence = { evidence_id: `ev1_${"a".repeat(32)}`, content_hash: `sha256:${"b".repeat(64)}`, trust_level: "host_observed", verification_relevance: "supporting" };
  for (const [tool, payload, factId] of [
    ["operator_validate_existing_conditions_interpretation", {
      schema_version: 1, source_binding_sha256: "c".repeat(64), interpretation_sha256: "d".repeat(64),
      native_write_allowed: false, evidence_ref: evidence
    }, "control.existing_conditions_interpretation_available"],
    ["operator_register_existing_conditions_interpretation", {
      schema_version: 1, interpretation_evidence_id: evidence.evidence_id,
      frame_observation_id: `obsv2_${"e".repeat(64)}`, native_write_allowed: false,
      registration: { verified: true, rms_error_ft: 0.1, max_error_ft: 0.2 }, evidence_ref: evidence
    }, "control.existing_conditions_registration_available"]
  ] as const) {
    const operationMeta = meta("read", "discovery") as any;
    operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].capability_id = tool;
    operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].request_identity = { capability_id: tool, request_signature: `c59-${tool}` };
    const decorated = await runWithAssignmentKernelV2(operationMeta, async () =>
      decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: JSON.stringify(payload) }] }, tool) as any);
    assert.equal(decorated.structuredContent.operation_result_v2.status, "succeeded");
    assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
    assert.equal(decorated.structuredContent.observation.evidence_class, "control");
    assert.deepEqual(decorated.structuredContent.observation.semantic_facts.filter((fact: any) => fact.fact_id === factId).length, 1);
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_class === "domain"), false);
  }
});

test("C59 rejected landmark fit retains bounded measured residuals in canonical operation result", async () => {
  const operationMeta = meta("read", "discovery") as any;
  operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].capability_id = "operator_register_existing_conditions_interpretation";
  operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].request_identity = {
    capability_id: "operator_register_existing_conditions_interpretation", request_signature: "c59-rejected-fit"
  };
  const rawResult = { isError: true, content: [{ type: "text", text:
    'Existing-conditions registration validator responded with status 400: {"ok":false,"error":"existing_conditions_registration_residual_exceeds_limit:rms=1.1866190083854595:max=1.7827596133477037"}' }] };
  const decorated = await runWithAssignmentKernelV2(operationMeta, async () =>
    decorateAssignmentKernelMcpResultV2(rawResult, "operator_register_existing_conditions_interpretation") as any);
  assert.equal(decorated.structuredContent.operation_result_v2.status, "failed_before_dispatch");
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
  assert.equal(decorated.structuredContent.operation_result_v2.error_code,
    "existing_conditions_registration_residual_exceeds_limit:rms=1.1866190083854595:max=1.7827596133477037");
  assert.equal(decorated.structuredContent.observation, undefined);
  const unrelatedMeta = meta("read", "discovery") as any;
  unrelatedMeta[ASSIGNMENT_KERNEL_V2_META_KEY].capability_id = "operator_read_attachment";
  unrelatedMeta[ASSIGNMENT_KERNEL_V2_META_KEY].request_identity = {
    capability_id: "operator_read_attachment", request_signature: "c59-unrelated-error"
  };
  const unrelated = await runWithAssignmentKernelV2(unrelatedMeta, async () =>
    decorateAssignmentKernelMcpResultV2(rawResult, "operator_read_attachment") as any);
  assert.equal(unrelated.structuredContent.operation_result_v2.error_code, "mcp_tool_failed");
});

test("Candidate 50 tool search retains exact control knowledge without acquiring task eligibility", async () => {
  const operationMeta = meta("read", "discovery") as any;
  operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].capability_id = "revit_search_tools";
  operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].request_identity = {
    capability_id: "revit_search_tools",
    request_signature: "candidate50-r01-text-note-search"
  };
  const rawResult = {
    content: [{
      type: "text",
      text: JSON.stringify({
        query: "find and replace one text note",
        count: 2,
        matches: [
          { method: "GET", path: "/revit/find-text-notes", title: "Find Text Notes", risk: "low" },
          { method: "POST", path: "/revit/replace-text-note", title: "Replace Text Note", risk: "medium" }
        ]
      })
    }]
  };

  const decorated = await runWithAssignmentKernelV2(operationMeta, async () =>
    decorateAssignmentKernelMcpResultV2(rawResult, "revit_search_tools") as any);
  const result = decorated.structuredContent.operation_result_v2;
  const observation = decorated.structuredContent.observation;

  assert.equal(result.status, "succeeded");
  assert.equal(result.dispatch_state, "dispatched");
  assert.equal(result.authority, "operator-mcp-transport");
  assert.equal(result.observation_required, true);
  assert.deepEqual(observation.raw_payload, rawResult);
  assert.equal(observation.evidence_class, "control");
  assert.deepEqual(observation.eligible_criterion_ids ?? [], []);
  assert.deepEqual(
    observation.semantic_facts
      .filter((fact: any) => fact.fact_id === "control.capability_available")
      .map((fact: any) => fact.dimensions)
      .sort((left: any, right: any) => left.path.localeCompare(right.path)),
    [
      { capability_id: "revit_search_tools", method: "GET", path: "/revit/find-text-notes" },
      { capability_id: "revit_search_tools", method: "POST", path: "/revit/replace-text-note" }
    ]
  );
  assert.equal(observation.semantic_facts.some((fact: any) => fact.fact_class === "domain"), false);
  assert.equal(observation.semantic_facts.some((fact: any) => fact.fact_id === "task.result_available"), false);
});

test("capability search retains its transformed control result after a distinct registry prerequisite settles", async () => {
  const settled: any[] = [];
  const operationMeta = meta("read", "discovery") as any;
  operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].capability_id = "revit_search_tools";
  operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY].request_identity = {
    capability_id: "revit_search_tools",
    request_signature: "search-with-registry-prerequisite"
  };
  const edge = {
    async openChild(input: any) {
      return {
        ...operationMeta[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: "registry-prerequisite",
        capability_id: input.capability_id,
        purpose: "discovery",
        operation_role: "prerequisite",
        fulfillment_role: "prerequisite",
        eligible_criterion_ids: [],
        parent_operation_id: "operation-1",
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: "registry-prerequisite-signature"
        }
      } as any;
    },
    async markDispatch() {},
    async settle(lease: any, result: any) {
      settled.push({ lease, result });
      return { operation_id: lease.operation_id, settled: true };
    }
  };
  const rawResult = {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "available",
        matches: [{ method: "POST", path: "/revit/replace-text-note" }]
      })
    }]
  };
  const decorated = await runWithAssignmentKernelV2(operationMeta, async () => {
    const prerequisite = await beginAssignmentKernelNativeRequestV2("GET", "/revit/tool-registry", undefined, {
      operation_role: "prerequisite"
    });
    await markAssignmentKernelNativeRequestDispatchingV2(prerequisite);
    await recordAssignmentKernelNativeResultV2("GET", "/revit/tool-registry", {
      tools: [{ method: "POST", path: "/revit/replace-text-note" }],
      canonical_attempt_settlement: {
        attempt_id: "registry-prerequisite-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, prerequisite);
    return decorateAssignmentKernelMcpResultV2(rawResult, "revit_search_tools") as any;
  }, edge);

  assert.equal(settled.length, 1);
  assert.equal(settled[0].lease.operation_id, "registry-prerequisite");
  assert.equal(settled[0].result.structuredContent.observation.evidence_class, "prerequisite");
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.operation_result_v2.status, "succeeded");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "operator-mcp-transport");
  assert.deepEqual(decorated.structuredContent.observation.raw_payload, rawResult);
  assert.ok(decorated.structuredContent.observation.semantic_facts.some((fact: any) =>
    fact.fact_id === "control.capability_available"
      && fact.dimensions.path === "/revit/replace-text-note"));
  assert.equal(decorated.structuredContent.child_operation_results_v2[0].operation_id, "registry-prerequisite");
});

test("read context rejects a contradictory native applied settlement", async () => {
  await assert.rejects(() => runWithAssignmentKernelV2(meta("read", "work", { method: "POST", path: "/transport-only" }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/transport-only");
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/transport-only", {
      ok: true,
      canonical_attempt_settlement: { attempt_id: "receipt", requested_effect: "apply", effect_state: "applied", request_dispatched: true }
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read");
  }), /read_effect_conflict/);
});

test("without trusted V2 meta, transport output is unchanged", async () => {
  const original = { content: [{ type: "text", text: "legacy" }] };
  const result = await runWithAssignmentKernelV2({}, async () => decorateAssignmentKernelMcpResultV2(original, "legacy"));
  assert.equal(result, original);
});

test("trusted host binding is available to lifecycle tools without model-authored identifiers", async () => {
  const seen = await runWithAssignmentKernelV2({ [ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]: binding }, async () => {
    return currentAssignmentKernelV2Binding();
  });
  assert.deepEqual(seen, binding);
  assert.equal(currentAssignmentKernelV2Binding(), null);
});

test("malformed trusted lifecycle binding fails before a lifecycle handler can dispatch", async () => {
  await assert.rejects(
    () => runWithAssignmentKernelV2({ [ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]: { ...binding, generation: 0 } }, async () => "unreachable"),
    /assignment_kernel_v2_binding_context_invalid/
  );
});

test("MCP retains authenticated native completion before returning its operation envelope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-mcp-completion-"));
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const previousKey = process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const key = completionOutboxKeyV2(root);
  process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY = key;
  try {
    const body = { elementId: 1478627, newText: "RECOVERED", apply: true };
    const requestMeta = meta("apply", "work", { method: "POST", path: "/revit/replace-text-note", body });
    const lease = requestMeta[ASSIGNMENT_KERNEL_V2_META_KEY];
    assert.equal(readCompletionOutboxV2(root, key, lease), null);
    await runWithAssignmentKernelV2(requestMeta, async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/replace-text-note", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/replace-text-note", {
        ok: true, elementId: 1478627, before: "ORIGINAL", after: "RECOVERED", changed: true,
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1",
          attempt_id: "native-committed-once", requested_effect: "apply", effect_state: "applied",
          effect_authority: "native_receipt", request_dispatched: true }
      }, request);
      const result = decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
      const retained = readCompletionOutboxV2(root, key, lease) as any;
      assert.deepEqual(retained.structuredContent, JSON.parse(JSON.stringify(result.structuredContent)));
      assert.equal(retained.structuredContent.operation_result_v2.persistent_effect, "applied");
      assert.equal(retained.structuredContent.operation_result_v2.native_transaction_state, "committed");
      assert.equal(retained.structuredContent.observation.raw_payload.after, "RECOVERED");
      // Simulate loss of the producer/transport after retention, before delivery.
      // The consumer can read the receipt even though no envelope is returned.
    });
    assert.ok(readCompletionOutboxV2(root, key, lease));
    assert.throws(() => readCompletionOutboxV2(root, "0".repeat(64), lease), /signature_invalid/);
    const wrong = { ...lease, binding: { ...lease.binding, principal_id: "another-principal" } };
    assert.equal(readCompletionOutboxV2(root, key, wrong), null);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY; else process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("visibility category rejection retains native rollback truth and pending remains unknown", async () => {
  for (const effect of ["none", "unknown"] as const) {
    const body = { action: "hide_category", viewId: 1363433, categoryName: "Rooms", categoryNames: ["Rooms", "Room Tags"] };
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/visibility", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/visibility", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/visibility", {
        status: "Failed", success: false, action: "hide_category", dryRun: false,
        error: "Category 'Rooms' cannot be hidden in view 'L4'.",
        transaction: { status: effect === "none" ? "rolled_back" : "pending", committed: effect === "none" ? false : null,
          modified_element_ids: [], affected_element_ids: [], added_element_ids: [], deleted_element_ids: [] },
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "visibility-rejected",
          requested_effect: "apply", effect_state: effect, effect_authority: effect === "none" ? "native_rollback" : "native_host",
          effect_reason: effect === "none" ? "verified_native_rollback" : "native_handler_returned_without_authoritative_settlement", request_dispatched: true,
          affected_target_identities: [] }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, "failed_after_dispatch");
    assert.equal(result.persistent_effect, effect);
    assert.equal(result.native_transaction_state, effect === "none" ? "rolled_back" : "unknown");
    assert.deepEqual(result.affected_target_identities ?? [], []);
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "task.result_available"), false);
  }
});

test("transaction group canonical authority retains committed view and collateral identities without trusting phase hints", async () => {
  for (const authoritative of [true, false]) {
    const body = { actions: [{ kind: "duplicateView", sourceViewId: 9948, duplicateOption: "withDetailing",
      newName: "M-LEVEL 2 COORDINATION", resultRef: "coord_view" }] };
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: "/revit/transaction-apply", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/transaction-apply", body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/transaction-apply", {
        success: true, impactState: "committed", transaction: { phase: "committed", assimilate: { status: "Committed", succeeded: true } },
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "group-commit-replay",
          requested_effect: "apply", effect_state: authoritative ? "applied" : "unknown",
          effect_authority: authoritative ? "native_transaction" : "native_host",
          effect_reason: authoritative ? "native_transaction_committed" : "native_handler_returned_without_authoritative_settlement",
          request_dispatched: true, affected_target_identities: authoritative ? ["element_id:1542918", "element_id:49831"] : [] }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, authoritative ? "applied" : "unknown");
    assert.equal(result.native_transaction_state, authoritative ? "committed" : "unknown");
    assert.deepEqual(result.affected_target_identities, authoritative ? ["element_id:1542918", "element_id:49831"] : []);
  }
});

test("visibility settlement distinguishes pretransaction rejection, commit, and unknown preview", async () => {
  for (const [effect, requested, authority, reason, state] of [
    ["none", "apply", "native_host", "native_transaction_not_started", "not_started"],
    ["applied", "apply", "native_transaction", "native_transaction_committed", "committed"],
    ["unknown", "preview", "native_host", "native_handler_returned_without_authoritative_settlement", "unknown"]
  ] as const) {
    const body = { action: "set_scale", viewId: 1363433, scale: 96, dryRun: requested === "preview" };
    const decorated = await runWithAssignmentKernelV2(meta(requested, "work", { method: "POST", path: "/revit/visibility", body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/visibility", body, { classified_effect: requested });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/revit/visibility", {
        status: effect === "applied" ? "Success" : "Failed", success: effect === "applied",
        ...(effect === "applied" ? { view: { id: 1363433, scale: 96 } } : { error: "native request rejected" }),
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "visibility-neighbor",
          requested_effect: requested, effect_state: effect, effect_authority: authority, effect_reason: reason,
          request_dispatched: true, affected_target_identities: effect === "applied" ? ["element_id:1363433"] : [] }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, effect);
    assert.equal(result.native_transaction_state, state);
    assert.deepEqual(result.affected_target_identities, effect === "applied" ? ["element_id:1363433"] : []);
  }
});


test('C44 exact inventory preflight carries useful nested constraints through MCP settlement',async()=>{
 const {preflightKnownGenericToolBody,mcpPreDispatchFailureResult}=await import('./genericToolPreflight.js');
 const f=JSON.parse(readFileSync('src/lib/fixtures/c44-inventory-limit.json','utf8'));
 const failure=preflightKnownGenericToolBody(f.contract,f.request.body)!;
 const decorated:any=await runWithAssignmentKernelV2(meta('read','work',f.request),async()=>
  decorateAssignmentKernelMcpResultV2(mcpPreDispatchFailureResult(failure),'revit_call_tool'));
 const result=decorated.structuredContent.operation_result_v2;
 assert.equal(result.status,'failed_before_dispatch');assert.equal(result.persistent_effect,'none');
 assert.equal(result.observation_required,false);
 assert(result.input_schema_gap.issues.some((i:any)=>i.field_path==='body.limit'&&i.expected_constraint.maximum===2000));
 assert.equal(decorated.structuredContent.observation,undefined);
});

test('C47 Failed family placement remains a failed operation and preserves independent rollback authority', async () => {
 const fixture=JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/c47-family-rollback.json',import.meta.url),'utf8'));
 for(const confirmed of [true,false]) {
  const {path:route,body}=fixture.input;
  const decorated:any=await runWithAssignmentKernelV2(meta('apply','work',{method:'POST',path:route,body}),async()=>{
   const request=await beginAssignmentKernelNativeRequestV2('POST',route,body,{classified_effect:'apply'});
   await markAssignmentKernelNativeRequestDispatchingV2(request);
   const payload=structuredClone(fixture.payload); if(!confirmed)delete payload.transaction;
   await recordAssignmentKernelNativeResultV2('POST',route,{...payload,canonical_attempt_settlement:{schema:'revit-operator.native-attempt-settlement.v1',requested_effect:'apply',effect_state:confirmed?'none':'unknown',effect_authority:confirmed?'native_rollback':'native_host',effect_reason:confirmed?'verified_native_rollback':'native_handler_returned_without_authoritative_settlement',request_dispatched:true}},request);
   return decorateAssignmentKernelMcpResultV2({content:[]},'revit_call_tool');
  });
  assert.equal(decorated.structuredContent.operation_result_v2.status,'failed_after_dispatch');
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect,confirmed?'none':'unknown');
  assert.equal(decorated.structuredContent.operation_result_v2.native_transaction_state,confirmed?'rolled_back':'unknown');
 }
});

test("tag-elements retained plain Dry Run and transaction-status neighbors preserve native effect truth", async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../operator-backend/test/fixtures/tag-elements-dry-run-plain.json', import.meta.url), 'utf8'));
  assert.equal(fixture.payload.status, "Dry Run");
  assert.equal(fixture.payload.transaction, undefined);
  assert.equal(fixture.payload.plannedToTag, 10);
  for (const variant of ["retained_plain", "not_started", "repair_rolled_back", "committed", "pending", "malformed_effect", "preview_commit"] as const) {
    const apply = variant === "committed";
    const requested = apply ? "apply" : "preview";
    const body = { ...fixture.input.body, dryRun: !apply };
    const notStarted = variant === "not_started", rolledBack = variant === "repair_rolled_back";
    const effect = apply || variant === "preview_commit" ? "applied" : notStarted || rolledBack ? "none" : variant === "malformed_effect" ? "unrecognized" : "unknown";
    const payload = {
      ...structuredClone(fixture.payload),
      ...(notStarted ? { previewExecuted: false, applied: false, transaction: { status: "not_started", committed: false, affected_element_ids: [] } } : {}),
      ...(rolledBack ? { previewExecuted: true, applied: false, transaction: { status: "rolled_back", committed: false, affected_element_ids: [] } } : {}),
      ...(apply ? { status: "Success", dryRun: false, applied: true, tagIds: [10101], transaction: { status: "committed", committed: true, affected_element_ids: [10101] } } : {}),
      ...(variant === "pending" ? { transaction: { status: "pending", committed: null, affected_element_ids: [] } } : {}),
      canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1", requested_effect: requested,
        effect_state: effect, effect_authority: rolledBack ? "native_rollback" : apply || notStarted || variant === "preview_commit" ? "native_transaction" : "native_host",
        effect_reason: rolledBack ? "verified_native_rollback" : notStarted ? "native_transaction_not_started" : apply || variant === "preview_commit" ? "native_transaction_committed" : "native_handler_returned_without_authoritative_settlement",
        request_dispatched: true, affected_target_identities: apply ? ["element_id:10101"] : []
      }
    };
    const invoke = () => runWithAssignmentKernelV2(meta(requested, "work", { method: "POST", path: fixture.input.path, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", fixture.input.path, body, { classified_effect: requested });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", fixture.input.path, payload, request);
      return decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: JSON.stringify(payload) }] }, "revit_call_tool") as any;
    });
    if (variant === "malformed_effect" || variant === "preview_commit") {
      await assert.rejects(invoke, variant === "malformed_effect" ? /native_effect_invalid/ : /effect_exceeds_operation/);
      continue;
    }
    const decorated = await invoke();
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, effect, variant);
    assert.equal(result.native_transaction_state, apply ? "committed" : notStarted ? "not_started" : rolledBack ? "rolled_back" : "unknown", variant);
    assert.deepEqual(result.affected_target_identities, apply ? ["element_id:10101"] : [], variant);
    // Planning without a transaction is known no-effect, but cannot claim a successfully exercised preview.
    if (notStarted || variant === "retained_plain" || variant === "pending") {
      assert.equal(result.status, "failed_after_dispatch", variant);
      assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "task.preview_valid" && fact.value === true), false, variant);
    }
    if (apply) assert.equal(result.status, "succeeded");
  }
});

test("family requested-parameter failure preserves partial, rolled-back and unknown effects", async () => {
  const route = "/revit/place-families";
  const body = { familySymbolId: 101, levelName: "L4", behavior: "bestEffort", dryRun: false,
    instances: [{ x: 0, y: 0, z: 0, parameters: { "Duct Radius": '4"' } },
      { x: 1, y: 0, z: 0, parameters: { "Duct Radius": "unparseable" } }] };
  for (const variant of ["partial", "readback_failed", "rolled_back", "unknown"] as const) {
    const applied = variant === "partial" || variant === "readback_failed";
    const rollback = variant === "rolled_back";
    const affected = applied ? ["element_id:201", "element_id:202"] : [];
    const decorated = await runWithAssignmentKernelV2(meta("apply", "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: "apply" });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, {
        status: applied ? "PlacedWithErrors" : "Failed", success: false,
        placedCount: applied ? 1 : 0, failedCount: variant === "partial" ? 1 : 0,
        parameterVerificationFailedCount: variant === "readback_failed" ? 1 : 0,
        elementIds: applied ? [201] : [],
        transaction: { status: applied ? "committed" : rollback ? "rolled_back" : "Pending",
          committed: applied ? true : rollback ? false : null,
          affected_element_ids: applied ? [201, 202] : [], added_element_ids: applied ? [201, 202] : [],
          modified_element_ids: [], deleted_element_ids: [] },
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: "apply",
          effect_state: applied ? "applied" : rollback ? "none" : "unknown",
          effect_authority: applied ? "native_transaction" : rollback ? "native_rollback" : "native_host",
          effect_reason: applied ? "native_transaction_committed" : rollback ? "verified_native_rollback" : "native_handler_returned_without_authoritative_settlement",
          request_dispatched: true, affected_target_identities: affected }
      }, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, "failed_after_dispatch");
    assert.equal(result.persistent_effect, applied ? "applied" : rollback ? "none" : "unknown");
    assert.equal(result.native_transaction_state, applied ? "committed" : rollback ? "rolled_back" : "unknown");
    assert.deepEqual(result.affected_target_identities, affected);
    assert.equal(decorated.structuredContent.observation.semantic_facts.some(
      (fact: any) => fact.fact_id === "task.result_available" && fact.value === true), false);
  }
});

import { retainAssignmentKernelNativeDispatchV1 } from "./assignmentKernelV2.js";
import { readNativeCompletionDispatchV1 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";

for (const requestedEffect of ["apply", "preview"] as const)
test(`native dispatch mapping ${requestedEffect} survives timeout and stays bound to the exact lease`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-native-dispatch-"));
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT, previousKey = process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const key = completionOutboxKeyV2(root); process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY = key;
  const body = { ids: [42], mode: "vector", vectorX: 0, vectorY: 0, vectorZ: 1, dryRun: requestedEffect === "preview" }, route = "/revit/move-elements";
  const metadata = structuredClone(meta(requestedEffect, "work", { method: "POST", path: route, body }));
  metadata[ASSIGNMENT_KERNEL_V2_META_KEY].binding.document_fingerprint = "a".repeat(64);
  const lease = metadata[ASSIGNMENT_KERNEL_V2_META_KEY];
  try {
    const result = await runWithAssignmentKernelV2(metadata, async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: requestedEffect });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      const native = { request_id: request!.request_id, request_nonce_sha256: `sha256:${"b".repeat(64)}`, server_epoch: Buffer.alloc(32, 2).toString("base64url"),
        method: "POST", path: route, body_present: true, source_body_sha256: `sha256:${"c".repeat(64)}`,
        channel: "generic_call" as const, alias: "revit_call_tool", transport_receipt_sha256: `sha256:${"d".repeat(64)}` };
      retainAssignmentKernelNativeDispatchV1(request, native);
      retainAssignmentKernelNativeDispatchV1(request, native);
      assert.equal(readNativeCompletionDispatchV1(root, key, lease)!.native.request_id, request!.request_id);
      assert.throws(() => retainAssignmentKernelNativeDispatchV1(request, { ...native, request_nonce_sha256: `sha256:${"e".repeat(64)}` }), /result_conflict/);
      assert.throws(() => retainAssignmentKernelNativeDispatchV1(request, { ...native, request_id: "f".repeat(64) }), /identity_mismatch/);
      await recordAssignmentKernelNativeFailureV2(request, { phase: "response", request_dispatched: true, outcome_unknown: true });
      return decorateAssignmentKernelMcpResultV2({ isError: true, content: [] }, "revit_call_tool") as any;
    });
    const retained = readNativeCompletionDispatchV1(root, key, lease)!;
    assert.equal(result.structuredContent.operation_result_v2.native_correlation_id, retained.native.request_id);
    assert.equal(result.structuredContent.operation_result_v2.persistent_effect, "unknown");
    assert.ok(readCompletionOutboxV2(root, key, lease));
    assert.throws(() => readNativeCompletionDispatchV1(root, "0".repeat(64), lease), /signature_invalid/);
    assert.equal(readNativeCompletionDispatchV1(root, key, { ...lease, binding: { ...lease.binding, generation: 2 } }), null);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    if (previousKey === undefined) delete process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY; else process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


for (const compact of [false, true])
test(`compact child handoff digest declares its scope without changing evidence or native uncertainty (${compact})`, async () => {
  let settlement: any;
  const edge = {
    async openChild(input: any) { return { ...meta("apply")[ASSIGNMENT_KERNEL_V2_META_KEY], operation_id: "handoff-child",
      capability_id: input.capability_id, operation_role: "child", parent_operation_id: "operation-1", root_operation_id: "operation-1",
      fulfillment_role: "supporting_control", eligible_criterion_ids: [], blocks_parent_settlement: true,
      request_identity: { capability_id: input.capability_id, method: input.method, path: input.path, request_signature: "handoff-request" } } as any; },
    async markDispatch() {},
    async settle(lease: any, result: any) {
      assert.equal(result.structuredContent.operation_result_v2.persistent_effect, "unknown");
      settlement = { ok: true, operation_id: lease.operation_id, evidence_refs: [], evidence_projections: [
        { evidence_id: "ev1_handoff", attempt_id: lease.operation_id, result: { uncertainty: "native result unavailable" } }],
        ...(compact ? { schema: "revit-operator.operation-handoff/v1", result_id: result.structuredContent.operation_result_v2.result_id }
          : { assignment_snapshot_v2: { full_history: ["retained legacy snapshot"] } }) };
      return settlement;
    }
  };
  const decorated: any = await runWithAssignmentKernelV2(meta("apply"), async () => {
    const child = await beginAssignmentKernelNativeRequestV2("POST", "/revit/rotate-elements", { elementIds: [41], angleDegrees: 90 },
      { operation_role: "child", classified_effect: "apply" });
    await markAssignmentKernelNativeRequestDispatchingV2(child);
    await recordAssignmentKernelNativeFailureV2(child, { message: "Native connection lost", request_dispatched: true, outcome_unknown: true });
    return decorateAssignmentKernelMcpResultV2({ isError: true, content: [] }, "inventory.read");
  }, edge);
  const child = decorated.structuredContent.child_operation_results_v2[0];
  assert.equal(child.operation_id, "handoff-child");
  assert.equal(child.parent_operation_id, "operation-1");
  assert.equal(child.settlement_digest, payloadDigestV2(settlement).digest);
  assert.deepEqual(child.evidence_projections, settlement.evidence_projections);
  assert.equal(child.settlement_digest_scope, compact ? "operation_handoff_v1" : undefined);
  assert.equal(Object.hasOwn(child, "settlement_digest_scope"), compact);
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none", "child effects do not fabricate parent native dispatch");
  assert.equal(decorated.structuredContent.observation, undefined);
});


test("move short-line failure preserves observed rollback and never infers no effect from preview or diagnostics", async () => {
  const route = "/revit/move-elements";
  for (const requested of ["preview", "apply"] as const)
  for (const state of ["rolled_back", "pending", "missing"] as const) {
    const rolledBack = state === "rolled_back", effect = rolledBack ? "none" : "unknown";
    const body = { ids: [41, 42], mode: "vector", vectorX: 0, vectorY: 0, vectorZ: 1,
      moveTogether: true, behavior: "allOrNothing", dryRun: requested === "preview" };
    const payload = { status: "Failed", success: false, error: "Line is too short.",
      movedIds: [], snapshots: [], skipped: [], warnings: [], movedTogether: true,
      failureRollbackRequested: true, rolledBack: rolledBack ? true : null,
      capturedFailures: [{ severity: "Error", message: "Line is too short.", elementIds: [41, 42],
        failureDefinitionId: "native-short-line", captureErrors: [] }],
      ...(state === "missing" ? {} : { transaction: { status: state, committed: rolledBack ? false : null,
        affected_element_ids: [], added_element_ids: [], modified_element_ids: [], deleted_element_ids: [] } }),
      canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: requested,
        method: "POST", path: route, effect_state: effect,
        effect_authority: rolledBack ? "native_rollback" : "native_host",
        effect_reason: rolledBack ? "verified_native_rollback" : "native_handler_returned_without_authoritative_settlement",
        request_dispatched: true, affected_target_identities: [] } };
    const decorated: any = await runWithAssignmentKernelV2(meta(requested, "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: requested });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, payload, request);
      return decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: JSON.stringify(payload) }] }, "revit_call_tool");
    });
    const result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.status, "failed_after_dispatch");
    assert.equal(result.persistent_effect, effect, `${requested}/${state}`);
    assert.equal(result.native_transaction_state, rolledBack ? "rolled_back" : "unknown");
    assert.deepEqual(result.affected_target_identities, []);
    assert.equal(decorated.structuredContent.observation.semantic_facts.some((fact: any) =>
      ["task.result_available", "task.preview_valid"].includes(fact.fact_id) && fact.value === true), false);
  }
});

test("reroute planning and observed apply receipts preserve effect separately from preview authority", async () => {
  const route = "/revit/reroute-mep-route-segment";
  for (const operation of ["offset", "size_transition"] as const)
  for (const variant of ["plain_plan", "not_started", "blocked", "committed", "readback_failed", "rolled_back", "pending", "visual_unsettled", "preview_commit"] as const) {
    const preview = ["plain_plan", "not_started", "preview_commit"].includes(variant);
    const requested = preview ? "preview" : "apply";
    const applied = ["committed", "readback_failed", "preview_commit"].includes(variant);
    const notStarted = ["not_started", "blocked"].includes(variant), rolledBack = variant === "rolled_back";
    const effect = applied ? "applied" : notStarted || rolledBack ? "none" : "unknown";
    const body = { hostElementId: 42, operation, apply: !preview, dryRun: preview,
      ...(operation === "offset" ? { split1ChainageFt: 2, split2ChainageFt: 8, offsetVector: { x: 0, y: 0, z: 1 } }
        : { transitionChainageFt: 5, upstreamDiameter: '6"', downstreamDiameter: '8"' }) };
    const affected = applied ? ["element_id:42", "element_id:52"] : [];
    const nativeState = applied ? "committed" : notStarted ? "not_started" : rolledBack ? "rolled_back" : "unknown";
    const payload = { status: preview ? "Dry Run" : applied ? "Rerouted" : "Blocked", dryRun: preview,
      ...(variant === "readback_failed" || variant === "blocked" || rolledBack || variant === "visual_unsettled"
        ? { success: false, error: "native verification or mutation did not complete" } : {}),
      ...(notStarted ? { previewExecuted: false } : {}),
      ...(variant === "plain_plan" ? {} : { transaction: { status: nativeState, committed: applied ? true : notStarted || rolledBack ? false : null } }),
      ...(variant === "visual_unsettled" ? { nativeStages: { route: { status: "committed", committed: true }, visual: { transaction: { status: "pending", committed: null } } } } : {}),
      canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", requested_effect: requested,
        effect_state: effect, effect_authority: rolledBack ? "native_rollback" : applied || notStarted ? "native_transaction" : "native_host",
        effect_reason: rolledBack ? "verified_native_rollback" : notStarted ? "native_transaction_not_started"
          : applied ? "native_transaction_committed" : "native_handler_returned_without_authoritative_settlement",
        request_dispatched: true, affected_target_identities: affected } };
    const invoke = () => runWithAssignmentKernelV2(meta(requested, "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: requested });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, payload, request);
      return decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: JSON.stringify(payload) }] }, "revit_call_tool") as any;
    });
    if (variant === "preview_commit") { await assert.rejects(invoke, /effect_exceeds_operation/); continue; }
    const decorated = await invoke(), result = decorated.structuredContent.operation_result_v2;
    assert.equal(result.persistent_effect, effect, `${operation}/${variant}`);
    assert.equal(result.native_transaction_state, nativeState, variant);
    assert.equal(result.status, variant === "committed" ? "succeeded" : "failed_after_dispatch", variant);
    assert.deepEqual(result.affected_target_identities, affected, variant);
    assert.equal(decorated.structuredContent.observation.semantic_facts.some(
      (fact: any) => fact.fact_id === "task.preview_valid" && fact.value === true), false);
    if (notStarted && preview) assert.equal(result.error_code, "native_preview_execution_unproven");
  }
});
