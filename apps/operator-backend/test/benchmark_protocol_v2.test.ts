import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateGeneralRevitCapabilityAttempt,
  loadGeneralRevitCapabilityCorpus,
  type GeneralRevitCapabilityCase,
  type GeneralRevitEvaluation
} from "../src/benchmark/general_revit_capability_acceptance.js";
import { buildBenchmarkCaseResultV2 } from "../src/benchmark/protocol_v2_case.js";
import { assertReleaseCanaryInvocationV2, RELEASE_CANARY_CASE_IDS_V2, selectReleaseCanaryCasesV2 } from "../src/benchmark/protocol_v2_canary.js";
import { compareBenchmarkExactRerunsV2 } from "../src/benchmark/protocol_v2_compare.js";
import { finalizeBenchmarkRunEnvelopeV2, validateBenchmarkRunEnvelopeDraftV2 } from "../src/benchmark/protocol_v2_envelope.js";
import { loadExternalHiddenHoldoutV2, redactedExternalHoldoutDescriptorV2 } from "../src/benchmark/protocol_v2_holdout.js";
import { assertGeneralRevitProtocolOutputV2, loadGeneralRevitProtocolInputsV2 } from "../src/benchmark/protocol_v2_general_revit.js";
import { sha256File, sha256Value } from "../src/benchmark/protocol_v2_hash.js";
import { validateBenchmarkRepairCohortV2 } from "../src/benchmark/protocol_v2_maintenance.js";
import { buildBenchmarkRawReportV2, summarizeBenchmarkLanesV2, writeBenchmarkRawReportV2 } from "../src/benchmark/protocol_v2_report.js";
import { assertCompleteProtocolV2Receipts } from "../src/benchmark/protocol_v2_runner.js";
import { buildBenchmarkRescoreV2, writeBenchmarkRescoreV2 } from "../src/benchmark/protocol_v2_rescore.js";
import { validateBenchmarkProtocolV2Contract } from "../src/benchmark/protocol_v2_schema.js";
import {
  BENCHMARK_PROTOCOL_V2,
  BENCHMARK_REPORT_V2,
  BENCHMARK_RUN_ENVELOPE_V2_SCHEMA,
  BENCHMARK_RUNNER_V2,
  GENERAL_REVIT_EVALUATOR_V2,
  type BenchmarkRunEnvelopeDraftV2
} from "../src/benchmark/protocol_v2_types.js";

type JsonRecord = Record<string, unknown>;
const HASH = "a".repeat(64);
const REVISION = "b".repeat(40);
const START = "2026-08-22T12:00:00.000Z";
const FINISH = "2026-08-22T12:01:00.000Z";

function benchmarkCase(overrides: Partial<GeneralRevitCapabilityCase> = {}): GeneralRevitCapabilityCase {
  return {
    case_id: "t01_protocol_case",
    source: "user_basic",
    operation_family: "text_edit",
    prompt: "Replace the exact note and verify the committed result.",
    probe_prompt: "Inspect and preview replacing the exact note. Do not make changes.",
    capability_paths: ["/revit/replace-text-note"],
    dispatch_any_of: ["/revit/replace-text-note"],
    expected_effect: "apply",
    production_expected_effect: "apply",
    probe_expected_effect: "preview",
    epic0441_task_refs: [],
    ...overrides
  };
}

