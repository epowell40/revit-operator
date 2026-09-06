import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { GoalRecord } from "../src/goals/service.js";
import type { AssignmentSnapshotV2 } from "../src/domain/assignment-kernel/index.js";
import { generateVerifiedWorkPacketFromKernelV2 } from "../src/work_packets/assignment_kernel_v2_generator.js";
import { verifyVerifiedWorkPacketHash } from "../src/work_packets/generator.js";
import { assertCompleteProtocolV2Receipts } from "../src/benchmark/protocol_v2_runner.js";
import { modelTelemetryCaseCoverage } from "../src/benchmark/general_revit_model_telemetry.js";
import { buildBenchmarkCaseResultV2 } from "../src/benchmark/protocol_v2_case.js";
import { sha256Value } from "../src/benchmark/protocol_v2_hash.js";
import type { GeneralRevitCapabilityCase } from "../src/benchmark/general_revit_capability_acceptance.js";
import { assignmentUserPauseV2 } from "../src/work_packets/assignment_kernel_v2_pause.js";
import { markdownReport } from "../src/benchmark/general_revit_capability_report.js";

// Retained actual UI pause: no replacement wording, no provider invocation and
// no native edit. Fixture contains only the credential-free local binding.
function pausedSnapshot(): AssignmentSnapshotV2 {
  return JSON.parse(fs.readFileSync(path.resolve("test/fixtures/paused-clarification-native-ui.json"), "utf8"));
}
function packet(snapshot: AssignmentSnapshotV2) {
  const goal = { id: snapshot.current_binding.assignment_id, non_goals: [], updated_at: "2026-09-06T00:19:15.539Z" } as unknown as GoalRecord;
  return generateVerifiedWorkPacketFromKernelV2(goal, snapshot, null);
}

test("retained UI clarification produces an honestly paused work packet without pretending the edit completed", () => {
  const snapshot = pausedSnapshot();
  const result = packet(snapshot);
  assert.equal(snapshot.terminal, false);
  assert.equal(snapshot.outcome, "awaiting_user_input");
  assert.equal(result.status, "awaiting_clarification");
  assert.equal(result.actions.length, 0);
  assert.equal(result.performance.model_calls, 0);
  assert.equal(result.performance.total_tokens, 0);
  assert.equal(result.trust_presentation.overall, "uncertain_or_missing");
  assert(result.issues.some(issue => issue.user_action_required?.includes("replacement text")));
  assert.equal(verifyVerifiedWorkPacketHash(result), true);
});

function trace(snapshot = pausedSnapshot()) {
  const binding = snapshot.current_binding;
  const raw = { ok: true, assistant_message: "What exact replacement text should I use?", actions: [] };
  return {
    schema: "revit-operator.task-trace/v1", case_id: "pause-case", execution_expected_effect: "apply",
    started_at: "2026-09-06T00:19:15.461Z", finished_at: "2026-09-06T00:19:15.539Z",
    model_call_receipts: [] as Record<string, unknown>[],
    tool_calls: [], verification_results: { evaluation: { tier: "accepted", dispatched: false, summary: "Awaiting supplied wording." } },
    tool_results: {
      raw_sidecar_response: raw, raw_sidecar_response_sha256: sha256Value(raw),
      durable_assignment_kernel_v2: {
        schema: "revit-operator.benchmark-assignment-kernel-v2/v1", assignment_ids: [binding.assignment_id], failures: [],
        assignments: [{ schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: binding.assignment_id,
          assignment_version: snapshot.assignment_version, snapshot,
          provider_ledger: { schema: "revit-operator.assignment-provider-ledger/v2", assignment_id: binding.assignment_id,
            run_id: binding.run_id, generation: binding.generation, call_ids: [...snapshot.provider_call_ids],
            calls: snapshot.provider_calls, in_flight_call_ids: [...snapshot.in_flight_provider_call_ids] } }]
      },
      durable_tool_evidence: { schema: "revit-operator.benchmark-durable-tool-evidence/v1", canonical_attempt_receipts: [], result_receipts: [] },
      durable_work_packets: { schema: "revit-operator.benchmark-work-packets/v1", packets: [packet(snapshot)], failures: [] }
    }
  };
}

