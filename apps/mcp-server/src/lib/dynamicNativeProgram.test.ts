import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeNativeProgram, readNativeProgramEvidence, NATIVE_PROGRAM_EVIDENCE_MAX_BYTES } from "./dynamicNativeProgram.js";
import { runDynamicRevitProgram, projectNativeFailureIdentity } from "./dynamicRevitProgramRunner.js";
import { presentDynamicProgramResult } from "./dynamicProgramPresentation.js";
import { DYNAMIC_REVIT_NATIVE_GUIDE } from "./dynamicRevitSdkGuide.js";
import { runWithRevitToolAlias } from "./toolExposurePolicy.js";
import { isCanonicalNativeAffectedTargetSetV2 } from "@revitoperator/assignment-kernel-v2-contracts";
import { runWithAssignmentKernelV2, decorateAssignmentKernelMcpResultV2, ASSIGNMENT_KERNEL_V2_META_KEY,
  ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA } from "./assignmentKernelV2.js";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const source = "public static class Query { public static string Execute(Autodesk.Revit.DB.Document doc) { return doc.Title; } }";
const sourceHash = hash(source), fingerprint = hash("document");

test("native source guide explains static fields without initializers and conservative source-step feedback",()=>{
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/static fields.*without initializers/i);
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/last executed source step/i);
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/not.*exact failing/i);
});
test('native drafting guide avoids unsupported DetailCurve class filters and cross-kind replacement',()=>{
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/OfClass\(typeof\(CurveElement\)\).*OfType<DetailCurve>/);
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/SetGeometryCurve.*same curve kind/);
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/different curve kind.*replace only the confirmed element/);
});
test('native apply guide prevents an oversized all-element return from rolling back useful construction',()=>{
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/BOTH read and apply.*32768characters.*apply rolls back/);
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/component counts, representative actual Element.UniqueIds/);
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/focused reads.*report omitted counts/);
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE,/Unknown effects require reconciliation/);
});
const env = { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" };
type RecordValue = Record<string, any>;

test("native compile refusal delivers source coordinates without a fabricated native outcome or retry authority", () => {
  const diagnostics = [{ code: "NATIVE_SOURCE_LIFECYCLE", message: "Static field 'document' retains process-wide state, even without an initializer. Use instance or local state; the public Execute entry remains static.",
    phase: "native_compile", severity: "error", repair_action: "edit_source", line: 3, column: 2, end_line: 3, end_column: 27, retryable: true }];
  const visible = presentDynamicProgramResult({ schema: "revit-operator.dynamic-revit-program-run.v1", run_id: "compile-refusal", requested_mode: "apply", execution_lane: "native", execution_status: "failed", execution_ok: false,
    native_outcome: null, diagnostics, verification: { evidence_sha256: hash("retained failure") } });
  assert.deepEqual(visible.diagnostics, diagnostics);
  assert.equal(visible.native_outcome, null); assert.equal(visible.execution_ok, false);
  assert.deepEqual(visible.affected_target_identities, []);
  assert.doesNotMatch(String(visible.guidance), /Confirmed rollback/);
  assert.match(String(visible.guidance), /Do not retry unknown effects/);
});

// Retained reconstruction failure: the body compiled and ran, then the host
// verified rollback because implicit Revit owners were outside the scope.
const collateralFailure = "Native program exceeded its admitted effects: existing_element_out_of_scope: native-api-mutation-ops affected existing elements outside transaction.allowedExistingElementIds: 101014,378358,669230,731023,1321945,1420970,1422218,1488968,1521719,1521731; this rejection requires verified failure-processing rollback.";

function fixture(mode: "read" | "apply", state = mode === "read" ? "not_started" : "committed", success = true) {
  const preparation = { Schema: "dynamic-revit-native-preparation/v1", PreparationId: "nativeprogram_test", SourceHash: sourceHash,
    Document: { ProjectFingerprint: fingerprint, SessionId: "session", Title: "Fixture" },
    Scope: { DocumentFingerprint: fingerprint, DocumentSessionId: "session", DocumentRevision: 3 } };
  const committed = state === "committed" ? true : ["not_started", "rolled_back"].includes(state) ? false : null;
  const receipt: RecordValue = { schema: "dynamic-revit-native-execution-receipt/v1", preparation_id: preparation.PreparationId,
    source_hash: sourceHash, assembly_hash: hash("assembly"), native_binding_hash: hash("native-binding"), document_fingerprint: fingerprint,
    document_session_id: "session", document_revision_before: 3, success, verified: false, retry_permitted: false,
    ...(mode === "read" ? { read_only: true } : {}), ...(success ? { program_result: '{"matchingRooms":3}' } : { error: "body/cleanup failed" }),
    transaction: { status: state, committed, affected_element_ids: committed ? [42] : [], added_element_ids: [],
      modified_element_ids: committed ? [42] : [], deleted_element_ids: [] } };
  const evidence: RecordValue = { schema: "dynamic-revit-native-program-evidence/v1", ok: success, snapshotReceipt: JSON.stringify(preparation),
    nativeExecutionReceipt: JSON.stringify(receipt), admission: { runtimeInstanceId: "runtime", operationGraphHash: hash("native-binding"),
      sourceHash, programHash: hash("assembly"), documentFingerprint: fingerprint, documentSessionId: "session" },
    workerOutput: { ok: true, executionStatus: "compiled_native", executionElapsedMs: 0, sourceHash, programHash: hash("assembly"),
      nativeProgramArtifact: { sourceHash, assemblyHash: hash("assembly"), mode: mode === "read" ? "read" : "write" }, diagnostics: [],
      diagnosticBundleHash: hash("dynamic-revit-worker-diagnostics/v1\n") },
    hostAuthenticationReceipts: [] };
  authenticate(evidence);
  return evidence;
}

function authenticate(evidence: RecordValue) {
  evidence.hostAuthenticationReceipts = [JSON.stringify({ schema: "dynamic-revit-bootstrap-receipt/v0", ok: true, runtimeInstanceId: "runtime" }),
    ...[["native-program-prepare-receipt", evidence.snapshotReceipt], ["native-program-execute-receipt", evidence.nativeExecutionReceipt]].map(([purpose, raw]) =>
      JSON.stringify({ schema: "dynamic-revit-authenticated-receipt/v0", runtime_instance_id: "runtime", purpose, receipt_hash: hash(raw),
        host_receipt_mac: "hmac-sha256:" + "f".repeat(64), receipt: JSON.parse(raw) }))];
}

function largeAuthenticatedEvidence(state = "committed", success = true) {
  const evidence = fixture("apply", state, success);
  const receipt = JSON.parse(evidence.nativeExecutionReceipt);
  // A native post-state inventory can exceed 2 MiB while the entire signed
  // evidence (including its second authenticated copy) remains below 8 MiB.
  receipt.effect_observation = { states: Array.from({ length: 900 }, (_, id) =>
    ({ element_id: id + 1, retained_properties: "x".repeat(2400) })) };
  evidence.nativeExecutionReceipt = JSON.stringify(receipt);
  authenticate(evidence);
  assert(Buffer.byteLength(evidence.nativeExecutionReceipt) > 2 * 1024 * 1024);
  assert(Buffer.byteLength(JSON.stringify(evidence)) < NATIVE_PROGRAM_EVIDENCE_MAX_BYTES);
  return evidence;
}

test("native receipts within the total transport budget preserve commit, rollback and unknown without granting verification", () => {
  for (const [state, success, effect] of [["committed", true, "applied"], ["rolled_back", false, "none"], ["pending", false, "unknown"]] as const) {
    const evidence = largeAuthenticatedEvidence(state, success);
    const result = readNativeProgramEvidence(evidence, sourceHash, "apply", fingerprint)!;
    assert.equal(result.effect, effect);
    assert.equal(result.receipt.verified, false);
    assert.equal(result.receipt.retry_permitted, false);
  }
});

test("large native receipts still reject substituted bodies, foreign bindings, malformed JSON and aggregate byte overflow", () => {
  const evidence = largeAuthenticatedEvidence();
  assert.throws(() => readNativeProgramEvidence(evidence, hash("foreign-source"), "apply", fingerprint), /binding/);
  assert.throws(() => readNativeProgramEvidence(evidence, sourceHash, "apply", hash("foreign-document")), /binding/);
  const substituted = { ...evidence, nativeExecutionReceipt: evidence.nativeExecutionReceipt.replace('"document_revision_before":3', '"document_revision_before":4') };
  assert.throws(() => readNativeProgramEvidence(substituted, sourceHash, "apply", fingerprint), /binding/);
  const tampered = { ...evidence, nativeExecutionReceipt: evidence.nativeExecutionReceipt.replace('"element_id":1,', '"element_id":999,') };
  assert.throws(() => readNativeProgramEvidence(tampered, sourceHash, "apply", fingerprint), /authenticated receipt/);
  assert.throws(() => readNativeProgramEvidence({ ...evidence, nativeExecutionReceipt: "{" }, sourceHash, "apply", fingerprint), SyntaxError);
  const oversized = { ...evidence, padding: "界".repeat(2 * 1024 * 1024) };
  assert(JSON.stringify(oversized).length < NATIVE_PROGRAM_EVIDENCE_MAX_BYTES, "UTF-16 count alone would accept this fixture");
  assert.throws(() => readNativeProgramEvidence(oversized, sourceHash, "apply", fingerprint), /transport byte budget/);
});

test("large authenticated native result crosses the runner and model-visible consumer without exposing its audit payload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-receipt-budget-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), worker = path.join(root, "worker"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.mkdirSync(worker); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const evidence = largeAuthenticatedEvidence();
    await runWithAssignmentKernelV2(metadata("apply"), async () => {
      const result = await runDynamicRevitProgram({ source, mode: "apply", native_program: { entry_type: "Query",
        allowed_existing_unique_ids: ["uid"] } }, runtime, async (_exe, args) => {
        fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(evidence));
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      assert.equal(result.canonical_attempt_settlement?.effect_state, "applied");
      const visible: any = presentDynamicProgramResult(result);
      assert.equal(visible.native_outcome.task_verified, false);
      assert.equal(visible.native_outcome.program_result, '{"matchingRooms":3}');
      assert.equal(result.iteration.retryable, false);
      assert.equal(visible.evidence, undefined);
      assert(Buffer.byteLength(JSON.stringify(visible)) < 32768);
      const decorated: any = decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: JSON.stringify(visible) }] }, "operator_run_dynamic_revit_program");
      assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "applied");
      assert.equal(decorated.structuredContent.operation_result_v2.native_transaction_state, "committed");
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("source-step error context reaches the actor without altering native rollback, commit or unknown outcomes",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-source-step-'));
  try {
    const supervisor=path.join(root,'supervisor.exe'),worker=path.join(root,'worker'),token=path.join(root,'token');
    fs.writeFileSync(supervisor,'stub');fs.mkdirSync(worker);fs.writeFileSync(token,'0123456789abcdef');
    const runtime={...env,OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH:supervisor,OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY:worker,OPERATOR_TOKEN_FILE:token};
    const message='Last executed generated source step: line 6, column 4. This is diagnostic context, not proof of the exact failing expression or native outcome. Object reference not set to an instance of an object.';
    for(const [state,effect]of [['rolled_back','none'],['committed','applied'],['pending','unknown']]){
      const evidence=fixture('apply',state!,false),receipt=JSON.parse(evidence.nativeExecutionReceipt);
      receipt.error=message;evidence.nativeExecutionReceipt=JSON.stringify(receipt);authenticate(evidence);
      await runWithAssignmentKernelV2(metadata('apply'),async()=>{
        const result=await runDynamicRevitProgram({source,mode:'apply',native_program:{entry_type:'Query',allow_create:true,allowed_existing_unique_ids:[],max_affected_elements:20}},runtime,async(_exe,args)=>{
          fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!,'utf8')).evidencePath,JSON.stringify(evidence));return{exitCode:1,stdout:'',stderr:''};
        });
        const visible:any=presentDynamicProgramResult(result);
        assert.equal(visible.diagnostics.find((d:any)=>d.code==='NATIVE_PROGRAM_FAILED').message,message);
        assert.equal(result.canonical_attempt_settlement?.effect_state,effect);
        assert.equal(visible.native_outcome.task_verified,false);assert.equal(result.iteration.retryable,false);
        assert.equal((result.evidence as RecordValue).nativeExecutionReceipt,evidence.nativeExecutionReceipt);
      });
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test("document-scoped authenticated audit accepts unpredicted changes without granting result verification", () => {
  const e = fixture("apply", "committed", true);
  const preparation = JSON.parse(e.snapshotReceipt);
  preparation.Scope.EffectScope = "active_document";
  preparation.Scope.AllowedExistingElementIds = []; preparation.Scope.MaxAffectedElements = 0; preparation.Scope.AllowCreate = false;
  e.snapshotReceipt = JSON.stringify(preparation);
  const receipt = JSON.parse(e.nativeExecutionReceipt); receipt.effect_scope = "active_document";
  const ids = Array.from({ length: 122 }, (_, i) => i + 1);
  receipt.transaction.affected_element_ids = ids; receipt.transaction.modified_element_ids = ids;
  e.nativeExecutionReceipt = JSON.stringify(receipt); authenticate(e);
  const outcome = readNativeProgramEvidence(e, sourceHash, "apply", fingerprint)!;
  assert.equal(outcome.effect, "applied"); assert.equal(outcome.affectedTargetIdentities.length, 122);
  assert.equal(outcome.receipt.verified, false); assert.equal(outcome.receipt.retry_permitted, false);
  for (const change of ["mismatch", "oversize", "read"]) {
    const bad = structuredClone(e), r = JSON.parse(bad.nativeExecutionReceipt);
    if (change === "mismatch") r.effect_scope = "listed_elements";
    if (change === "oversize") r.transaction.affected_element_ids = Array.from({ length: 4097 }, (_, i) => i + 1);
    bad.nativeExecutionReceipt = JSON.stringify(r); authenticate(bad);
    assert.throws(() => readNativeProgramEvidence(bad, sourceHash, change === "read" ? "read" : "apply", fingerprint));
  }
});