function envelopeDraft(caseValue: GeneralRevitCapabilityCase, overrides: Partial<BenchmarkRunEnvelopeDraftV2> = {}): BenchmarkRunEnvelopeDraftV2 {
  return {
    schema: BENCHMARK_RUN_ENVELOPE_V2_SCHEMA,
    protocol_version: BENCHMARK_PROTOCOL_V2,
    corpus: { version: "corpus/v1", sha256: HASH, original_case_manifest_sha256: HASH, case_hashes: { [caseValue.case_id]: sha256Value(caseValue) } },
    evaluator_version: GENERAL_REVIT_EVALUATOR_V2,
    fixture_adapter: { version: "fixture-adapter/v2", fixtures: [{ identity: "fixture.rvt", rvt_sha256: HASH }] },
    revit_version: "2024.3",
    installed_release_identity: "release-20260822",
    source_revisions: { public: REVISION, private: REVISION },
    policy_hashes: { tool_registry_sha256: HASH, tool_exposure_sha256: HASH, certification_policy_sha256: HASH },
    instruction_bundle_hashes: { prompt_sha256: HASH, skill_sha256: HASH, system_instruction_sha256: HASH },
    requested_agent: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    feature_flags: { canonical_assignment: true },
    authorization_mode: "explicit_apply",
    identity: { run_id: "run-v2", session_id: "suite-session-v2", generation: 1 },
    execution_lane: "committed_apply",
    started_at: START,
    runner_schema_version: BENCHMARK_RUNNER_V2,
    report_schema_version: BENCHMARK_REPORT_V2,
    ...overrides
  };
}

function canonicalAttempt(overrides: JsonRecord = {}): JsonRecord {
  return {
    attempt_id: "attempt-1",
    run_id: "assignment-run-1",
    generation: 1,
    purpose: "action",
    requested_effect: "apply",
    target_identities: ["element:101"],
    affected_target_identities: ["element:101"],
    admission: { state: "admitted" },
    dispatch: { state: "acknowledged" },
    effect: { state: "applied", authority: "native_receipt", reason: "committed" },
    receipt_refs: ["receipt:1"],
    evidence_refs: ["readback:1"],
    created_at: "2026-08-22T12:00:10.000Z",
    ...overrides
  };
}

function assignmentProjection(attempts: JsonRecord[]): JsonRecord {
  return {
    assignments: [{
      id: "assignment-1",
      control_plane: {
        schema: "revit-operator.assignment-control-plane-projection/v1",
        assignment_id: "assignment-1",
        run_id: "assignment-run-1",
        generation: 1,
        terminal_state: "verified",
        attempts
      }
    }]
  };
}

function traceFor(testCase: GeneralRevitCapabilityCase, args: {
  assistant?: string;
  attempts?: JsonRecord[];
  fixtureMatch?: boolean | null;
  evaluation?: GeneralRevitEvaluation;
  actionRows?: JsonRecord[];
  mutationRequested?: boolean;
} = {}): JsonRecord {
  const projection = assignmentProjection(args.attempts ?? [canonicalAttempt()]);
  const actionRows = args.actionRows ?? [{
    path: testCase.dispatch_any_of[0], request_effect: testCase.expected_effect,
    request_dispatched: true, status: "success", receipt: { artifact: "receipt.json", readback: { ok: true } }
  }];
  const raw = {
    ok: true,
    assistant_message: args.assistant ?? "Successfully applied and verified the requested change.",
    actions: actionRows,
    assignment_projection: projection,
    durable_tool_evidence: { assignments: [] }
  };
  const evaluation = args.evaluation ?? evaluateGeneralRevitCapabilityAttempt(testCase, raw);
  return {
    schema: "revit-operator.task-trace/v1",
    case_id: testCase.case_id,
    execution_expected_effect: testCase.expected_effect,
    started_at: START,
    finished_at: FINISH,
    fixture_applicability: { fixture_match: args.fixtureMatch === undefined ? true : args.fixtureMatch },
    user_intent: { mutation_requested: args.mutationRequested ?? testCase.expected_effect === "apply" },
    model_call_receipts: [{ response_id: "response-1" }],
    tool_calls: actionRows,
    tool_results: {
      raw_sidecar_response_sha256: sha256Value(raw),
      raw_sidecar_response: raw,
      durable_assignment_projection: projection,
      durable_tool_evidence: { assignments: [] }
    },
    errors_retries_recoveries: { error: null },
    verification_results: { evaluation },
    success_failure_score: { tier: evaluation.tier },
    efficiency: { duration_ms: 60_000, model_call_summary: { call_count: 1, input_tokens: 100, output_tokens: 20, cost_usd: 0.01 } },
    human_corrections: []
  };
}

