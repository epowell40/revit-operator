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

test("dynamic runner is local-only, bounded, and preserves receipts while redacting trusted paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-mcp-runner-"));
  try {
    const supervisor = path.join(root, "supervisor.exe"); const token = path.join(root, "token"); const worker = path.join(root, "worker");
    fs.writeFileSync(supervisor, "stub"); fs.writeFileSync(token, "0123456789abcdef"); fs.mkdirSync(worker);
    const env = { ...process.env, REVIT_OPERATOR_MODE: "development", OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH: supervisor,
      OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY: worker, OPERATOR_TOKEN_FILE: token };
    const result = await runDynamicRevitProgram({ source: "public class Program {}", mode: "apply" }, env, async (_file, args) => {
      const config = JSON.parse(fs.readFileSync(args[1]!, "utf8"));
      fs.writeFileSync(config.evidencePath, JSON.stringify({ ok: true, taskDirectory: "secret-task", runtimeImageDirectory: "secret-runtime", applyReceipt: "receipt",
        workerOutput: { sourceHash: sha256("public class Program {}"), executionStatus: "completed", diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle } }));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    assert.equal(result.execution_ok, true); assert.equal((result.evidence as any).taskDirectory, "opaque:trusted-task");
    assert.equal((result.evidence as any).applyReceipt, "receipt");
    await assert.rejects(() => runDynamicRevitProgram({ source: "x", mode: "preview" }, { ...env, REVIT_OPERATOR_MODE: "production" }), /unavailable/);
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
        executionIdentityHash: digest("d"), diagnostics: [], diagnosticBundleHash: emptyDiagnosticBundle
      } }));
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    assert.equal(resumed.execution_status, "completed");
    assert.equal(resumed.iteration.attempt, 2);
    assert.equal(resumed.iteration.resume_mode, "facts");
    assert.equal(resumed.iteration.parent?.run_id, result.run_id);
    assert.equal(resumed.iteration.parent?.iteration_sha256, result.iteration.iteration_sha256);
    assert.equal(resumed.iteration.authorization_granted, false);
    assert.equal(resumed.iteration.progress.classification, "completed");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