test("paused clarification crosses packet and protocol receipt boundaries with explicit zero provider invocation", () => {
  const t = trace();
  assert.doesNotThrow(() => assertCompleteProtocolV2Receipts({ task_traces: [t] }, [t.case_id], { require_assignment_kernel_v2: true }));
  const coverage = modelTelemetryCaseCoverage([t]);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.cases_with_model_receipts, 0);
  assert.equal(coverage.cases_without_model_invocation, 1);
  assert.deepEqual(coverage.no_model_invocation_case_ids, [t.case_id]);
  assert.equal(coverage.cases_missing_model_receipts, 0);
  assert.match(markdownReport({ model_telemetry_coverage: coverage }), /no model invocation for 1 paused cases/);
  const testCase: GeneralRevitCapabilityCase = { case_id: t.case_id, source: "user_basic", operation_family: "text_edit",
    prompt: "Replace the selected note with approved wording.", probe_prompt: "Inspect the selected note.",
    capability_paths: ["/revit/replace-text-note"], dispatch_any_of: ["/revit/replace-text-note"], expected_effect: "apply",
    production_expected_effect: "apply", probe_expected_effect: "preview", epic0441_task_refs: [], prompt_specificity: "ambiguous_actionable" };
  const result = buildBenchmarkCaseResultV2({ runId: "pause-report", lane: "committed_apply", testCase, trace: t,
    rawTraceRef: "retained-pause.json", judgedAt: "2026-09-06T00:19:16.000Z" });
  assert.equal(result.assignment_outcome, "awaiting_user_input");
  assert.equal(result.original_runtime_verdict.verdict, "awaiting_user_input");
  assert.equal(result.delivery_verdict, "awaiting_user_input");
  assert.equal(result.execution_truth.effect_state, "none");
});

test("a forged observed provider call cannot use the deterministic pause exception", () => {
  const t = trace();
  t.model_call_receipts.push({ call_id: "unrecorded-provider-call" });
  assert.throws(() => assertCompleteProtocolV2Receipts({ task_traces: [t] }, [t.case_id], { require_assignment_kernel_v2: true }), /provider ledger conflict/);
});

test("a renewed input request reports the current unresolved question", () => {
  const snapshot = pausedSnapshot();
  const question = Object.values(snapshot.clarifications)[0]!;
  snapshot.clarifications = {
    old: { ...question, clarification_id: "old", question: "Earlier question", resolved_at: "2026-09-06T00:19:15.500Z" },
    current: { ...question, clarification_id: "current", question: "Which approved wording replaces the earlier text?" }
  };
  snapshot.input_values = { replacement_text: "Earlier supplied value" };
  assert.equal(assignmentUserPauseV2(snapshot), "awaiting_user_input");
  assert(packet(snapshot).issues.some(issue => issue.user_action_required === "Which approved wording replaces the earlier text?"));
  assert(!packet(snapshot).issues.some(issue => issue.user_action_required === "Earlier question"));
});