test("immutable run envelope fails closed on missing identity, hashes, or provider routes", () => {
  const testCase = benchmarkCase();
  const valid = envelopeDraft(testCase);
  validateBenchmarkRunEnvelopeDraftV2(valid);
  validateBenchmarkProtocolV2Contract("run_envelope_draft", valid);
  assert.throws(() => validateBenchmarkRunEnvelopeDraftV2({ ...valid, installed_release_identity: "" }), /installed add-in\/package/);
  assert.throws(() => validateBenchmarkRunEnvelopeDraftV2({ ...valid, source_revisions: { ...valid.source_revisions, public: "short" } }), /exact 40-character/);
  assert.throws(() => finalizeBenchmarkRunEnvelopeV2(valid, [], FINISH), /observed provider routes/);
  const envelope = finalizeBenchmarkRunEnvelopeV2(valid, [{ route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium", call_count: 1 }], FINISH);
  validateBenchmarkProtocolV2Contract("run_envelope", envelope);
});

test("new Protocol V2 runs refuse to overwrite retained legacy or V2 raw evidence", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-v2-output-"));
  const output = path.join(tmp, "run", "report.json");
  const inputs = loadGeneralRevitProtocolInputsV2("");
  assertGeneralRevitProtocolOutputV2(inputs, output, true);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, "{}", "utf8");
  assert.throws(() => assertGeneralRevitProtocolOutputV2(inputs, output, true), /refuses to overwrite/);
  assert.doesNotThrow(() => assertGeneralRevitProtocolOutputV2(inputs, output, false));
});

test("release canary maps the exact ten high-information cases and rejects resume", () => {
  const selected = selectReleaseCanaryCasesV2(loadGeneralRevitCapabilityCorpus().cases);
  assert.deepEqual(selected.map((entry) => entry.case_id), [...RELEASE_CANARY_CASE_IDS_V2]);
  assert.throws(() => assertReleaseCanaryInvocationV2({ resume: true, receiptComplete: true }), /non-resumed/);
  assert.throws(() => assertReleaseCanaryInvocationV2({ resume: false, receiptComplete: false }), /incomplete/);
});

test("alternate number presentation passes while a convincing wrong number fails", () => {
  const testCase = benchmarkCase({
    expected_effect: "read",
    production_expected_effect: "read",
    probe_expected_effect: "read",
    dispatch_any_of: ["/revit/elements/search"],
    capability_paths: ["/revit/elements/search"],
    answer_assertions: { must_match: ["(?:509|five hundred(?: and)? nine)"], must_not_match: ["508"] }
  });
  const action = [{ path: "/revit/elements/search", request_effect: "read", request_dispatched: true, status: "success", receipt: { artifact: "inventory.json" } }];
  const correct = evaluateGeneralRevitCapabilityAttempt(testCase, { ok: true, assistant_message: "The inventory is five hundred and nine devices.", actions: action });
  const wrong = evaluateGeneralRevitCapabilityAttempt(testCase, { ok: true, assistant_message: "I carefully verified all 508 devices and everything checks out.", actions: action });
  assert.equal(correct.answer_assertion_passed, true);
  assert.equal(wrong.answer_assertion_passed, false);
  assert.equal(wrong.verified, false);
});

test("raw execution truth defeats contradictory prose and forged caller evidence", () => {
  const testCase = benchmarkCase();
  const applied = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "committed_apply", testCase,
    trace: traceFor(testCase, { assistant: "Preview only; no changes were made." }), rawTraceRef: "trace#1", judgedAt: FINISH });
  assert.equal(applied.execution_truth.effect_state, "applied");
  assert.equal(applied.presentation_verdict.verdict, "fail");
  const forged = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "committed_apply", testCase,
    trace: traceFor(testCase, { attempts: [canonicalAttempt({ effect: { state: "applied", authority: "caller_report" } })] }), rawTraceRef: "trace#2", judgedAt: FINISH });
  assert.equal(forged.execution_truth.effect_state, "unknown");
  assert.match(forged.execution_truth.authority, /untrusted/);
});