test("authenticated native rollback reports its actual cause without inventing a supervisor failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-rollback-diagnostic-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), worker = path.join(root, "worker"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.mkdirSync(worker); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...process.env, ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    for (const supervisorFailure of [false, true]) for (const failure of [collateralFailure,
      "Value cannot be null. [Native C# last executed statement: submitted source line 1, column 5125. This is a repair hint, not an exact throw-site or model-result check.]"]) {
      const e = fixture("apply", "rolled_back", false);
      const receipt = JSON.parse(e.nativeExecutionReceipt); receipt.error = failure;
      e.nativeExecutionReceipt = JSON.stringify(receipt); authenticate(e);
      if (supervisorFailure) e.failure = "Supervisor cleanup failed";
      await runWithAssignmentKernelV2(metadata("apply"), async () => {
        const result = await runDynamicRevitProgram({ source, mode: "apply", native_program: { entry_type: "Query", allow_create: true,
          allowed_existing_unique_ids: [], max_affected_elements: 20 } }, runtime, async (_exe, args) => {
          fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(e));
          return { exitCode: 1, stdout: "", stderr: supervisorFailure ? "cleanup failed" : "" };
        });
        assert.equal(result.diagnostics.some(d => d.code === "SUPERVISOR_FAILURE"), supervisorFailure);
        assert.equal(result.diagnostics.find(d => d.code === "NATIVE_PROGRAM_FAILED")?.message, failure);
        assert.equal(result.canonical_attempt_settlement?.effect_state, "none");
        assert.equal(result.iteration.retryable, false);
        const view: any = presentDynamicProgramResult(result);
        assert.equal(view.diagnostics.find((d: any) => d.code === "NATIVE_PROGRAM_FAILED")?.message, failure);
        assert.equal(view.native_outcome.native_transaction_state, "rolled_back");
        assert.match(view.guidance, /fresh request/);
        assert.match(view.guidance, /not automatically authorize/);
      });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("authenticated warning rollback exposes bounded native cause to the actor without retry authority", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-warning-rollback-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), worker = path.join(root, "worker"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.mkdirSync(worker); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const warning = "Instance origin does not lie on host face. Instance will lose association to host.";
    const e = fixture("apply", "rolled_back", false), receipt = JSON.parse(e.nativeExecutionReceipt);
    receipt.error = "Native program inner transaction did not commit: RolledBack";
    receipt.native_failures = Array.from({ length: 12 }, (_, index) => ({ severity: "warning", message: warning + " ".repeat(index),
      elementIds: [71], failureDefinitionId: "c4e32a23-52e6-455b-949d-89e0c4eb78ab" }));
    e.nativeExecutionReceipt = JSON.stringify(receipt); authenticate(e);
    await runWithAssignmentKernelV2(metadata("apply"), async () => {
      const result = await runDynamicRevitProgram({ source, mode: "apply", native_program: { entry_type: "Query", allow_create: true,
        allowed_existing_unique_ids: [], max_affected_elements: 20 } }, runtime, async (_exe, args) => {
        fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(e));
        return { exitCode: 1, stdout: "", stderr: "" };
      });
      const visible: any = presentDynamicProgramResult(result);
      assert.equal(result.canonical_attempt_settlement?.effect_state, "none");
      assert.equal(visible.native_outcome.native_transaction_state, "rolled_back");
      assert.equal(visible.native_outcome.task_verified, false);
      assert.equal(visible.diagnostics.filter((d: any) => d.code === "NATIVE_MODEL_WARNING").length, 6);
      assert.match(visible.diagnostics.find((d: any) => d.code === "NATIVE_MODEL_WARNING").message, /Instance origin does not lie on host face/);
      assert.deepEqual(visible.diagnostics.find((d: any) => d.code === "NATIVE_MODEL_WARNING").native_failure?.element_ids, [71]);
      assert.equal(visible.diagnostics.find((d: any) => d.code === "NATIVE_MODEL_WARNING").native_failure?.reported_element_count, 1);
      assert.equal(visible.diagnostics.find((d: any) => d.code === "NATIVE_MODEL_WARNING").native_failure?.complete, true);
      assert.match(visible.diagnostics.find((d: any) => d.code === "NATIVE_FAILURES_OMITTED").message, /6 additional/);
      assert.equal(result.iteration.retryable, false);
      assert.deepEqual((result.evidence as RecordValue).nativeExecutionReceipt, e.nativeExecutionReceipt);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("duplicate Type Mark repair retains the actual reported type pairs through model-visible feedback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-warning-identities-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), worker = path.join(root, "worker"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.mkdirSync(worker); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    // Retained native warning pairs: earlier roof/wall/floor types, NOT the
    // window/door types the actor tried to repair from message-only feedback.
    const pairs = [[224, 1200228], [441451, 1200224], [441472, 1200226]];
    const definition = "6e1efefe-c8e0-483d-8482-150b9f1da21a";
    const e = fixture("apply", "rolled_back", false), receipt = JSON.parse(e.nativeExecutionReceipt);
    receipt.native_failures = pairs.map(elementIds => ({ severity: "warning",
      message: 'Elements have duplicate "Type Mark" values.', elementIds, failureDefinitionId: definition }));
    e.nativeExecutionReceipt = JSON.stringify(receipt); authenticate(e);
    await runWithAssignmentKernelV2(metadata("apply"), async () => {
      const result = await runDynamicRevitProgram({ source, mode: "apply", native_program: { entry_type: "Query", allow_create: true,
        allowed_existing_unique_ids: [], max_affected_elements: 20 } }, runtime, async (_exe, args) => {
        fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(e));
        return { exitCode: 1, stdout: "", stderr: "" };
      });
      const visible: any = presentDynamicProgramResult(result);
      const warnings = visible.diagnostics.filter((d: any) => d.code === "NATIVE_MODEL_WARNING");
      assert.deepEqual(warnings.map((d: any) => d.native_failure?.element_ids), pairs);
      for (const d of warnings) {
        assert.equal(d.native_failure.failure_definition_id, definition);
        assert.equal(d.native_failure.reported_element_count, 2);
        assert.equal(d.native_failure.complete, true);
        assert.match(d.native_failure.usage, /attempt-time/);
        assert.match(d.native_failure.usage, /not authorize/);
      }
      assert.equal(result.canonical_attempt_settlement?.effect_state, "none");
      assert.equal(result.iteration.retryable, false);
      assert.deepEqual(visible.affected_target_identities, []);
      assert.equal(visible.native_outcome.task_verified, false);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failure identity projection bounds work and distinguishes absent malformed and truncated IDs", () => {
  assert.equal(projectNativeFailureIdentity({}).reported_element_count, null);
  assert.equal(projectNativeFailureIdentity({}).complete, false);
  assert.equal(projectNativeFailureIdentity({elementIds: []}).complete, true);
  const malformed = projectNativeFailureIdentity({elementIds: [1, "2", null, NaN, Infinity, -1, 2.5, Number.MAX_SAFE_INTEGER + 1], failureDefinitionId: "not a guid"});
  assert.deepEqual(malformed.element_ids, [1]); assert.equal(malformed.complete, false);
  assert.equal(malformed.reported_element_count, 8); assert.equal(malformed.failure_definition_id, null);
  const many = projectNativeFailureIdentity({elementIds: Array.from({length: 5000}, (_, i) => i + 1)});
  assert.equal(many.returned_element_count, 16); assert.equal(many.reported_element_count, 5000);
  assert.equal(many.complete, false);
});

test("warning details cannot override committed or unknown native effects and stay receipt-bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-warning-effects-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), worker = path.join(root, "worker"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.mkdirSync(worker); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    for (const [state, effect] of [["committed", "applied"], ["pending", "unknown"]]) {
      const e = fixture("apply", state, state === "committed"), receipt = JSON.parse(e.nativeExecutionReceipt);
      receipt.native_failures = [{ severity: "warning", message: "W".repeat(5000) }, null];
      e.nativeExecutionReceipt = JSON.stringify(receipt); authenticate(e);
      await runWithAssignmentKernelV2(metadata("apply"), async () => {
        const execute = async (_exe: string, args: string[]) => {
          fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(e));
          return { exitCode: state === "committed" ? 0 : 1, stdout: "", stderr: "" };
        };
        const input = { source, mode: "apply" as const, native_program: { entry_type: "Query", allow_create: true,
          allowed_existing_unique_ids: [], max_affected_elements: 20 } };
        const result = await runDynamicRevitProgram(input, runtime, execute);
        const visible: any = presentDynamicProgramResult(result);
        assert.equal(result.canonical_attempt_settlement?.effect_state, effect);
        assert.equal(visible.diagnostics.find((d: any) => d.code === "NATIVE_MODEL_WARNING").message.length, 1000);
        assert.match(visible.diagnostics.find((d: any) => d.code === "NATIVE_MODEL_FAILURE").message, /detail unavailable/);
        assert.doesNotMatch(visible.guidance, /Confirmed rollback/);
        receipt.native_failures[0].message = "Substituted warning text";
        e.nativeExecutionReceipt = JSON.stringify(receipt); // Deliberately do not authenticate changed bytes.
        assert.throws(() => readNativeProgramEvidence(e, sourceHash, "apply", fingerprint), /authenticated receipt/);
        receipt.native_failures[0].message = "W".repeat(5000);
        receipt.native_failures[0].elementIds = [99999];
        e.nativeExecutionReceipt = JSON.stringify(receipt);
        assert.throws(() => readNativeProgramEvidence(e, sourceHash, "apply", fingerprint), /authenticated receipt/);
      });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native failure locations are bounded diagnostic observations, with unknown and malformed coverage explicit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-failure-locations-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), worker = path.join(root, "worker"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.mkdirSync(worker); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...process.env, ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const cases = [
      { raw: Array.from({ length: 40 }, (_, i) => i + 1), count: 40, ids: Array.from({ length: 16 }, (_, i) => i + 1), complete: false },
      { raw: [71, 71, 0, -1, "72", 42], count: 6, ids: [71, 71, 42], complete: false },
      { raw: null, count: null, ids: [], complete: false },
      { raw: [], count: 0, ids: [], complete: true },
      { raw: [Number.MAX_SAFE_INTEGER + 1], count: 1, ids: [], complete: false }
    ];
    for (const state of ["rolled_back", "pending"]) for (const item of cases) {
      const e = fixture("apply", state, false), receipt = JSON.parse(e.nativeExecutionReceipt);
      receipt.native_failures = [{ severity: "error", message: "Can't keep elements joined.",
        elementIds: item.raw, failureDefinitionId: "not-a-guid" }];
      e.nativeExecutionReceipt = JSON.stringify(receipt); authenticate(e);
      const original = e.nativeExecutionReceipt;
      await runWithAssignmentKernelV2(metadata("apply"), async () => {
        const result = await runDynamicRevitProgram({ source, mode: "apply", native_program: { entry_type: "Query", allow_create: true,
          allowed_existing_unique_ids: [], max_affected_elements: 20 } }, runtime, async (_exe, args) => {
          fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(e));
          return { exitCode: 1, stdout: "", stderr: "" };
        });
        const visible: any = presentDynamicProgramResult(result);
        const diagnostic = visible.diagnostics.find((d: any) => d.code === "NATIVE_MODEL_FAILURE").native_failure;
        assert.deepEqual(diagnostic.element_ids, item.ids);
        assert.equal(diagnostic.reported_element_count, item.count);
        assert.equal(diagnostic.complete, item.complete);
        assert.equal(diagnostic.failure_definition_id, null);
        assert.match(diagnostic.usage, /not verified current elements/);
        assert.match(diagnostic.usage, /does not authorize edits or retries/);
        assert.equal(visible.native_outcome.task_verified, false);
        assert.equal(visible.native_outcome.persistent_effect, state === "pending" ? "unknown" : "none");
        assert.deepEqual(visible.affected_target_identities, []);
        assert.equal(result.iteration.retryable, false);
        assert.equal((result.evidence as RecordValue).nativeExecutionReceipt, original);
      });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a joined-wall insert rollback guides bounded recovery from the current wall", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "joined-wall-rollback-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), worker = path.join(root, "worker"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.mkdirSync(worker); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...process.env, ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const definition = "7240576f-66ca-40e7-bc79-be5af5f891f5";
    const cases = [
      { state: "rolled_back", definition, ids: [571265, 571317], cue: true },
      { state: "pending", definition, ids: [571265, 571317], cue: false },
      { state: "committed", definition, ids: [571265, 571317], cue: false },
      { state: "rolled_back", definition, ids: [571265, "571317"], cue: false },
      { state: "rolled_back", definition: "abcdefab-66ca-40e7-bc79-be5af5f891f5", ids: [571265, 571317], cue: false }
    ];
    for (const entry of cases) {
      const committed = entry.state === "committed";
      const evidence = fixture("apply", entry.state, committed), receipt = JSON.parse(evidence.nativeExecutionReceipt);
      receipt.native_failures = [{ severity: "warning", message: "Insert conflicts with joined Wall.",
        elementIds: entry.ids, failureDefinitionId: entry.definition }];
      evidence.nativeExecutionReceipt = JSON.stringify(receipt);
      authenticate(evidence);
      await runWithAssignmentKernelV2(metadata("apply"), async () => {
        const result = await runDynamicRevitProgram({ source, mode: "apply", native_program: { entry_type: "Query", allow_create: true,
          allowed_existing_unique_ids: [], max_affected_elements: 20 } }, runtime, async (_exe, args) => {
          fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(evidence));
          return { exitCode: committed ? 0 : 1, stdout: "", stderr: "" };
        });
        const visible: any = presentDynamicProgramResult(result);
        if (entry.cue) {
          assert.match(visible.guidance, /separate bounded batches/);
          assert.match(visible.guidance, /full opening width/);
          assert.match(visible.guidance, /attempt-time IDs/);
          assert.doesNotMatch(visible.guidance, /For a curve correction/);
        } else {
          assert.doesNotMatch(visible.guidance, /separate bounded batches/);
        }
        assert.equal(result.iteration.retryable, false);
        assert.equal(visible.native_outcome.task_verified, false);
        assert.equal((result.evidence as RecordValue).nativeExecutionReceipt, evidence.nativeExecutionReceipt);
      });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native correction guidance never turns unknown, committed, missing or read outcomes into rollback recovery", () => {
  for (const [mode, state, effect] of [["apply", "unknown", "unknown"], ["apply", "committed", "applied"],
    ["apply", "rolled_back", "unknown"], ["read", "not_started", "none"], ["apply", "not_started", "none"]]) {
    const view: any = presentDynamicProgramResult({ execution_lane: "native", requested_mode: mode,
      execution_status: "failed", execution_ok: false, native_outcome: { native_transaction_state: state, persistent_effect: effect } });
    assert.doesNotMatch(view.guidance, /Confirmed rollback/);
    assert.equal(view.native_outcome.task_verified, false);
  }
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE, /Creating new elements can also modify existing/);
  assert.match(DYNAMIC_REVIT_NATIVE_GUIDE, /not permission/);
});

