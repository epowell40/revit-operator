import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import { completionOutboxKeyV2, readCompletionOutboxV2 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { revitRouteEffect } from "./revitRouteEffect.js";
import { nativeArtifactReceiptEffectV1, nativeArtifactResultEffectV2 } from "@revitoperator/assignment-kernel-v2-contracts";

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

test("native PDF exports and nonwriting plans retain artifact authority without inventing transactions", async () => {
  for (const route of ["/revit/export-pdf", "/revit/print"]) for (const requested of ["apply", "preview"] as const) {
    const receipt = pdfArtifactReceipt(requested), body = { viewIds: [1420963], dryRun: requested === "preview",
      ...(route === "/revit/print" ? { copies: 1, collate: true, printIndividually: false } : {}) };
    Object.assign(receipt, { path: route, ...(route === "/revit/print" ? { print_settings_restored: true } : {}) });
    const decorated = await runWithAssignmentKernelV2(meta(requested, "work", { method: "POST", path: route, body }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", route, body, { classified_effect: requested });
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", route, {
        status: requested === "apply" ? "Success" : "Dry Run", ok: true, dryRun: requested === "preview", artifact_receipt: receipt,
        warnings: route === "/revit/print" ? ["Collation is not applicable to a job with one view or one copy; the existing collation setting was left unchanged."] : [],
        selectedCount: 1, selectedSheets: [{ viewId: 1420963, sheetNumber: "M000" }], preflight: { outputs: receipt.expected_output_paths },
        canonical_attempt_settlement: { schema: "revit-operator.native-attempt-settlement.v1", attempt_id: "export-native",
          requested_effect: requested, effect_state: requested === "apply" ? "applied" : "none", effect_authority: "native_receipt",
          effect_reason: requested === "apply" ? "native_artifact_export_completed" : "native_artifact_export_not_started",
          request_dispatched: true, affected_target_identities: requested === "apply" ? ["artifact_path:C:/fixture/M000.pdf"] : [] }
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
  assert.equal(result.native_transaction_state, "rolled_back");
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
          effect_authority: "native_receipt",
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
          effect_authority: "native_receipt",
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
      return { operation_id: lease.operation_id, settled: true };
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

test("visibility settlement distinguishes pretransaction rejection, commit, and unknown preview", async () => {
  for (const [effect, requested, authority, reason, state] of [
    ["none", "apply", "native_host", "native_transaction_not_started", "not_applicable"],
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