test("stale evidence is ignored and a later authoritative action can recover an exploratory failure", () => {
  const testCase = benchmarkCase();
  const stale = canonicalAttempt({ run_id: "old-run", generation: 0, created_at: "2026-08-21T12:00:00.000Z" });
  const staleResult = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "committed_apply", testCase,
    trace: traceFor(testCase, { attempts: [stale] }), rawTraceRef: "trace#stale", judgedAt: FINISH });
  assert.equal(staleResult.execution_truth.effect_state, "unknown");
  const failed = canonicalAttempt({ attempt_id: "attempt-0", dispatch: { state: "failed" }, effect: { state: "none", authority: "transport_pre_dispatch" } });
  const recovered = canonicalAttempt({ attempt_id: "attempt-1", retry_of_attempt_id: "attempt-0", retry_delta: "corrected_schema" });
  const recoveredResult = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "committed_apply", testCase,
    trace: traceFor(testCase, { attempts: [failed, recovered] }), rawTraceRef: "trace#recovered", judgedAt: FINISH });
  assert.equal(recoveredResult.execution_truth.effect_state, "applied");
  assert.equal(recoveredResult.delivery_verdict === "recovered_verified" || recoveredResult.delivery_verdict === "verification_evidence_failure", true);
});

test("preview/apply confusion and unauthorized mutations are release blocking", () => {
  const previewCase = benchmarkCase({ expected_effect: "preview", production_expected_effect: "preview" });
  const result = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "safe_readiness", testCase: previewCase,
    trace: traceFor(previewCase, { assistant: "Applied the change successfully.", mutationRequested: false }), rawTraceRef: "trace#preview", judgedAt: FINISH });
  assert.equal(result.execution_truth.collateral_or_unauthorized_mutation, true);
  assert.equal(result.delivery_verdict, "collateral_or_unauthorized_mutation");
  assert.equal(result.release_blocking, true);
});

test("wrong target and wrong orientation/host/side semantics fail even with a correct operation", () => {
  const testCase = benchmarkCase({
    expected_effect: "read", production_expected_effect: "read", probe_expected_effect: "read",
    answer_assertions: { must_match: ["target 101", "clockwise", "host wall 7", "exterior side"] }
  });
  const action = [{ path: "/revit/replace-text-note", request_effect: "read", request_dispatched: true, status: "success", receipt: { artifact: "geometry.json" } }];
  const evaluation = evaluateGeneralRevitCapabilityAttempt(testCase, {
    ok: true,
    assistant_message: "Operation succeeded on target 102, counterclockwise, host wall 8, interior side.",
    actions: action
  });
  assert.equal(evaluation.answer_assertion_passed, false);
  assert.equal(evaluation.verified, false);
});

test("stage vector records missing fixture and first uncertain/failing stage", () => {
  const testCase = benchmarkCase();
  const result = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "committed_apply", testCase,
    trace: traceFor(testCase, { fixtureMatch: false }), rawTraceRef: "trace#fixture", judgedAt: FINISH });
  assert.equal(result.stages.length, 11);
  assert.equal(result.first_failed_or_uncertain_stage, "fixture_valid");
  assert.equal(result.primary_failure_cause, "fixture_applicability");
});

test("provider and Revit receipt completeness fail closed", () => {
  const base = {
    model_telemetry_coverage: { complete: false, cases_with_model_receipts: 0 },
    task_traces: []
  };
  assert.throws(() => assertCompleteProtocolV2Receipts(base, ["case-1"]), /provider telemetry/);
  const missingRevit = {
    model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
    task_traces: [{ case_id: "case-1", tool_results: {}, verification_results: { evaluation: {} } }]
  };
  assert.throws(() => assertCompleteProtocolV2Receipts(missingRevit, ["case-1"]), /canonical Revit receipts/);
});