// Numeric native receipt order differs from canonical string identity order.
// This footprint reproduces a retained committed reconstruction write.
const mixedWidthTargets = [101014, 378358, 669230, 731023, 1321945, 1542953, 1542954, 1542955,
  1542956, 1542957, 1542958, 1542960, 1542961, 1542963, 1542964, 1542965, 1542966];
function withAffected(evidence: RecordValue, ids: number[]) {
  const receipt = JSON.parse(evidence.nativeExecutionReceipt);
  receipt.transaction.affected_element_ids = ids;
  if (receipt.transaction.committed === true) receipt.transaction.modified_element_ids = ids;
  evidence.nativeExecutionReceipt = JSON.stringify(receipt); authenticate(evidence); return evidence;
}

test("native affected identities canonicalize mixed-width IDs without changing authenticated receipts or effect truth", () => {
  for (const [state, effect] of [["committed", "applied"], ["rolled_back", "none"], ["pending", "unknown"]]) {
    for (const ids of [mixedWidthTargets, [...mixedWidthTargets].reverse(), [7, 42], [42]]) {
      const e = withAffected(fixture("apply", state, state === "committed"), ids), original = JSON.stringify(e);
      const result = readNativeProgramEvidence(e, sourceHash, "apply", fingerprint)!;
      assert.deepEqual(result.affectedTargetIdentities, ids.map(id => `element_id:${id}`).sort());
      assert(isCanonicalNativeAffectedTargetSetV2(result.affectedTargetIdentities));
      assert.equal(result.effect, effect); assert.equal(JSON.stringify(e), original, "raw authenticated evidence remains unchanged");
    }
  }
  for (const ids of [[7, 7], [0], [-1], [1.5], Array.from({ length: 65 }, (_, i) => i + 1)])
    assert.throws(() => readNativeProgramEvidence(withAffected(fixture("apply"), ids), sourceHash, "apply", fingerprint), /identities/);
});

