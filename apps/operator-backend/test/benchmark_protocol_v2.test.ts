import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
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
import { canonicalAttemptRequestedEffect, loadDurableToolEvidence } from "../src/benchmark/durable_tool_evidence.js";
import { summarizeGeneralRevitLatency } from "../src/benchmark/general_revit_latency.js";
import { assertReleaseCanaryInvocationV2, RELEASE_CANARY_CASE_IDS_V2, selectReleaseCanaryCasesV2 } from "../src/benchmark/protocol_v2_canary.js";
import { compareBenchmarkExactRerunsV2 } from "../src/benchmark/protocol_v2_compare.js";
import { finalizeBenchmarkRunEnvelopeV2, validateBenchmarkRunEnvelopeDraftV2 } from "../src/benchmark/protocol_v2_envelope.js";
import { loadExternalHiddenHoldoutV2, redactedExternalHoldoutDescriptorV2 } from "../src/benchmark/protocol_v2_holdout.js";
import {
  assertGeneralRevitProtocolOutputV2,
  generalRevitProtocolManifestPathV2,
  loadGeneralRevitProtocolInputsV2
} from "../src/benchmark/protocol_v2_general_revit.js";
import { backendRoot, benchmarkDataRoot, pathIsWithin, sourceControlledRoots } from "../src/benchmark/files.js";
import { sha256File, sha256Value } from "../src/benchmark/protocol_v2_hash.js";
import { validateBenchmarkRepairCohortV2 } from "../src/benchmark/protocol_v2_maintenance.js";
import { buildBenchmarkRawReportV2, summarizeBenchmarkLanesV2, writeBenchmarkRawReportV2 } from "../src/benchmark/protocol_v2_report.js";
import { assertCompleteProtocolV2Receipts, writeProtocolV2ReportFromFlight } from "../src/benchmark/protocol_v2_runner.js";
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

function assignmentProjection(attempts: JsonRecord[], terminalState = "verified"): JsonRecord {
  return {
    assignments: [{
      id: "assignment-1",
      control_plane: {
        schema: "revit-operator.assignment-control-plane-projection/v1",
        assignment_id: "assignment-1",
        run_id: "assignment-run-1",
        generation: 1,
        terminal_state: terminalState,
        attempts
      }
    }]
  };
}