test("lane reporting excludes Accepted/safe readiness from delivered labor and blocks false completion", () => {
  const testCase = benchmarkCase();
  const verified = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "committed_apply", testCase,
    trace: traceFor(testCase), rawTraceRef: "trace#verified", judgedAt: FINISH });
  verified.delivery_verdict = "first_pass_verified";
  const accepted = structuredClone(verified);
  accepted.case_id = "accepted";
  accepted.delivery_verdict = "truthful_ambiguity_blocker";
  const blocked = structuredClone(verified);
  blocked.case_id = "blocked";
  blocked.delivery_verdict = "false_completion";
  blocked.release_blocking = true;
  const lane = summarizeBenchmarkLanesV2([verified, accepted, blocked]).find((entry) => entry.lane === "committed_apply")!;
  assert.equal(lane.verified_committed_completion, 1);
  assert.equal(lane.primary_delivered_labor_rate, 1 / 3);
  assert.equal(lane.release_blocked, true);
});

test("rescore writes a new immutable artifact, preserves source/original judgment, and explains changes", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-v2-rescore-"));
  const testCase = benchmarkCase();
  const envelope = finalizeBenchmarkRunEnvelopeV2(envelopeDraft(testCase), [{ route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium", call_count: 1 }], FINISH);
  const caseResult = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "committed_apply", testCase,
    trace: traceFor(testCase), rawTraceRef: "trace#1", judgedAt: FINISH });
  validateBenchmarkProtocolV2Contract("case_result", caseResult);
  const source = buildBenchmarkRawReportV2(envelope, [caseResult], FINISH);
  validateBenchmarkProtocolV2Contract("raw_report", source);
  const sourcePath = path.join(tmp, "raw-report.json");
  writeBenchmarkRawReportV2(sourcePath, source);
  const before = fs.readFileSync(sourcePath, "utf8");
  const changedVerdict = caseResult.current_evaluator_verdict.verdict === "failed" ? "verified" : "failed";
  const artifact = buildBenchmarkRescoreV2({
    sourceReportPath: sourcePath,
    evaluatorVersion: "evaluator/v2.1",
    rescoredAt: "2026-08-22T13:00:00.000Z",
    reevaluate: (original) => ({
      result: { ...original, current_evaluator_verdict: { version: "evaluator/v2.1", verdict: changedVerdict, judged_at: FINISH, reasons: ["new exact oracle"] } },
      explanation: "The versioned exact-target oracle rejects the prior judgment."
    })
  });
  assert.equal(artifact.verdict_changes.length, 1);
  validateBenchmarkProtocolV2Contract("rescore", artifact);
  assert.deepEqual(artifact.cases[0]!.original_evaluator_verdict, caseResult.original_evaluator_verdict);
  writeBenchmarkRescoreV2(path.join(tmp, "rescore.json"), artifact);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), before);
  assert.throws(() => writeBenchmarkRawReportV2(sourcePath, source), /already exists/);
});