test("native mixed-width affected set reaches the model and canonical MCP consumer without asserting verification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-ordinal-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...process.env, ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: root, OPERATOR_TOKEN_FILE: token };
    const e = withAffected(fixture("apply"), mixedWidthTargets);
    const output: any = await runWithAssignmentKernelV2(metadata("apply"), async () => {
      const result = await runDynamicRevitProgram({ source, mode: "apply", native_program: { entry_type: "Query", allowed_existing_unique_ids: ["uid"] } }, runtime,
        async (_exe, args) => { fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(e)); return { exitCode: 0, stdout: "", stderr: "" }; });
      return decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: JSON.stringify(presentDynamicProgramResult(result)) }] }, "operator_run_dynamic_revit_program");
    });
    const op = output.structuredContent.operation_result_v2, visible = JSON.parse(output.content[0].text);
    assert(isCanonicalNativeAffectedTargetSetV2(op.affected_target_identities));
    assert.deepEqual(op.affected_target_identities, mixedWidthTargets.map(id => `element_id:${id}`).sort());
    assert.deepEqual(visible.affected_target_identities, op.affected_target_identities);
    assert.equal(op.persistent_effect, "applied"); assert.equal(op.authority, "native-host");
    assert.equal(visible.native_outcome.task_verified, false); assert.equal(visible.native_outcome.verification_required, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("native C# is available to ordinary local and self-hosted general tools without laboratory opt-in", () => {
  for (const runtime of [{ REVIT_OPERATOR_MODE: "local", OPERATOR_TOOL_EXPOSURE_PROFILE: "general" },
    { REVIT_OPERATOR_MODE: "self_hosted", OPERATOR_TOOL_EXPOSURE_PROFILE: "general" }]) {
    assert.equal(normalizeNativeProgram({ entry_type: "Query" }, "read", "2024", fingerprint, runtime).program.mode, "read");
    assert.equal(normalizeNativeProgram({ entry_type: "Edit", allowed_existing_unique_ids: ["uid"] }, "apply", "2024", fingerprint, runtime).program.mode, "write");
  }
  for (const runtime of ["hosted", "production"]) {
    assert.equal(normalizeNativeProgram({ entry_type: "Query" }, "read", "2024", fingerprint,
      { REVIT_OPERATOR_MODE: runtime, OPERATOR_REVIT_TRANSPORT: "courier" }).program.mode, "read");
    assert.equal(normalizeNativeProgram({ entry_type: "Edit", allowed_existing_unique_ids: ["uid"] }, "apply", "2024", fingerprint,
      { REVIT_OPERATOR_MODE: runtime, OPERATOR_REVIT_TRANSPORT: "courier" }).program.mode, "write");
  }
  for (const runtime of [{}, { REVIT_OPERATOR_MODE: "local" },
    { REVIT_OPERATOR_MODE: "local", OPERATOR_TOOL_EXPOSURE_PROFILE: "certified" },
    { REVIT_OPERATOR_MODE: "local", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "hosted", OPERATOR_TOOL_EXPOSURE_PROFILE: "general" },
    { REVIT_OPERATOR_MODE: "production", OPERATOR_TOOL_EXPOSURE_PROFILE: "general" },
    { REVIT_OPERATOR_MODE: "Local" }, { REVIT_OPERATOR_MODE: "local " },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "general" }
  ]) assert.throws(() => normalizeNativeProgram({ entry_type: "Query" }, "read", "2024", fingerprint, runtime));
});

