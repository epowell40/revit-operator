import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDynamicRevitProgram } from "./dynamicRevitProgramRunner.js";
import { getWorkspaceRoot } from "./workspace.js";

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const emptyDiagnosticBundle = sha256("dynamic-revit-worker-diagnostics/v1\n");

test("dynamic runner supports authenticated hosted execution, remains bounded, and redacts trusted paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-mcp-runner-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"); const token = path.join(root, "token"); const worker = path.join(root, "worker");
    fs.writeFileSync(supervisor, "stub"); fs.writeFileSync(token, "0123456789abcdef"); fs.mkdirSync(worker);
    const env = { ...process.env, REVIT_OPERATOR_MODE: "development", OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const graphHash = sha256("legacy-graph"); const documentFingerprint = sha256("document"); const documentSessionId = "session-1";
    const result = await runDynamicRevitProgram({ source: "public class Program {}", mode: "apply" }, env, async (_file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: true, taskDirectory: "secret-task", runtimeImageDirectory: "secret-runtime",
        applyReceipt: JSON.stringify({ schema: "dynamic-revit-apply-receipt/v1", outcome: "committed_verified", graph_hash: graphHash,
          document_fingerprint: documentFingerprint, document_session_id: documentSessionId, changed_element_ids: [42, 7] }),
        admission: { documentFingerprint, documentSessionId }, workerOutput: { sourceHash: sha256("public class Program {}"), executionStatus: "completed",
          graph: { graphHash }, diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle } }));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    assert.equal(result.execution_ok, true); assert.equal((result.evidence as any).taskDirectory, "opaque:trusted-task");
    assert.equal(result.checkpoint?.checkpoint_index, 1);
    assert.equal(result.checkpoint?.document_fingerprint, documentFingerprint);
    assert.ok(result.canonical_attempt_settlement);
    assert.equal(result.canonical_attempt_settlement!.requested_effect, "apply");
    assert.equal(result.canonical_attempt_settlement!.effect_state, "applied");
    assert.equal(result.canonical_attempt_settlement!.effect_authority, "native_receipt");
    assert.deepEqual(result.canonical_attempt_settlement!.affected_target_identities, ["element_id:42", "element_id:7"]);
    const hosted = await runDynamicRevitProgram({ source: "public class HostedProgram {}", mode: "preview" },
      { ...env, REVIT_OPERATOR_MODE: "hosted" }, async (_file, args) => {
        const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
        fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: true, workerOutput: {
          sourceHash: sha256("public class HostedProgram {}"), executionStatus: "completed",
          diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle
        } }));
        return { exitCode: 0, stdout: "", stderr: "" };
      });
    assert.equal(hosted.execution_ok, true);
    assert.equal(hosted.requested_mode, "preview");
    assert.ok(hosted.canonical_attempt_settlement);
    assert.equal(hosted.canonical_attempt_settlement!.schema, "revit-operator.native-attempt-settlement.v1");
    assert.equal(hosted.canonical_attempt_settlement!.requested_effect, "preview");
    assert.equal(hosted.canonical_attempt_settlement!.effect_state, "none");
    assert.equal(hosted.canonical_attempt_settlement!.effect_authority, "native_rollback");
    assert.equal(hosted.canonical_attempt_settlement!.request_dispatched, true);
    await assert.rejects(() => runDynamicRevitProgram({ source: "x".repeat(128_001), mode: "preview" }, env), /128,000/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dynamic runner exposes a bounded non-authorizing needs-facts continuation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-mcp-continuation-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"); const token = path.join(root, "token"); const worker = path.join(root, "worker");
    fs.writeFileSync(supervisor, "stub"); fs.writeFileSync(token, "0123456789abcdef"); fs.mkdirSync(worker);
    const env = { ...process.env, REVIT_OPERATOR_MODE: "development", OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
    const request = {
      schema: "dynamic-revit-fact-request/v1", requestId: "more-connectors", reason: "Need exact endpoint topology",
      selector: { schema: "dynamic-revit-building-systems-selector/v1", elementUniqueIds: ["uid-2"], categoryStableIds: [], kinds: ["mep_curve"], parameterNames: [], includeTypeParameters: false, pageSize: 32, cursor: null },
      knownScopeHashes: [digest("1")], authorizationGranted: false, requestHash: digest("2")
    };
    const trace = { schema: "dynamic-revit-execution-trace/v1", protocolIdentity: digest("3"), outcome: "needs_facts", graphHash: "",
      factRequestHash: request.requestHash, steps: [
        { stepId: "inspect", purpose: "Inspect supplied topology.", dependsOn: [], nodeIds: [], factReferences: [] },
        { stepId: "left-endpoint", purpose: "Resolve the first endpoint.", dependsOn: ["inspect"], nodeIds: [], factReferences: [] },
        { stepId: "right-endpoint", purpose: "Resolve the second endpoint.", dependsOn: ["inspect"], nodeIds: [], factReferences: [] }
      ], assertions: [{ assertionId: "scope-bounded", stepId: "inspect", kind: "scope", passed: true, message: "Scope is bounded.", factReferences: [] }],
      authorizationGranted: false, traceHash: digest("4") };
    const result = await runDynamicRevitProgram({
      source: "public class Program {}", mode: "apply",
      result_reference: {
        selector: { element_unique_ids: ["uid-1"], kinds: ["mep_curve"], page_size: 32 },
        target_unique_ids: ["uid-1"],
        effect_budget: {
          budget_id: "bounded-route", target_document_fingerprints: [digest("5")], allowed_categories: ["category:builtin:OST_DuctCurves"],
          explicit_target_unique_ids: ["uid-1"], allowed_sdk_domains: ["mep"], view_scope_hash: digest("6"), level_scope_hash: digest("7"),
          workset_scope_hash: digest("8"), phase_scope_hash: digest("9"), maximum_operation_count: 3, maximum_affected_elements: 5,
          maximum_creates: 1, maximum_modifications: 2, maximum_deletes: 0, maximum_execution_milliseconds: 5000,
          maximum_regenerations: 3, maximum_output_count: 1, maximum_output_bytes: 4096, file_capability_set_hash: digest("a")
        }
      }
    }, env, async (_file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      assert.equal(config.resultReference, true);
      assert.equal(config.requireExecutionTrace, true);
      assert.equal(config.buildingSystemsSelector.schema, "dynamic-revit-building-systems-selector/v1");
      assert.deepEqual(config.resultReferenceTargetUniqueIds, ["uid-1"]);
      assert.equal(config.resultReferenceEffectBudget.maximumOperationCount, 3);
      fs.writeFileSync(config.evidencePath, JSON.stringify({
        schema: "dynamic-revit-needs-facts-evidence/v1", ok: false, failure: "additional_facts_required",
        taskDirectory: "secret-task", runtimeImageDirectory: "secret-runtime",
        workerOutput: { sourceHash: sha256("public class Program {}"), executionStatus: "needs_facts", deterministicReplayVerified: true,
          compiledAssemblyHash: digest("b"), executionIdentityHash: digest("c"), diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle,
          compileElapsedMs: 42, executionElapsedMs: 7,
          resultReferenceProgramResult: { factRequest: request, executionTrace: trace } }
      }));
      return { exitCode: 1, stdout: "", stderr: "additional facts required" };
    });
    assert.equal(result.execution_status, "needs_facts");
    assert.equal(result.execution_ok, false);
    assert.equal(result.continuation?.authorization_granted, false);
    assert.deepEqual(result.continuation?.fact_request, request);
    assert.equal((result.evidence as any).taskDirectory, "opaque:trusted-task");
    assert.equal(result.iteration.attempt, 1);
    assert.equal(result.iteration.authorization_granted, false);
    assert.equal(result.iteration.execution_status, "needs_facts");
    assert.equal(result.iteration.progress.classification, "root");
    assert.match(result.verification.evidence_sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.verification.compile_elapsed_ms, 42);
    assert.equal(result.verification.execution_elapsed_ms, 7);
    assert.equal(result.step_plan?.step_count, 3);
    assert.equal(result.step_plan?.dependency_wave_count, 2);
    assert.equal(result.step_plan?.has_parallel_wave, true);
    assert.equal(result.step_plan?.steps[0]?.assertion_count, 1);

    const resume = { prior_run_id: result.run_id, prior_evidence_sha256: result.verification.evidence_sha256, mode: "facts" as const };
    const resumedInput = {
      source: "public class Program {}", mode: "apply" as const, resume,
      result_reference: {
        selector: { element_unique_ids: ["uid-1", "uid-2"], kinds: ["mep_curve" as const], page_size: 64 },
        target_unique_ids: ["uid-1"],
        effect_budget: {
          budget_id: "bounded-route", target_document_fingerprints: [digest("5")], allowed_categories: ["category:builtin:OST_DuctCurves"],
          explicit_target_unique_ids: ["uid-1"], allowed_sdk_domains: ["mep"], view_scope_hash: digest("6"), level_scope_hash: digest("7"),
          workset_scope_hash: digest("8"), phase_scope_hash: digest("9"), maximum_operation_count: 3, maximum_affected_elements: 5,
          maximum_creates: 1, maximum_modifications: 2, maximum_deletes: 0, maximum_execution_milliseconds: 5000,
          maximum_regenerations: 3, maximum_output_count: 1, maximum_output_bytes: 4096, file_capability_set_hash: digest("a")
        }
      }
    };
    await assert.rejects(() => runDynamicRevitProgram({ ...resumedInput,
      result_reference: { ...resumedInput.result_reference, selector: { element_unique_ids: ["uid-1"], kinds: ["mep_curve"], page_size: 64 } }
    }, env), /does not cover/);
    await assert.rejects(() => runDynamicRevitProgram({ ...resumedInput,
      resume: { ...resume, prior_evidence_sha256: digest("f") }
    }, env), /do not match/);
    const iterationPath = path.join(getWorkspaceRoot(), "artifacts", "dynamic-runtime-runs", result.run_id, "iteration.json");
    const originalIteration = fs.readFileSync(iterationPath, "utf8");
    const tamperedIteration = JSON.parse(originalIteration); tamperedIteration.retryable = true;
    fs.writeFileSync(iterationPath, JSON.stringify(tamperedIteration));
    await assert.rejects(() => runDynamicRevitProgram(resumedInput, env), /receipt hash is invalid/);
    fs.writeFileSync(iterationPath, originalIteration);
    const resumed = await runDynamicRevitProgram(resumedInput, env, async (_file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      assert.deepEqual(config.buildingSystemsSelector.elementUniqueIds, ["uid-1", "uid-2"]);
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: true, workerOutput: {
        sourceHash: sha256("public class Program {}"), executionStatus: "completed", deterministicReplayVerified: true,
        executionIdentityHash: digest("d"), diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle,
        resultReferenceProgramResult: { graph: { graphHash: digest("e"), documentFingerprint: digest("5"), documentSessionId: "session-facts" } }
      }, applyReceipt: JSON.stringify({ schema: "dynamic-revit-mep-result-apply-receipt-envelope/v1", outcome: "committed_verified",
        graph_hash: digest("e"), source_hash: sha256("public class Program {}"), apply_receipt: {
          documentRevisionAfter: 2,
          effects: [{ addedElementIds: [101], modifiedElementIds: [202], deletedElementIds: [] }]
        } }) }));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    assert.equal(resumed.execution_status, "completed");
    assert.equal(resumed.iteration.attempt, 2);
    assert.equal(resumed.iteration.resume_mode, "facts");
    assert.equal(resumed.iteration.parent?.run_id, result.run_id);
    assert.equal(resumed.iteration.parent?.iteration_sha256, result.iteration.iteration_sha256);
    assert.deepEqual(resumed.canonical_attempt_settlement?.affected_target_identities, ["element_id:101", "element_id:202"]);
    assert.equal(resumed.iteration.authorization_granted, false);
    assert.equal(resumed.iteration.progress.classification, "completed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dynamic runner chains verified committed checkpoints while resetting the bounded diagnostic loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-mcp-checkpoints-"));
  const createdRuns: string[] = [];
  try {
    const supervisor = path.join(root, "supervisor.exe"); const token = path.join(root, "token"); const worker = path.join(root, "worker");
    fs.writeFileSync(supervisor, "stub"); fs.writeFileSync(token, "0123456789abcdef"); fs.mkdirSync(worker);
    const env = { ...process.env, REVIT_OPERATOR_MODE: "development", OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const documentFingerprint = sha256("checkpoint-document"); const documentSessionId = "checkpoint-session";
    const execute = async (_file: string, args: string[]) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8")); const source = fs.readFileSync(config.sourceFile, "utf8");
      const graphHash = sha256(`graph:${source}`);
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: true,
        checkpointBinding: config.checkpointTaskSessionId ? { schema: "dynamic-revit-task-checkpoint-binding/v1",
          taskSessionId: config.checkpointTaskSessionId, checkpointIndex: config.checkpointIndex, checkpointHash: config.checkpointHash,
          documentFingerprint: config.checkpointDocumentFingerprint, documentSessionId: config.checkpointDocumentSessionId,
          applyReceiptHash: config.checkpointApplyReceiptHash, authorizationGranted: false } : null,
        admission: { documentFingerprint, documentSessionId },
        applyReceipt: JSON.stringify({ schema: "dynamic-revit-apply-receipt/v1", outcome: "committed_verified", graph_hash: graphHash,
          document_fingerprint: documentFingerprint, document_session_id: documentSessionId }),
        workerOutput: { sourceHash: sha256(source), executionStatus: "completed", graph: { graphHash }, diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle }
      }));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const first = await runDynamicRevitProgram({ source: "public class DesignStepOne {}", mode: "apply" }, env, execute);
    createdRuns.push(first.run_id);
    assert.equal(first.checkpoint?.checkpoint_index, 1); assert.equal(first.iteration.attempt, 1);
    const next = await runDynamicRevitProgram({ source: "public class DesignStepTwo {}", mode: "apply", continue_from_checkpoint: {
      prior_run_id: first.run_id, prior_evidence_sha256: first.verification.evidence_sha256,
      prior_checkpoint_sha256: first.checkpoint!.checkpoint_sha256
    } }, env, async (file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      assert.equal(config.checkpointTaskSessionId, first.checkpoint!.task_session_id);
      assert.equal(config.checkpointIndex, 1); assert.equal(config.checkpointHash, first.checkpoint!.checkpoint_sha256);
      return execute(file, args);
    });
    createdRuns.push(next.run_id);
    assert.equal(next.iteration.attempt, 1); assert.equal(next.iteration.resume_mode, "root");
    assert.equal(next.iteration.checkpoint_parent?.checkpoint_sha256, first.checkpoint?.checkpoint_sha256);
    assert.equal(next.checkpoint?.checkpoint_index, 2); assert.equal(next.checkpoint?.parent?.run_id, first.run_id);
    assert.equal(next.checkpoint?.task_session_id, first.checkpoint?.task_session_id);

    const thirdSource = "public class DesignStepThree {}";
    const failed = await runDynamicRevitProgram({ source: thirdSource, mode: "apply", continue_from_checkpoint: {
      prior_run_id: next.run_id, prior_evidence_sha256: next.verification.evidence_sha256,
      prior_checkpoint_sha256: next.checkpoint!.checkpoint_sha256
    } }, env, async (_file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: false, failure: "stale state; refresh and retry",
        checkpointBinding: { schema: "dynamic-revit-task-checkpoint-binding/v1", taskSessionId: config.checkpointTaskSessionId,
          checkpointIndex: config.checkpointIndex, checkpointHash: config.checkpointHash, documentFingerprint: config.checkpointDocumentFingerprint,
          documentSessionId: config.checkpointDocumentSessionId, applyReceiptHash: config.checkpointApplyReceiptHash, authorizationGranted: false },
        workerOutput: { sourceHash: sha256(thirdSource), executionStatus: "failed" } }));
      return { exitCode: 1, stdout: "", stderr: "stale" };
    });
    createdRuns.push(failed.run_id); assert.equal(failed.iteration.attempt, 1); assert.equal(failed.iteration.retryable, true);
    const retried = await runDynamicRevitProgram({ source: thirdSource, mode: "apply", resume: {
      prior_run_id: failed.run_id, prior_evidence_sha256: failed.verification.evidence_sha256, mode: "retry"
    } }, env, async (file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8")); assert.equal(config.checkpointIndex, 2);
      assert.equal(config.checkpointHash, next.checkpoint!.checkpoint_sha256); return execute(file, args);
    });
    createdRuns.push(retried.run_id); assert.equal(retried.iteration.attempt, 2); assert.equal(retried.checkpoint?.checkpoint_index, 3);
    assert.equal(retried.checkpoint?.task_session_id, first.checkpoint?.task_session_id);

    const checkpointPath = path.join(getWorkspaceRoot(), "artifacts", "dynamic-runtime-runs", first.run_id, "checkpoint.json");
    const original = fs.readFileSync(checkpointPath, "utf8"); const tampered = JSON.parse(original); tampered.document_session_id = "substituted";
    fs.writeFileSync(checkpointPath, JSON.stringify(tampered));
    await assert.rejects(() => runDynamicRevitProgram({ source: "x", mode: "apply", continue_from_checkpoint: {
      prior_run_id: first.run_id, prior_evidence_sha256: first.verification.evidence_sha256,
      prior_checkpoint_sha256: first.checkpoint!.checkpoint_sha256
    } }, env, execute), /receipt hash is invalid/);
    fs.writeFileSync(checkpointPath, original);
  } finally {
    for (const runId of createdRuns) fs.rmSync(path.join(getWorkspaceRoot(), "artifacts", "dynamic-runtime-runs", runId), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic result-reference input rejects unsafe or contradictory budgets before launch", async () => {
  await assert.rejects(() => runDynamicRevitProgram({
    source: "x", mode: "preview",
    result_reference: { selector: { kinds: ["mep_curve"] }, effect_budget: {
      budget_id: "bad", target_document_fingerprints: [`sha256:${"1".repeat(64)}`], allowed_categories: [], explicit_target_unique_ids: [],
      allowed_sdk_domains: ["mep"], view_scope_hash: `sha256:${"2".repeat(64)}`, level_scope_hash: `sha256:${"3".repeat(64)}`,
      workset_scope_hash: `sha256:${"4".repeat(64)}`, phase_scope_hash: `sha256:${"5".repeat(64)}`, maximum_operation_count: 1,
      maximum_affected_elements: 1, maximum_creates: 1, maximum_modifications: 1, maximum_deletes: 0,
      maximum_execution_milliseconds: 1000, maximum_regenerations: 1, maximum_output_count: 1, maximum_output_bytes: 1,
      file_capability_set_hash: `sha256:${"6".repeat(64)}`
    } }
  }), /sub-budgets exceed/);
});

