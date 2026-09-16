import assert from "node:assert/strict";
import test from "node:test";
import { presentDynamicProgramResult } from "./dynamicProgramPresentation.js";

test("affected-element failure leads with native cause and stays bounded despite a large snapshot", () => {
  const payload = { execution_status: "failed", evidence: {
    failure: "SUPERVISOR_FAILURE: opaque hash",
    snapshotReceipt: JSON.stringify({ elements: Array.from({ length: 500 }, () => ({ description: "x".repeat(1000) })) }),
    previewReceipt: JSON.stringify({ ok: false, failure: "Dynamic preview changed-element budget exceeded.",
      operation_count: 1, projected_changed_element_ids: [1, 2, 3, 4], rollback_status: "RolledBack", rollback_truth: true }) } };
  const view: any = presentDynamicProgramResult(payload);
  assert.equal(view.failure, "Dynamic preview changed-element budget exceeded.");
  assert.equal(view.native_preview.affected_element_count, 4);
  assert.equal(view.native_preview.operation_count, 1);
  assert.equal(view.native_preview.rollback_truth, true);
  assert.match(view.guidance, /dependent affected elements/);
  assert.match(view.guidance, /direct targets unchanged/);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 4000);
  assert.ok(payload.evidence.snapshotReceipt.length > 500000, "full retained input is not modified");
});

test("compile location survives projection while malformed and oversized diagnostics are bounded", () => {
  const view: any = presentDynamicProgramResult({ execution_status: "failed", diagnostics: [
    { code: "CS0103", message: "The name 'missing' does not exist", line: 8, column: 38, retryable: true },
    ...Array.from({ length: 100 }, () => ({ code: "x".repeat(9000), message: "x".repeat(9000), line: { big: "x".repeat(9000) } }))
  ], iteration: { parent: { unbounded: "x".repeat(100000) } } });
  assert.deepEqual([view.diagnostics[0].code, view.diagnostics[0].line, view.diagnostics[0].column], ["CS0103", 8, 38]);
  assert.equal(view.diagnostics.length, 8);
  assert.equal(view.diagnostics[1].line, null);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 16000);
});

test("uncertain apply does not inherit rollback authority or trust a program success report", () => {
  const view: any = presentDynamicProgramResult({ execution_status: "failed", evidence: {
    applyReceipt: JSON.stringify({ outcome: "unknown", failure: "Receipt lost after dispatch" }),
    previewReceipt: JSON.stringify({ ok: true, rollback_truth: true }), workerOutput: { report: { Result: "Everything succeeded" } }
  } });
  assert.equal(view.failure, "Receipt lost after dispatch");
  assert.equal(view.execution_ok, false);
  assert.equal(view.native_apply.outcome, "unknown");
  assert.match(view.retry_policy, /uncertain apply requires authoritative reconciliation/);
  assert.equal(view.program_report_not_completion_evidence.Result, "Everything succeeded");
});

test("successful result is returned unchanged and malformed receipts cannot manufacture success", () => {
  const payload = { execution_status: "completed", report: { Count: "20" } };
  assert.equal(presentDynamicProgramResult(payload), payload);
  const view: any = presentDynamicProgramResult({ execution_status: "failed", evidence: { previewReceipt: "not JSON", applyReceipt: "x".repeat(1100000) } });
  assert.equal(view.execution_ok, false);
  assert.equal(view.native_preview.ok, false);
  assert.equal(view.native_apply.outcome, null);
});


test("partial output stays valid and explicitly unverified in the model-facing failure summary", () => {
  const partial = { authority: "diagnostic_only", partial: true, replayIndex: 0,
    report: { Notes: "x".repeat(1100) }, logs: [], omittedLogs: 2, omittedReportEntries: 4 };
  const view: any = presentDynamicProgramResult({ execution_status: "failed", diagnostics: [
    { code: "PROGRAM_EXCEPTION", message: "Missing flow.", severity: "error", line: 10, column: 9 },
    { code: "PROGRAM_PARTIAL_OUTPUT", message: JSON.stringify(partial), severity: "info", retryable: false }
  ] });
  assert.equal(view.execution_ok, false);
  assert.equal(view.diagnostics[1].severity, "info");
  assert.deepEqual(JSON.parse(view.diagnostics[1].message), partial);
  assert.match(view.guidance, /unverified program text/);
  assert.match(view.guidance, /not proof of inspected targets/);
  assert.equal(view.native_preview.ok, false);
  assert.deepEqual(view.program_report_not_completion_evidence, {});
});