test("native request keeps one read/write tool, bounded scope and host-issued document identity", () => {
  assert.deepEqual(normalizeNativeProgram({ entry_type: "Query" }, "read", "2024", fingerprint, env).program,
    { entryType: "Query", mode: "read", allowedExistingUniqueIds: [], allowCreate: false, maxAffectedElements: 0, deadlineMs: 5000 });
  assert.equal(normalizeNativeProgram({ entry_type: "Query", allowed_existing_unique_ids: ["uid"] }, "apply", "2024", fingerprint.slice(7), env).program.mode, "write");
  for (const change of [{ allow_create: true }, { max_affected_elements: 1 }, { allowed_existing_unique_ids: ["uid"] }, { deadline_ms: 10001 },
    { deadline_ms: 0 }, { entry_type: "" }, { extra: true }])
    assert.throws(() => normalizeNativeProgram({ entry_type: "Query", ...change }, "read", "2024", fingerprint, env));
  for (const ids of [[], ["uid", "uid"], Array.from({ length: 65 }, (_, i) => String(i))])
    assert.throws(() => normalizeNativeProgram({ entry_type: "Query", allowed_existing_unique_ids: ids }, "apply", "2024", fingerprint, env));
  for (const [mode, year, doc, runtime] of [["preview", "2024", fingerprint, env], ["read", "2022", fingerprint, env],
    ["read", "2024", undefined, env], ["read", "2024", fingerprint, { ...env, REVIT_OPERATOR_MODE: "hosted" }]] as const)
    assert.throws(() => normalizeNativeProgram({ entry_type: "Query" }, mode, year, doc, runtime));
});