test("dynamic runner rejects source substitution and forged structured diagnostic identities", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-mcp-evidence-binding-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"); const token = path.join(root, "token"); const worker = path.join(root, "worker");
    fs.writeFileSync(supervisor, "stub"); fs.writeFileSync(token, "0123456789abcdef"); fs.mkdirSync(worker);
    const env = { ...process.env, REVIT_OPERATOR_MODE: "development", OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    await assert.rejects(() => runDynamicRevitProgram({ source: "public class Exact {}", mode: "preview" }, env, async (_file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: true, workerOutput: { sourceHash: sha256("substituted"), executionStatus: "completed",
        diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle } }));
      return { exitCode: 0, stdout: "", stderr: "" };
    }), /not bound to the submitted source/);
    await assert.rejects(() => runDynamicRevitProgram({ source: "public class Broken {", mode: "preview" }, env, async (_file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8")); const source = fs.readFileSync(config.sourceFile, "utf8");
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: false, workerOutput: { sourceHash: sha256(source), executionStatus: "failed",
        diagnostics: [{ code: "CS1002", message: "; expected", phase: "compile", severity: "error", repairAction: "edit_source",
          line: 1, column: 1, endLine: 1, endColumn: 1, stepId: null, assertionId: null, retryable: true }],
        diagnosticBundleHash: sha256("forged") } }));
      return { exitCode: 1, stdout: "", stderr: "" };
    }), /diagnostic bundle identity is invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dynamic runner distinguishes source repair from transient retry and caps the evidence chain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-mcp-repair-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"); const token = path.join(root, "token"); const worker = path.join(root, "worker");
    fs.writeFileSync(supervisor, "stub"); fs.writeFileSync(token, "0123456789abcdef"); fs.mkdirSync(worker);
    const env = { ...process.env, REVIT_OPERATOR_MODE: "development", OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const failed = async (_file: string, args: string[]) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      const diagnostic = {
        code: "CS1002", message: "; expected", phase: "compile", severity: "error", repairAction: "edit_source",
        line: 3, column: 18, endLine: 3, endColumn: 18, stepId: null, assertionId: null, retryable: true
      };
      const bundle = sha256(`dynamic-revit-worker-diagnostics/v1\nCS1002|compile|error|edit_source|3|18|3|18|||1|${sha256(diagnostic.message)}`);
      const source = fs.readFileSync(config.sourceFile, "utf8");
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: false, failure: "worker_failed", workerOutput: {
        sourceHash: sha256(source), executionStatus: "failed", diagnostics: [diagnostic], diagnosticBundleHash: bundle
      } }));
      return { exitCode: 1, stdout: "", stderr: "" };
    };
    const initial = await runDynamicRevitProgram({ source: "public class Broken {", mode: "preview" }, env, failed);
    assert.equal(initial.execution_status, "failed");
    assert.equal(initial.diagnostics[0]?.phase, "compile");
    assert.equal(initial.diagnostics[0]?.repair_action, "edit_source");
    assert.equal(initial.diagnostics[0]?.line, 3);
    assert.equal(initial.iteration.retryable, true);
    const parent = { prior_run_id: initial.run_id, prior_evidence_sha256: initial.verification.evidence_sha256 };
    await assert.rejects(() => runDynamicRevitProgram({ source: "public class Broken {", mode: "preview", resume: { ...parent, mode: "repair" } }, env), /changed source/);
    await assert.rejects(() => runDynamicRevitProgram({ source: "public class Fixed {}", mode: "preview", resume: { ...parent, mode: "retry" } }, env), /preserve the exact source/);
    const repaired = await runDynamicRevitProgram({ source: "public class Fixed {}", mode: "preview", resume: { ...parent, mode: "repair" } }, env,
      async (_file, args) => { const config = JSON.parse(fs.readFileSync(args[1]!, "utf8")); const source = fs.readFileSync(config.sourceFile, "utf8");
        fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: true, workerOutput: { sourceHash: sha256(source), executionStatus: "completed",
          diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle } })); return { exitCode: 0, stdout: "", stderr: "" }; });
    assert.equal(repaired.iteration.attempt, 2);
    assert.equal(repaired.iteration.resume_mode, "repair");
    assert.notEqual(repaired.iteration.source_sha256, initial.iteration.source_sha256);
    assert.equal(repaired.iteration.progress.classification, "completed");
    assert.deepEqual(repaired.iteration.progress.resolved_codes, ["CS1002"]);

    let current = initial;
    for (let attempt = 2; attempt <= 5; attempt++) {
      current = await runDynamicRevitProgram({ source: "public class Broken {", mode: "preview", resume: {
        prior_run_id: current.run_id, prior_evidence_sha256: current.verification.evidence_sha256, mode: "retry"
      } }, env, failed);
      assert.equal(current.iteration.attempt, attempt);
      assert.equal(current.iteration.progress.classification, "no_progress");
    }
    await assert.rejects(() => runDynamicRevitProgram({ source: "public class Broken {", mode: "preview", resume: {
      prior_run_id: current.run_id, prior_evidence_sha256: current.verification.evidence_sha256, mode: "retry"
    } }, env), /limited to five/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