test("a pause after a completed provider call retains the real usage and is not a no-invocation case", () => {
  const snapshot = pausedSnapshot();
  snapshot.provider_call_ids = ["completed-call"];
  snapshot.provider_calls = { "completed-call": {
    schema: "revit-operator.provider-call/v2", call_id: "completed-call", binding: snapshot.current_binding,
    state: "completed", provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "medium", gap_ids: [], criterion_ids: [], expected_information: [],
    admitted_at: "2026-09-06T00:19:15.461Z", completed_at: "2026-09-06T00:19:15.539Z", success: true,
    usage: { input_tokens: 10, output_tokens: 2, reasoning_tokens: 1, total_tokens: 12, estimated_cost_usd: 0.001 }
  } };
  const t = trace(snapshot);
  t.model_call_receipts.push({ call_id: "completed-call", provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "medium",
    started_at_utc: "2026-09-06T00:19:15.461Z", success: true, tokens: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
  assert.doesNotThrow(() => assertCompleteProtocolV2Receipts({ task_traces: [t] }, [t.case_id], { require_assignment_kernel_v2: true }));
  assert.equal(packet(snapshot).performance.total_tokens, 12);
  const coverage = modelTelemetryCaseCoverage([t]);
  assert.equal(coverage.complete, true); assert.equal(coverage.cases_with_model_receipts, 1); assert.equal(coverage.cases_without_model_invocation, 0);
  snapshot.provider_calls["completed-call"]!.state = "dispatched";
  assert.throws(() => packet(snapshot), /quiescent recorded user pause/);
});

test("a recorded quiescent review wait stays a review request without task-completion credit", () => {
  const snapshot = pausedSnapshot();
  snapshot.outcome = "awaiting_user_review";
  snapshot.pending_input_variable_ids = [];
  snapshot.pending_review_ids = ["review-proposed-work"];
  const result = packet(snapshot);
  assert.equal(result.status, "awaiting_clarification");
  assert.equal(result.status_reason, "assignment_kernel_v2_awaiting_user_review");
  assert(result.issues.some(issue => issue.user_action_required === "Review the proposed work before continuing."));
  const t = trace(snapshot);
  assert.doesNotThrow(() => assertCompleteProtocolV2Receipts({ task_traces: [t] }, [t.case_id], { require_assignment_kernel_v2: true }));
  snapshot.pending_review_ids = [];
  assert.throws(() => packet(snapshot), /quiescent recorded user pause/);
});

test("paused packets still require exact generation binding and truthful status", () => {
  const t = trace();
  const otherGeneration = pausedSnapshot();
  otherGeneration.current_binding = { ...otherGeneration.current_binding, generation: 2 };
  t.tool_results.durable_work_packets.packets = [packet(otherGeneration)];
  assert.throws(() => assertCompleteProtocolV2Receipts({ task_traces: [t] }, [t.case_id]), /stale or cross-run binding/);
  const falseComplete = pausedSnapshot();
  falseComplete.terminal = true; falseComplete.outcome = "complete";
  t.tool_results.durable_work_packets.packets = [packet(falseComplete)];
  assert.throws(() => assertCompleteProtocolV2Receipts({ task_traces: [t] }, [t.case_id]), /status contradicts/);
});

test("empty telemetry without a complete matching canonical pause remains missing", () => {
  const t = trace();
  t.tool_results.durable_assignment_kernel_v2.assignment_ids.push("missing-assignment");
  assert.equal(modelTelemetryCaseCoverage([t]).complete, false);
  assert.equal(modelTelemetryCaseCoverage([t]).cases_without_model_invocation, 0);
  const malformed = trace();
  malformed.tool_results.durable_assignment_kernel_v2.assignments[0]!.snapshot.clarifications = {};
  assert.equal(modelTelemetryCaseCoverage([malformed]).complete, false);
  assert.equal(modelTelemetryCaseCoverage([{ case_id: "absent", model_call_receipts: [] }]).complete, false);
});

test("nonterminal work without a complete safe user pause stays rejected", () => {
  const cases: Array<[string, (s: Record<string, unknown>) => void]> = [
    ["active", s => { s.outcome = "active"; }],
    ["no question", s => { s.clarifications = {}; }],
    ["resolved question", s => { for (const q of Object.values(s.clarifications as Record<string, Record<string, unknown>>)) q.resolved_at = "2026-09-06T00:19:16.000Z"; }],
    ["no pending input", s => { s.pending_input_variable_ids = []; }],
    ["missing provider ledger", s => { delete s.provider_calls; }],
    ["in-flight provider", s => { s.in_flight_provider_call_ids = ["pending-call"]; }],
    ["in-flight operation", s => { s.in_flight_operation_ids = ["pending-edit"]; }],
    ["unknown effect", s => { s.unresolved_unknown_operation_ids = ["unknown-edit"]; }],
    ["hidden unknown effect", s => { s.operations = { edit: { settlement_state: "settled", persistent_effect: "unknown" } }; }],
    ["unsettled operation", s => { s.operations = { edit: { settlement_state: "awaiting_result", persistent_effect: "none" } }; }]
  ];
  for (const [label, mutate] of cases) {
    const snapshot = pausedSnapshot(); mutate(snapshot as unknown as Record<string, unknown>);
    assert.equal(assignmentUserPauseV2(snapshot), null, label);
    assert.throws(() => packet(snapshot), /quiescent recorded user pause/, label);
  }
});