test("native receipt retains successful read, committed failure, rollback and unknown separately from program prose", () => {
  const read = readNativeProgramEvidence(fixture("read"), sourceHash, "read", fingerprint)!;
  assert.equal(read.effect, "none"); assert.equal(read.result, '{"matchingRooms":3}');
  for (const [state, effect] of [["committed", "applied"], ["rolled_back", "none"], ["not_started", "none"], ["pending", "unknown"]]) {
    const result = readNativeProgramEvidence(fixture("apply", state, false), sourceHash, "apply", fingerprint)!;
    assert.equal(result.effect, effect); assert.equal(result.result, null);
    assert.equal(result.transactionState, state === "pending" ? "unknown" : state);
  }
  assert.equal(readNativeProgramEvidence({ ok: false }, sourceHash, "apply", fingerprint), null);
  assert.throws(() => readNativeProgramEvidence({ ok: true }, sourceHash, "apply", fingerprint), /no native/);
});

test("native model-visible boundary rejects altered source, receipt, document, authentication and transaction contradictions", () => {
  const cases: Array<(e: RecordValue) => void> = [
    e => { e.workerOutput.executionStatus = "completed"; }, e => { e.workerOutput.executionElapsedMs = 1; },
    e => { e.admission.documentSessionId = "foreign"; }, e => { e.admission.runtimeInstanceId = "foreign"; },
    e => { e.workerOutput.sourceHash = hash("foreign"); }, e => { e.workerOutput.nativeProgramArtifact.mode = "write"; },
    e => { e.hostAuthenticationReceipts.pop(); }, e => { e.hostAuthenticationReceipts.push(e.hostAuthenticationReceipts[1]); },
    e => { e.nativeExecutionReceipt += " "; },
    e => { const r = JSON.parse(e.nativeExecutionReceipt); r.verified = true; e.nativeExecutionReceipt = JSON.stringify(r); authenticate(e); },
    e => { const r = JSON.parse(e.nativeExecutionReceipt); r.transaction.committed = true; e.nativeExecutionReceipt = JSON.stringify(r); authenticate(e); },
    e => { const r = JSON.parse(e.nativeExecutionReceipt); r.transaction.affected_element_ids = [42]; e.nativeExecutionReceipt = JSON.stringify(r); authenticate(e); },
    e => { const p = JSON.parse(e.snapshotReceipt); p.Scope.DocumentRevision++; e.snapshotReceipt = JSON.stringify(p); authenticate(e); },
    e => { const p = JSON.parse(e.snapshotReceipt); e.snapshotReceipt = JSON.stringify({ ...p, Document: { ...p.Document, ProjectFingerprint: hash("foreign") } }); authenticate(e); }
  ];
  for (const change of cases) { const e = fixture("read"); change(e); assert.throws(() => readNativeProgramEvidence(e, sourceHash, "read", fingerprint)); }
});

