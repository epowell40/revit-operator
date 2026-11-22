import assert from "node:assert/strict";
import test from "node:test";
import { presentDynamicProgramResult } from "./dynamicProgramPresentation.js";

test("confirmed invalid-object rollback explains stable IDs; unknown or successful outcomes gain no repair hint", () => {
  const outcome = { persistent_effect: "none", native_transaction_state: "rolled_back",
    error: "The referenced object is not valid, possibly because it has been deleted from the database." };
  const value = { execution_lane: "native", requested_mode: "apply", execution_status: "failed", execution_ok: false,
    native_outcome: outcome, diagnostics: [] };
  const shown: any = presentDynamicProgramResult(value);
  assert.match(shown.guidance, /materialize.*ElementId/i);
  assert.match(shown.guidance, /IsValidObject/);
  assert.equal(shown.native_outcome.task_verified, false);
  for (const changed of [{ ...outcome, persistent_effect: "unknown" }, { ...outcome, native_transaction_state: "committed" },
    { ...outcome, error: "Unrelated parameter failure" }]) {
    assert.doesNotMatch(String(presentDynamicProgramResult({ ...value, native_outcome: changed }).guidance), /IsValidObject/);
  }
});

test("native reflection admission failure gives type-safe correction guidance without changing diagnostics", () => {
  const diagnostics = [{code:"POLICY_SOURCE_FORBIDDEN",phase:"source_admission",severity:"error",message:"Generated code may not use GetType(.",repair_action:"remove_forbidden_api"},
    {code:"POLICY_SYMBOL_FORBIDDEN",phase:"source_admission",severity:"error",message:"Generated code may not bind to System.Reflection.MemberInfo."}];
  const payload={execution_lane:"native",requested_mode:"apply",execution_status:"failed",execution_ok:false,native_outcome:null,diagnostics};
  const before=JSON.stringify(payload),view:any=presentDynamicProgramResult(payload);
  assert.match(view.guidance,/GetType\(\)\.Name/);assert.match(view.guidance,/is DetailCurve/);
  assert.deepEqual(view.diagnostics,diagnostics);assert.equal(view.execution_ok,false);assert.equal(view.native_outcome,null);assert.equal(JSON.stringify(payload),before);
});

test("confirmed native rollback points correction at observed identities instead of assuming unique endpoints", () => {
  const error="Expected one curve, found 2 at the requested endpoints";
  const view:any=presentDynamicProgramResult({execution_lane:"native",requested_mode:"apply",execution_status:"failed",execution_ok:false,
    native_outcome:{persistent_effect:"none",native_transaction_state:"rolled_back",error},diagnostics:[{code:"NATIVE_PROGRAM_FAILED",phase:"native",message:error}]});
  assert.match(view.guidance,/UniqueId/);assert.match(view.guidance,/coincident/);assert.match(view.guidance,/read-only/);
  assert.equal(view.native_outcome.error,error);assert.equal(view.native_outcome.task_verified,false);assert.equal(view.native_outcome.native_transaction_state,"rolled_back");
});

test("unknown native effect and unrelated compile errors do not acquire corrective retry guidance", () => {
  for(const native_outcome of [{persistent_effect:"unknown",native_transaction_state:"unknown"},null]){
    const view:any=presentDynamicProgramResult({execution_lane:"native",requested_mode:"apply",execution_status:"failed",execution_ok:false,native_outcome,
      diagnostics:[{code:"CS0103",phase:"compile",severity:"error",message:"Name missing"}]});
    assert.doesNotMatch(view.guidance,/is DetailCurve|coincident/);assert.equal(view.execution_ok,false);
  }
});

test("successful custom read presents the filtered answer without repeating thousands of input rows", () => {
  const payload = { requested_mode: "read", execution_status: "completed", execution_ok: true,
    report: { MatchingRooms: "20", MissingNames: "3", Scope: "Complete active-document category; missing names unknown; links excluded" },
    verification: { evidence_sha256: "sha256:" + "a".repeat(64) },
    evidence: { snapshotReceipt: JSON.stringify({ elements: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "Office", detail: "x".repeat(500) })) }) } };
  const original = JSON.stringify(payload);
  const view: any = presentDynamicProgramResult(payload);
  assert.deepEqual(view.report, payload.report);
  assert.equal(view.execution_ok, true);
  assert.equal(view.retained_evidence.evidence_sha256, payload.verification.evidence_sha256);
  assert.equal(view.evidence, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 3000);
  assert.equal(JSON.stringify(payload), original, "canonical evidence and original hash input remain unchanged");
});

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

test("wrong MEP connector owner redirects a confirmed rollback to compatible native tools", () => {
  const error = "The owner should be (flex) duct or pipe.\r\nParameter name: connector [Native C# last executed statement: submitted source line 1, column 389.]";
  const outcome = { persistent_effect: "none", native_transaction_state: "rolled_back", error };
  const diagnostics = [{ code: "NATIVE_PROGRAM_FAILED", phase: "native", message: error }];
  const payload = { execution_lane: "native", requested_mode: "apply", execution_status: "failed", execution_ok: false,
    native_outcome: outcome, diagnostics };
  const before = JSON.stringify(payload);
  const view = presentDynamicProgramResult(payload);
  assert.match(String(view.guidance), /NewTakeoffFitting.*air_terminal_on_duct/);
  assert.match(String(view.guidance), /inspect.*connector.*rigid duct/i);
  assert.doesNotMatch(String(view.guidance), /coincident curves/);
  assert.deepEqual(view.diagnostics, diagnostics);
  assert.equal(JSON.stringify(payload), before);

  const rejected = [
    { ...payload, native_outcome: { ...outcome, persistent_effect: "unknown" } },
    { ...payload, native_outcome: { ...outcome, native_transaction_state: "committed" } },
    { ...payload, native_outcome: { ...outcome, error: "The owner should be (flex) duct or pipe. Parameter name: main" } },
    { ...payload, requested_mode: "read" },
    { ...payload, execution_status: "completed", execution_ok: true },
  ];
  for (const input of rejected) {
    assert.doesNotMatch(String(presentDynamicProgramResult(input).guidance), /air_terminal_on_duct/);
  }
});