test("exact rerun comparison permits release revisions to change but rejects case drift", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-v2-compare-"));
  const testCase = benchmarkCase();
  const firstEnvelope = finalizeBenchmarkRunEnvelopeV2(envelopeDraft(testCase), [{ route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium", call_count: 1 }], FINISH);
  const firstCase = buildBenchmarkCaseResultV2({ runId: "run-v2", lane: "committed_apply", testCase,
    trace: traceFor(testCase), rawTraceRef: "trace#first", judgedAt: FINISH });
  const firstPath = path.join(tmp, "first.json");
  writeBenchmarkRawReportV2(firstPath, buildBenchmarkRawReportV2(firstEnvelope, [firstCase], FINISH));
  const secondDraft = envelopeDraft(testCase, {
    installed_release_identity: "release-20260823",
    source_revisions: { public: "c".repeat(40), private: "d".repeat(40) },
    identity: { run_id: "run-v2-rerun", session_id: "suite-session-v2-rerun", generation: 1 }
  });
  const secondFinish = "2026-08-23T12:01:00.000Z";
  const secondEnvelope = finalizeBenchmarkRunEnvelopeV2(secondDraft, [{ route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium", call_count: 1 }], secondFinish);
  const secondCase = buildBenchmarkCaseResultV2({ runId: "run-v2-rerun", lane: "committed_apply", testCase,
    trace: traceFor(testCase), rawTraceRef: "trace#second", judgedAt: secondFinish });
  const secondPath = path.join(tmp, "second.json");
  writeBenchmarkRawReportV2(secondPath, buildBenchmarkRawReportV2(secondEnvelope, [secondCase], secondFinish));
  const comparison = compareBenchmarkExactRerunsV2(firstPath, secondPath);
  assert.deepEqual(comparison.envelope_changes.sort(), ["installed_release_identity", "private_source_revision", "public_source_revision"].sort());
  const drifted = structuredClone(secondDraft);
  drifted.corpus.case_hashes[testCase.case_id] = "e".repeat(64);
  const driftEnvelope = finalizeBenchmarkRunEnvelopeV2(drifted, [{ route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium", call_count: 1 }], secondFinish);
  const driftPath = path.join(tmp, "drift.json");
  const driftCase = structuredClone(secondCase);
  driftCase.case_sha256 = "e".repeat(64);
  writeBenchmarkRawReportV2(driftPath, buildBenchmarkRawReportV2(driftEnvelope, [driftCase], secondFinish));
  assert.throws(() => compareBenchmarkExactRerunsV2(firstPath, driftPath), /corpus and case hashes drift/);
});

test("external hidden holdout stays external and exposes only a redacted descriptor", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-v2-holdout-"));
  const fixturePath = path.join(tmp, "fixture.rvt");
  fs.writeFileSync(fixturePath, "disposable fixture", "utf8");
  const testCase = benchmarkCase();
  const manifest = {
    schema: "revit-operator.external-holdout-manifest/v2",
    manifest_id: "holdout-2026-08",
    corpus_version: "hidden/v1",
    fixture_adapter_version: "adapter/v2",
    fixtures: [{ identity: "hidden-fixture", path: "fixture.rvt", sha256: sha256File(fixturePath), discipline: "mechanical", document_title: "Hidden Fixture", case_ids: [testCase.case_id] }],
    cases: [testCase]
  };
  const manifestPath = path.join(tmp, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  validateBenchmarkProtocolV2Contract("external_holdout", manifest);
  const loaded = loadExternalHiddenHoldoutV2({ manifestPath, forbiddenSourceRoots: [path.join(tmp, "source")] });
  const redacted = JSON.stringify(redactedExternalHoldoutDescriptorV2(loaded.descriptor));
  assert.equal(redacted.includes(testCase.prompt), false);
  assert.equal(redacted.includes("must_match"), false);
  assert.throws(() => loadExternalHiddenHoldoutV2({ manifestPath, forbiddenSourceRoots: [tmp] }), /external/);
});

test("case-driven repair cohorts require three neighbors, a negative, and an unrelated regression", () => {
  validateBenchmarkRepairCohortV2({ repair_id: "repair-1", original_case_id: "original", neighboring_case_ids: ["n1", "n2", "n3"], negative_case_id: "negative", unrelated_regression_case_id: "unrelated" });
  assert.throws(() => validateBenchmarkRepairCohortV2({ repair_id: "repair-1", original_case_id: "original", neighboring_case_ids: ["n1", "n2"], negative_case_id: "negative", unrelated_regression_case_id: "unrelated" }), /three/);
});