function verifiedPacket(
  requestedEffect: "read" | "preview" | "apply" = "apply",
  status = "verified_complete",
  statusReason = "Canonical verification passed."
): JsonRecord {
  const body = {
    schema: "revit-operator.verified-work-packet/v1",
    packet_version: 1,
    parent_packet_id: null,
    identity: {
      assignment_id: "assignment-1", run_id: "assignment-run-1", generation: 1,
      project_document_fingerprint: "fixture", created_at: FINISH, source_release_identity: "test-release"
    },
    assignment: {
      normalized_user_request: "Complete the test request.", requested_effect: requestedEffect,
      scope: [], exclusions: [], constraints: [], authorization_envelope: null
    },
    status,
    status_reason: statusReason,
    grounded_targets: [], actions: [], acceptance_criteria: [], collateral_checks: [], artifacts: [], issues: [],
    rollback: {
      available: null, authority_or_transaction_identity: null, affected_target_identities: [],
      completed: false, evidence_references: []
    },
    performance: {
      elapsed_ms: 1, model_calls: 1, revit_calls: 1, input_tokens: 1, output_tokens: 1,
      total_tokens: 2, estimated_cost_usd: 0.01, telemetry_complete: true, human_intervention: false
    },
    trust_presentation: {
      overall: "independently_verified", agent_reported: "agent", native_execution_evidence: "native",
      independently_verified: "verified", uncertain_or_missing: "uncertain"
    }
  };
  const hash = sha256Value(body);
  return {
    ...body,
    packet_id: `vwp1_${Buffer.from(hash, "hex").toString("base64url").slice(0, 32)}`,
    packet_hash: `sha256:${hash}`
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
  const projectedAttempts = args.attempts ?? [canonicalAttempt()];
  const projection = assignmentProjection(projectedAttempts);
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
  const durableEvidence = {
    schema: "revit-operator.benchmark-durable-tool-evidence/v1",
    canonical_attempt_receipts: projectedAttempts.map(attempt => ({
      schema: "revit-operator.benchmark-canonical-attempt-receipt/v1",
      goal_id: "assignment-1",
      assignment_run_id: "assignment-run-1",
      assignment_generation: 1,
      assignment_terminal_state: "verified",
      attempt_id: attempt.attempt_id,
      path: testCase.dispatch_any_of[0],
      requested_effect: attempt.requested_effect,
      dispatch_state: (attempt.dispatch as JsonRecord)?.state,
      effect_state: (attempt.effect as JsonRecord)?.state,
      effect_authority: (attempt.effect as JsonRecord)?.authority,
      receipt_refs: attempt.receipt_refs,
      evidence_refs: attempt.evidence_refs
    }))
  };
  const durableWorkPackets = {
    schema: "revit-operator.benchmark-work-packets/v1",
    packets: [verifiedPacket(testCase.expected_effect)],
    failures: []
  };
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
      durable_tool_evidence: durableEvidence,
      durable_work_packets: durableWorkPackets
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

test("ordinary Protocol V2 manifest is backend-owned in compiled public layout", () => {
  const inputs = loadGeneralRevitProtocolInputsV2("");
  const expected = path.join(benchmarkDataRoot(), "general-agent", "revit-capability-acceptance.v1.json");
  const actual = generalRevitProtocolManifestPathV2(inputs);
  assert.equal(actual, expected);
  assert.equal(fs.existsSync(actual), true);
  assert.doesNotMatch(actual.replaceAll("\\", "/"), /\/apps\/apps\/operator-backend\//);
  const roots = sourceControlledRoots();
  assert.ok(roots.some(root => pathIsWithin(backendRoot(), root) && fs.existsSync(path.join(root, ".git"))));
  assert.throws(() => loadExternalHiddenHoldoutV2({
    manifestPath: path.join(roots[0]!, "docs", "ARCHITECTURE.md"), forbiddenSourceRoots: roots
  }), /must remain external/);
});

test("failed Protocol V2 finalization publishes one immutable auditable failure artifact", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-v2-finalization-failure-"));
  const testCase = benchmarkCase();
  const draftPath = path.join(tmp, "draft.json");
  const legacyPath = path.join(tmp, "legacy.json");
  const outputPath = path.join(tmp, "protocol-v2", "raw-report.json");
  fs.writeFileSync(draftPath, JSON.stringify(envelopeDraft(testCase)), "utf8");
  fs.writeFileSync(legacyPath, JSON.stringify({
    run_id: "run-v2", generated_at: FINISH, suite_timing: { finished_at_utc: FINISH },
    model_call_telemetry: { by_route_model_effort: [{ route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium", call_count: 1 }] },
    model_telemetry_coverage: { complete: false, cases_with_model_receipts: 0 },
    task_traces: [traceFor(testCase)]
  }), "utf8");
  assert.throws(() => writeProtocolV2ReportFromFlight({
    draftPath, legacyReportPath: legacyPath, outputPath, cases: [testCase]
  }), /incomplete provider telemetry/);
  const failurePath = path.join(path.dirname(outputPath), "finalization-failure.json");
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(failurePath), true);
  const failure = JSON.parse(fs.readFileSync(failurePath, "utf8"));
  validateBenchmarkProtocolV2Contract("finalization_failure", failure);
  assert.equal(failure.finalization_status, "failed");
  assert.equal(failure.promotion_eligible, false);
  assert.equal(failure.failure_code, "missing_provider_receipt");
  assert.equal(failure.source_flight.sha256, sha256File(legacyPath));
  assert.throws(() => writeProtocolV2ReportFromFlight({
    draftPath, legacyReportPath: legacyPath, outputPath, cases: [testCase]
  }), /immutable failure publication failed|Immutable envelope draft already exists/);
  assert.equal(JSON.parse(fs.readFileSync(failurePath, "utf8")).artifact_sha256, failure.artifact_sha256);
});

test("Protocol V2 consumes the real durable projector's canonical read receipt when the legacy outer tool list is empty", async () => {
  const readCase = benchmarkCase({
    case_id: "t02_protocol_read",
    operation_family: "inventory",
    prompt: "Count the requested category and group the result.",
    probe_prompt: "Count the requested category and group the result without editing.",
    capability_paths: ["/revit/schedules"],
    dispatch_any_of: ["/revit/schedules"],
    expected_effect: "read",
    production_expected_effect: "read",
    probe_expected_effect: "read"
  });
  const attempts = [canonicalAttempt({
      requested_effect: "read",
      action_path: "/revit/schedules",
      tool_identity: "revit_list_schedules",
      effect: { state: "none", authority: "native_host", reason: "read_has_no_persistent_effect" },
      affected_target_identities: []
    })];
  const durableProjection = {
    assignments: [{
      id: "assignment-1",
      source_kind: "goal",
      source_record_id: "assignment-1",
      source_user_request: readCase.prompt,
      objective: readCase.prompt,
      created_at: START,
      target: { session_id: "suite-session-v2" },
      control_plane: {
        schema: "revit-operator.assignment-control-plane-projection/v1",
        assignment_id: "assignment-1",
        run_id: "assignment-run-1",
        generation: 1,
        terminal_state: "complete",
        attempts
      }
    }]
  };
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url?.startsWith("/api/notifications")
      ? JSON.stringify({ notifications: [], next_after_id: 0 })
      : JSON.stringify({ goal: { action_log: [] } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let durableEvidence: JsonRecord;
  try {
    durableEvidence = await loadDurableToolEvidence(
      `http://127.0.0.1:${address.port}`,
      durableProjection,
      readCase.prompt,
      { session_id: "suite-session-v2", started_at: START }
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  const receipts = durableEvidence.canonical_attempt_receipts as JsonRecord[];
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.requested_effect, "read");
  assert.equal(Object.prototype.hasOwnProperty.call(receipts[0]!, "request_effect"), false);

  const trace = traceFor(readCase, {
    attempts,
    actionRows: [{
      path: "/revit/schedules", request_effect: "read", request_dispatched: true,
      status: "success", receipt: { count: 2 }
    }]
  });
  trace.tool_calls = [];
  const toolResults = trace.tool_results as JsonRecord;
  toolResults.durable_assignment_projection = durableProjection;
  toolResults.durable_tool_evidence = durableEvidence;
  const raw = toolResults.raw_sidecar_response as JsonRecord;
  raw.assignment_projection = durableProjection;
  raw.durable_tool_evidence = durableEvidence;
  toolResults.raw_sidecar_response_sha256 = sha256Value(raw);
  assert.doesNotThrow(() => assertCompleteProtocolV2Receipts({
    model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
    task_traces: [trace]
  }, [readCase.case_id]));
  const result = buildBenchmarkCaseResultV2({
    runId: "run-v2", lane: "controlled_capability", testCase: readCase, trace,
    rawTraceRef: "trace.json", judgedAt: FINISH
  });
  assert.equal(result.execution_truth.requested_effect, "read");
  assert.equal(result.execution_truth.effect_state, "none");
  assert.equal(result.execution_truth.authority, "native_host");
  assert.equal(result.stages.find(stage => stage.stage === "postcondition_read_back")?.status, "pass");
  const packet = ((trace.tool_results as JsonRecord).durable_work_packets as JsonRecord).packets as JsonRecord[];
  packet[0]!.packet_hash = `sha256:${"0".repeat(64)}`;
  assert.throws(() => assertCompleteProtocolV2Receipts({
    model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
    task_traces: [trace]
  }, [readCase.case_id]), /Verified Work Packet/);
});

test("Protocol V2 publishes directly from the V2 snapshot and durable provider ledger after chat response loss", () => {
  const readCase = benchmarkCase({
    case_id: "t03_direct_kernel_read",
    operation_family: "inventory",
    prompt: "Return the requested authoritative inventory.",
    probe_prompt: "Return the requested authoritative inventory without editing.",
    capability_paths: ["/revit/quantify"],
    dispatch_any_of: ["/revit/quantify"],
    expected_effect: "read",
    production_expected_effect: "read",
    probe_expected_effect: "read"
  });
  const trace = traceFor(readCase, {
    actionRows: [{
      path: "/revit/quantify", request_effect: "read", request_dispatched: true,
      status: "success", receipt: { count: 2 }
    }]
  });
  const operation = {
    schema: "revit-operator.operation/v2",
    operation_id: "operation-direct-read",
    binding: {
      assignment_id: "assignment-1", run_id: "assignment-run-1", generation: 1,
      session_id: "suite-session-v2", principal_id: "suite-principal-v2"
    },
    work_unit_id: "work-primary",
    capability_id: "revit.quantify",
    request_identity: { method: "POST", path: "/revit/quantify", request_signature: "request-inventory" },
    purpose: "work",
    operation_role: "root",
    requested_effect: "read",
    criterion_ids: ["criterion-inventory"],
    resolves_gap_ids: ["criterion:criterion-inventory"],
    target: { target_id: "document:fixture", document_fingerprint: "fixture" },
    canonical_input: {},
    admission_state: "admitted",
    dispatch_state: "dispatched",
    dispatch_authority: "native",
    dispatched_at: START,
    persistent_effect: "none",
    settlement_state: "settled",
    observation_ids: ["observation-inventory"],
    result: {
      result_id: "result-inventory",
      operation_id: "operation-direct-read",
      status: "succeeded",
      dispatch_state: "dispatched",
      persistent_effect: "none",
      authority: "native-host",
      receipt_id: "receipt-inventory",
      completed_at: FINISH
    }
  };
  const providerCall = {
    schema: "revit-operator.provider-call/v2",
    call_id: "provider-call-direct-read",
    state: "completed",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    gap_ids: ["criterion:criterion-inventory"],
    criterion_ids: ["criterion-inventory"],
    expected_information: ["inventory.total"],
    admitted_at: START,
    completed_at: FINISH,
    success: true,
    usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 30, total_tokens: 150 }
  };
  const snapshot = {
    schema: "revit-operator.assignment-snapshot/v2",
    assignment_version: 9,
    current_binding: operation.binding,
    operations: { [operation.operation_id]: operation },
    observations: {
      "observation-inventory": {
        schema: "revit-operator.observation/v2",
        observation_id: "observation-inventory",
        operation_id: operation.operation_id,
        binding: operation.binding,
        authority: "native-host",
        semantic_facts: [{ fact_id: "inventory.total", value: 2 }]
      }
    },
    operation_ids: [operation.operation_id],
    in_flight_operation_ids: [],
    unresolved_unknown_operation_ids: [],
    quiescent: true,
    terminal: true,
    outcome: "complete",
    progress_epochs: [],
    provider_call_ids: [providerCall.call_id],
    provider_calls: { [providerCall.call_id]: providerCall },
    in_flight_provider_call_ids: []
  };
  const toolResults = trace.tool_results as JsonRecord;
  delete toolResults.durable_assignment_projection;
  toolResults.durable_assignment_kernel_v2 = {
    schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
    assignments: [{
      schema: "revit-operator.assignment-kernel-publication/v2",
      assignment_id: "assignment-1",
      assignment_version: 9,
      snapshot,
      provider_ledger: {
        schema: "revit-operator.assignment-provider-ledger/v2",
        assignment_id: "assignment-1",
        run_id: "assignment-run-1",
        generation: 1,
        call_ids: [providerCall.call_id],
        calls: { [providerCall.call_id]: providerCall },
        in_flight_call_ids: []
      }
    }]
  };
  trace.model_call_receipts = [];
  trace.tool_calls = [];
  toolResults.durable_tool_evidence = {
    schema: "revit-operator.benchmark-durable-tool-evidence/v1",
    canonical_attempt_receipts: [], result_receipts: []
  };
  assert.doesNotThrow(() => assertCompleteProtocolV2Receipts({
    model_telemetry_coverage: { complete: false, cases_with_model_receipts: 0 },
    task_traces: [trace]
  }, [readCase.case_id]));
  trace.model_call_receipts = [
    { call_id: providerCall.call_id },
    { call_id: "candidate46-receipt-missing-from-canonical-ledger" }
  ];
  assert.throws(() => assertCompleteProtocolV2Receipts({
    model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
    task_traces: [trace]
  }, [readCase.case_id]), /provider.*ledger.*conflict/i);
  trace.model_call_receipts = [{ call_id: providerCall.call_id, tokens: { total_tokens: 151 } }];
  assert.throws(() => assertCompleteProtocolV2Receipts({
    model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
    task_traces: [trace]
  }, [readCase.case_id]), /provider.*ledger.*conflict/i,
  "raw transport telemetry that contradicts canonical usage must fail closed");
  trace.model_call_receipts = [{ call_id: providerCall.call_id }];
  const result = buildBenchmarkCaseResultV2({
    runId: "run-v2", lane: "controlled_capability", testCase: readCase, trace,
    rawTraceRef: "trace.json", judgedAt: FINISH
  });
  assert.equal(result.execution_truth.attempt_ids[0], operation.operation_id);
  assert.equal(result.execution_truth.effect_state, "none");
  assert.equal(result.original_runtime_verdict.verdict, "complete");
  assert.equal(result.assignment_outcome, "complete");
  assert.equal(result.metrics.revit_calls, 1, "Protocol metrics must count the dispatched operation in the exact V2 snapshot");
  const latency = summarizeGeneralRevitLatency([trace], {});
  assert.equal((latency.revit_tool_duration as JsonRecord).count, 1,
    "latency reporting must use the same exact V2 operation publication");
  assert.equal(((latency.by_revit_path as JsonRecord)["/revit/quantify"] as JsonRecord).failed_or_rejected_count, 0);
});

test("Protocol V2 reports a missing direct V2 publication instead of falling back to legacy provider absence", () => {
  const readCase = benchmarkCase({
    case_id: "q01_v2_publication_missing",
    operation_family: "inventory",
    expected_effect: "read",
    production_expected_effect: "read",
    probe_expected_effect: "read"
  });
  const trace = traceFor(readCase);
  const toolResults = trace.tool_results as JsonRecord;
  toolResults.durable_assignment_kernel_v2 = {
    schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
    assignment_ids: ["assignment-1"],
    assignments: [],
    failures: [{ assignment_id: "assignment-1", error: "direct publication read failed" }]
  };
  assert.throws(() => assertCompleteProtocolV2Receipts({
    model_telemetry_coverage: { complete: false, cases_with_model_receipts: 0 },
    task_traces: [trace]
  }, [readCase.case_id]), /v2_publication_missing/);
});

test("canonical attempt effect accessor is backward compatible but rejects conflicting dual fields", () => {
  assert.equal(canonicalAttemptRequestedEffect({ requested_effect: "read" }), "read");
  assert.equal(canonicalAttemptRequestedEffect({ request_effect: "read" }), "read");
  assert.equal(canonicalAttemptRequestedEffect({ requested_effect: "read", request_effect: "read" }), "read");
  assert.equal(canonicalAttemptRequestedEffect({ requested_effect: "read", request_effect: "apply" }), null);
  assert.equal(canonicalAttemptRequestedEffect({ requested_effect: "unknown" }), null);
});

test("Protocol V2 accepts an exact-bound valid failure packet as measurable but non-promotable truth", () => {
  const testCase = benchmarkCase();
  const attempt = canonicalAttempt({
    effect: { state: "unknown", authority: "native_host", reason: "native_settlement_missing" },
    evidence_refs: ["evidence:unknown-effect"]
  });
  const trace = traceFor(testCase, { attempts: [attempt] });
  const projection = assignmentProjection([attempt], "canceled");
  const toolResults = trace.tool_results as JsonRecord;
  toolResults.durable_assignment_projection = projection;
  const raw = toolResults.raw_sidecar_response as JsonRecord;
  raw.assignment_projection = projection;
  const packet = verifiedPacket("apply", "complete_with_issues", "unknown_effect_requires_reconciliation");
  toolResults.durable_work_packets = {
    schema: "revit-operator.benchmark-work-packets/v1", packets: [packet], failures: []
  };
  toolResults.raw_sidecar_response_sha256 = sha256Value(raw);

  assert.doesNotThrow(() => assertCompleteProtocolV2Receipts({
    model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
    task_traces: [trace]
  }, [testCase.case_id]));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-v2-valid-failure-packet-"));
  const draftPath = path.join(tmp, "draft.json");
  const legacyPath = path.join(tmp, "legacy.json");
  const outputPath = path.join(tmp, "out", "raw-report.json");
  fs.writeFileSync(draftPath, JSON.stringify(envelopeDraft(testCase)), "utf8");
  fs.writeFileSync(legacyPath, JSON.stringify({
    run_id: "run-v2", generated_at: FINISH, suite_timing: { finished_at_utc: FINISH },
    model_call_telemetry: { by_route_model_effort: [{ route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium", call_count: 1 }] },
    model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
    task_traces: [trace]
  }), "utf8");
  const published = writeProtocolV2ReportFromFlight({ draftPath, legacyReportPath: legacyPath, outputPath, cases: [testCase] });
  assert.equal(fs.existsSync(published.json_path), true);
  assert.equal(fs.existsSync(path.join(path.dirname(outputPath), "finalization-failure.json")), false);
  assert.notEqual(published.report.cases[0]?.delivery_verdict, "verified_committed_completion");
  assert.notEqual(published.report.cases[0]?.delivery_verdict, "first_pass_verified");
});

test("Protocol V2 preserves typed failure artifacts and a timeout with recovered receipts can finalize", () => {
  const testCase = benchmarkCase();
  const publish = (name: string, mutate: (legacy: any, draft: any) => void) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `benchmark-v2-${name}-`));
    const draft = envelopeDraft(testCase) as any;
    const legacy: any = {
      run_id: "run-v2", generated_at: FINISH, suite_timing: { finished_at_utc: FINISH },
      model_call_telemetry: { by_route_model_effort: [{ route: "codex_agent", model: "gpt-5.6-sol", reasoning_effort: "medium", call_count: 1 }] },
      model_telemetry_coverage: { complete: true, cases_with_model_receipts: 1 },
      task_traces: [traceFor(testCase)]
    };
    mutate(legacy, draft);
    const draftPath = path.join(tmp, "draft.json");
    const legacyPath = path.join(tmp, "legacy.json");
    const outputPath = path.join(tmp, "out", "raw-report.json");
    fs.writeFileSync(draftPath, JSON.stringify(draft), "utf8");
    fs.writeFileSync(legacyPath, JSON.stringify(legacy), "utf8");
    return { draftPath, legacyPath, outputPath };
  };
  const failures: Array<[string, (legacy: any, draft: any) => void, string]> = [
    ["revit", legacy => { legacy.task_traces[0].tool_results.durable_tool_evidence = {}; }, "missing_revit_receipt"],
    ["packet", legacy => { legacy.task_traces[0].tool_results.durable_work_packets = { schema: "revit-operator.benchmark-work-packets/v1", packets: [], failures: [{ error: "blocked" }] }; }, "incomplete_work_packet"],
    ["packet-hash", legacy => {
      legacy.task_traces[0].tool_results.durable_work_packets.packets[0].packet_hash = `sha256:${"0".repeat(64)}`;
    }, "invalid_work_packet_hash"],
    ["packet-binding", legacy => {
      const packet = legacy.task_traces[0].tool_results.durable_work_packets.packets[0];
      packet.identity.run_id = "another-run";
      const { packet_id: _id, packet_hash: _hash, ...body } = packet;
      const hash = sha256Value(body);
      packet.packet_id = `vwp1_${Buffer.from(hash, "hex").toString("base64url").slice(0, 32)}`;
      packet.packet_hash = `sha256:${hash}`;
    }, "stale_work_packet_binding"],
    ["packet-truth", legacy => {
      const projection = legacy.task_traces[0].tool_results.durable_assignment_projection;
      projection.assignments[0].control_plane.terminal_state = "canceled";
      legacy.task_traces[0].tool_results.raw_sidecar_response.assignment_projection = projection;
      const packet = legacy.task_traces[0].tool_results.durable_work_packets.packets[0];
      const { packet_id: _id, packet_hash: _hash, ...body } = packet;
      const hash = sha256Value(body);
      packet.packet_id = `vwp1_${Buffer.from(hash, "hex").toString("base64url").slice(0, 32)}`;
      packet.packet_hash = `sha256:${hash}`;
      legacy.task_traces[0].tool_results.raw_sidecar_response_sha256 = sha256Value(legacy.task_traces[0].tool_results.raw_sidecar_response);
    }, "work_packet_truth_conflict"],
    ["inflight", legacy => {
      const control = legacy.task_traces[0].tool_results.durable_assignment_projection.assignments[0].control_plane;
      control.in_flight_count = 1;
      control.in_flight_attempt_ids = ["attempt-in-flight"];
      control.next_in_flight_deadline = "2026-08-22T12:05:00.000Z";
      control.quiescent = false;
    }, "assignment_settlement_in_flight"],
    ["evaluator", (_legacy, draft) => { draft.evaluator_version = ""; }, "evaluator_exception"]
  ];
  for (const [name, mutate, expectedCode] of failures) {
    const value = publish(name, mutate);
    assert.throws(() => writeProtocolV2ReportFromFlight({
      draftPath: value.draftPath, legacyReportPath: value.legacyPath, outputPath: value.outputPath, cases: [testCase]
    }));
    const failure = JSON.parse(fs.readFileSync(path.join(path.dirname(value.outputPath), "finalization-failure.json"), "utf8"));
    assert.equal(failure.failure_code, expectedCode);
    assert.equal(failure.promotion_eligible, false);
    if (name === "revit") assert.equal(failure.telemetry_completeness, "missing");
    if (name === "inflight") {
      assert.equal(failure.telemetry_completeness, "still_in_flight");
      assert.equal(failure.receipt_diagnostics.status, "still_in_flight");
      assert.deepEqual(failure.receipt_diagnostics.in_flight_attempt_ids, ["attempt-in-flight"]);
    }
  }
  const missingPath = publish("path", () => {});
  fs.rmSync(missingPath.draftPath);
  assert.throws(() => writeProtocolV2ReportFromFlight({
    draftPath: missingPath.draftPath, legacyReportPath: missingPath.legacyPath,
    outputPath: missingPath.outputPath, cases: [testCase]
  }));
  const pathFailure = JSON.parse(fs.readFileSync(path.join(path.dirname(missingPath.outputPath), "finalization-failure.json"), "utf8"));
  assert.equal(pathFailure.failure_code, "path_or_manifest_resolution_failure");

  const recovered = publish("timeout-recovered", legacy => {
    legacy.task_traces[0].errors_retries_recoveries = {
      error: "provider_timeout", recovered_receipts: ["provider", "canonical_revit"]
    };
  });
  const result = writeProtocolV2ReportFromFlight({
    draftPath: recovered.draftPath, legacyReportPath: recovered.legacyPath,
    outputPath: recovered.outputPath, cases: [testCase]
  });
  assert.equal(fs.existsSync(result.json_path), true);
  assert.equal(fs.existsSync(path.join(path.dirname(recovered.outputPath), "finalization-failure.json")), false);
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

test("a verified non-mutating preview is reported as successful delivery", () => {
  const previewCase = benchmarkCase({
    case_id: "r01_verified_preview_delivery",
    expected_effect: "preview",
    production_expected_effect: "preview",
    probe_expected_effect: "preview"
  });
  const previewAttempt = canonicalAttempt({
    requested_effect: "preview",
    affected_target_identities: [],
    effect: { state: "none", authority: "native_receipt", reason: "structured_preview" }
  });
  const trace = traceFor(previewCase, {
    assistant: "Preview completed successfully for the requested text-note replacement.",
    attempts: [previewAttempt],
    mutationRequested: false
  });
  const raw = (trace.tool_results as JsonRecord).raw_sidecar_response as JsonRecord;
  const assignment = ((raw.assignment_projection as JsonRecord).assignments as JsonRecord[])[0]!;
  assignment.source_record_id = "assignment-1";
  assignment.lifecycle = { phase: "complete" };
  assignment.execution = { requested_effect: "preview", completion_mode: "successful_preview" };
  assignment.verification = { state: "pass" };
  raw.teammate_loop_receipt = {
    schema: "revit-operator.teammate-loop-receipt.v1",
    turn_kind: "inspection",
    context_state: "live",
    stage: "preview_complete",
    apply_attempts: 0,
    blocked_reason: null,
    preview_action_ids: ["preview-action-1"],
    preview_receipts: [{
      action_id: "preview-action-1",
      path: "/revit/replace-text-note",
      status: "success",
      evidence_sha256: `sha256:${HASH}`
    }]
  };
  const result = buildBenchmarkCaseResultV2({
    runId: "run-v2",
    lane: "controlled_capability",
    testCase: previewCase,
    trace,
    rawTraceRef: "trace#verified-preview",
    judgedAt: FINISH
  });
  assert.equal(result.assignment_outcome, "complete");
  assert.equal(result.current_evaluator_verdict.verdict, "verified");
  assert.equal(result.first_failed_or_uncertain_stage, null);
  assert.equal(result.primary_failure_cause, null);
  assert.equal(result.delivery_verdict, "verified_preview_completion");
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
  driftCase.source_case_sha256 = "e".repeat(64);
  writeBenchmarkRawReportV2(driftPath, buildBenchmarkRawReportV2(driftEnvelope, [driftCase], secondFinish));
  assert.throws(() => compareBenchmarkExactRerunsV2(firstPath, driftPath), /corpus and case hashes drift/);
});

test("transformed execution identity preserves the source case hash and binds interactive turns separately", () => {
  const sourceCase = benchmarkCase();
  const executionCase = { ...sourceCase, expected_effect: sourceCase.expected_effect === "apply" ? "preview" as const : "apply" as const };
  const trace = traceFor(executionCase) as Record<string, unknown>;
  trace.protocol_v2_interaction = {
    transformation_id: "interactive_clarification",
    transformation_version: "v1",
    turns: [
      { turn_id: "turn-1", sequence: 1, role: "user", content: sourceCase.prompt },
      { turn_id: "turn-2", sequence: 2, role: "user", clarification_id: "clar-1", candidate_visible_input: "Use Current issue wording." }
    ]
  };
  const result = buildBenchmarkCaseResultV2({
    runId: "run-interactive", lane: "committed_apply", testCase: executionCase, sourceCase,
    transformationId: "interactive_clarification", transformationVersion: "v1",
    trace, rawTraceRef: "trace#interactive", judgedAt: FINISH
  });
  assert.equal(result.case_sha256, sha256Value(sourceCase));
  assert.equal(result.source_case_sha256, sha256Value(sourceCase));
  assert.equal(result.execution_case_sha256, sha256Value(executionCase));
  assert.notEqual(result.source_case_sha256, result.execution_case_sha256);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[1]?.clarification_id, "clar-1");
  assert.equal(JSON.stringify(result).includes("Current issue wording"), false);
  validateBenchmarkProtocolV2Contract("case_result", result);
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