function metadata(mode: "read" | "apply") {
  const binding = { assignment_id: "native-assignment", run_id: "native-turn", generation: 1, session_id: "session", principal_id: "local:pilot", document_fingerprint: fingerprint.slice(7) };
  return { [ASSIGNMENT_KERNEL_V2_META_KEY]: { schema: ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA, assignment_id: binding.assignment_id, binding,
    operation_id: "native-operation", capability_id: "operator_run_dynamic_revit_program", requested_effect: mode, purpose: "work", operation_role: "root",
    root_operation_id: "native-operation", blocks_parent_settlement: false, fulfillment_role: "delegated_task_execution",
    delegation_authority_id: "delegation:native-operation", eligible_criterion_ids: ["native-report"],
    request_identity: { capability_id: "operator_run_dynamic_revit_program", request_signature: "source-and-mode" },
    opened_at: "2026-10-30T00:00:00Z", deadline_at: "2026-10-30T00:04:00Z" } };
}

test("hosted native runner publishes one bound workstation job and consumes native proof without a cloud compiler", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"hosted-native-courier-")), prior={...process.env};
  Object.assign(process.env,{OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:"hosted",OPERATOR_REVIT_TRANSPORT:"courier",
    OPERATOR_REVIT_COURIER_TIMEOUT_MS:"5000",OPERATOR_AUTH_MODE:"principal_jwt"});
  delete process.env.OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH;delete process.env.OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY;
  try {
    fs.mkdirSync(path.join(root,"config"),{recursive:true});
    fs.writeFileSync(path.join(root,"config","revit-courier-context.json"),JSON.stringify({
      version:"revit-operator.revit-courier-context.v1",active:true,session_id:"session",message_id:"message",
      token:"test-bearer-must-not-persist",target_executor_id:"workstation-revit",target_document_title:"model",
      expires_at:new Date(Date.now()+60000).toISOString()}));
    for(const mode of ["read","apply"] as const) {
      const meta=metadata(mode), id="opv2_"+(mode==="read"?"a":"b").repeat(64);
      meta[ASSIGNMENT_KERNEL_V2_META_KEY].operation_id=id;
      meta[ASSIGNMENT_KERNEL_V2_META_KEY].root_operation_id=id;
      await runWithRevitToolAlias("operator_run_dynamic_revit_program",()=>runWithAssignmentKernelV2(meta,async()=>{
        let cloudExecutions=0;
        const pending=runDynamicRevitProgram({source,mode,native_program:{entry_type:"Query",...(mode==="apply"?{allowed_existing_unique_ids:["uid"]}:{})}},process.env,
          async()=>{cloudExecutions++;throw Error("must_not_execute_in_cloud");});
        void pending.catch(()=>{});
        const jobDir=path.join(root,"artifacts","revit-courier","jobs",id.slice(5));
        for(let tries=0;!fs.existsSync(path.join(jobDir,"job.json"))&&tries<100;tries++)await new Promise(r=>setTimeout(r,10));
        const job=JSON.parse(fs.readFileSync(path.join(jobDir,"job.json"),"utf8"));
        assert.equal(job.assignment_operation_id,id);assert.equal(job.target_executor_id,"workstation-revit");
        assert.equal(job.general_agent_admission.alias,"operator_run_dynamic_revit_program");
        assert.equal(job.path,`/revit/dynamic-runtime/run-native-${mode}-v1`);
        assert.equal(job.body.source,source);assert.equal(job.body.expectedDocumentFingerprint,fingerprint);
        assert.equal(JSON.stringify(job).includes("test-bearer-must-not-persist"),false);
        const evidence=fixture(mode,mode==="apply"?"committed":"not_started",true);
        fs.writeFileSync(path.join(jobDir,"result.json"),JSON.stringify({version:"revit-operator.revit-tool-result.v1",
          id:job.id,correlation_id:job.id,status:"succeeded",finished_at:new Date().toISOString(),
          result:{schema:"operator.native-program-workstation-result.v1",exitCode:0,evidence}}));
        const result=await pending;
        assert.equal(cloudExecutions,0);assert.equal(result.execution_ok,true);
        assert.equal(result.native_outcome?.persistent_effect,mode==="apply"?"applied":"none");
        assert.equal(result.native_outcome?.task_verified,false);
        const delivered=decorateAssignmentKernelMcpResultV2({content:[]},"operator_run_dynamic_revit_program") as any;
        assert.equal(delivered.structuredContent.operation_result_v2.operation_id,id);
      }));
    }
  } finally {
    for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test("existing MCP caller and canonical result preserve native effects without a second controller or verified checkpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-caller-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"), worker = path.join(root, "worker"), token = path.join(root, "token");
    fs.writeFileSync(supervisor, "stub"); fs.mkdirSync(worker); fs.writeFileSync(token, "0123456789abcdef");
    const runtime = { ...process.env, ...env, OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor, OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    for (const [mode, state, success] of [["read", "not_started", true], ["apply", "committed", true],
      ["apply", "committed", false], ["apply", "rolled_back", false], ["apply", "not_started", false], ["apply", "pending", false]] as const) {
      const e = fixture(mode, state, success);
      const output: any = await runWithAssignmentKernelV2(metadata(mode), async () => {
        const result = await runDynamicRevitProgram({ source, mode, native_program: { entry_type: "Query",
          ...(mode === "apply" ? { allowed_existing_unique_ids: ["uid"] } : {}) } }, runtime, async (_exe, args) => {
          const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
          assert.equal(config.expectedDocumentFingerprint, fingerprint); assert.equal(config.nativeProgram.mode, mode === "read" ? "read" : "write");
          assert.equal(config.compilationCacheDirectory, undefined); assert.equal(config.apply, mode === "apply");
          fs.writeFileSync(config.evidencePath, JSON.stringify(e)); return { exitCode: success ? 0 : 1, stdout: "", stderr: "" };
        });
        assert.equal(result.checkpoint, null, "commit alone is not committed_verified");
        assert.equal(result.iteration.retryable, false);
        assert.equal(result.native_outcome?.task_verified, false);
        return decorateAssignmentKernelMcpResultV2({ isError: !success, content: [{ type: "text", text: JSON.stringify(presentDynamicProgramResult(result)) }] }, "operator_run_dynamic_revit_program");
      });
      const op = output.structuredContent.operation_result_v2;
      assert.equal(op.authority, "native-host"); assert.equal(op.status, success ? "succeeded" : "failed_after_dispatch");
      assert.equal(op.native_transaction_state, state === "pending" ? "unknown" : state);
      assert.equal(op.persistent_effect, state === "committed" ? "applied" : state === "pending" ? "unknown" : "none");
      assert.equal(output.structuredContent.observation.semantic_facts.some((f:any)=>
        f.fact_id==='control.domain_succeeded'&&f.fact_class==='control'&&f.value===true),success,
        'validated successful native execution must reach the existing progress consumer; failures cannot gain it');
      assert.equal(output.structuredContent.observation.semantic_facts.some((f: any) => ["collection.complete", "verification.postcondition_satisfied"].includes(f.fact_id)), false);
      const visible = JSON.parse(output.content[0].text);
      assert.equal(visible.native_outcome.task_verified, false);
      assert.equal(visible.native_outcome.program_result, success ? '{"matchingRooms":3}' : null);
      assert.equal(visible.evidence, undefined);
    }
    await assert.rejects(() => runDynamicRevitProgram({ source, mode: "read", native_program: { entry_type: "Query" } }, runtime), /admitted task/);
    await runWithAssignmentKernelV2(metadata("read"), async () => {
      await assert.rejects(() => runDynamicRevitProgram({ source, mode: "read", native_program: { entry_type: "Query" }, category: "OST_MEPSpaces" }, runtime), /cannot mix/);
    });
    const missing = fixture("apply", "pending", false);
    delete missing.nativeExecutionReceipt;
    const absent: any = await runWithAssignmentKernelV2(metadata("apply"), async () => {
      await runDynamicRevitProgram({ source, mode: "apply", native_program: { entry_type: "Query", allowed_existing_unique_ids: ["uid"] } }, runtime,
        async (_exe, args) => {
          fs.writeFileSync(JSON.parse(fs.readFileSync(args[1]!, "utf8")).evidencePath, JSON.stringify(missing));
          return { exitCode: 1, stdout: "", stderr: "Lost native response" };
        });
      return decorateAssignmentKernelMcpResultV2({ isError: true, content: [] }, "operator_run_dynamic_revit_program");
    });
    assert.equal(absent.structuredContent.operation_result_v2.authority, "dynamic-runtime", "A native request without a native receipt gains no authority");
    assert(!absent.structuredContent.observation.semantic_facts.some((f:any)=>f.fact_id==='control.domain_succeeded'&&f.value===true));
    assert.equal(absent.structuredContent.operation_result_v2.persistent_effect, "unknown");
    assert.equal(absent.structuredContent.operation_result_v2.native_transaction_state, "unknown");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("native C# keeps explicit supported years for read/write without adding authority", () => {
  for (const year of ["2023", "2024", "2025", "2026", "2027"]) {
    for (const mode of ["read", "apply"] as const) {
      const result = normalizeNativeProgram({ entry_type: "Query", ...(mode === "apply" ? { effect_scope: "active_document" as const } : {}) }, mode, year, fingerprint, env);
      assert.ok(result);
    }
  }
  for (const year of ["2022", "2028", "2023.0", "2023 "]) {
    assert.throws(() => normalizeNativeProgram({ entry_type: "Query" }, "read", year, fingerprint, env));
  }
});

test('native result scope is a bounded check selector, separate from write authority',()=>{
 const env={REVIT_OPERATOR_MODE:'development',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory'};
 const base={entry_type:'Edit',effect_scope:'active_document' as const};
 const ordinary=normalizeNativeProgram(base,'apply','2024',fingerprint,env);
 const scoped=normalizeNativeProgram({...base,result_targets:{element_ids:[42],result_field:'created'}},'apply','2024',fingerprint,env);
 assert.deepEqual(scoped,ordinary,'result selection does not change native authorization or transaction scope');
 for(const result_targets of [{},null,{element_ids:[]},{element_ids:[0]},{element_ids:[42,42]},{result_field:'x.y'},
  {result_field:'constructor'},{element_ids:[42],unknown:true},{element_ids:Array.from({length:257},(_,i)=>i+1)}])
  assert.throws(()=>normalizeNativeProgram({...base,result_targets} as any,'apply','2024',fingerprint,env));
 assert.throws(()=>normalizeNativeProgram({entry_type:'Read',result_targets:{element_ids:[42]}},'read','2024',fingerprint,env));
 assert.throws(()=>normalizeNativeProgram({...base,result_targets:{element_ids:[42]},parameter_checks:[{element_id:42,parameter_name:'Mark',expected_value:'A'}]},'apply','2024',fingerprint,env));
});
