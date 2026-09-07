import assert from "node:assert/strict";
import test from "node:test";
import { assertProtocolV2InstructionEvidence } from "../src/benchmark/protocol_v2_instruction_evidence.js";
import { buildProtocolV2ReportFromFlight } from "../src/benchmark/protocol_v2_runner.js";
import { sha256Value } from "../src/benchmark/protocol_v2_hash.js";
import type { BenchmarkRunEnvelopeDraftV2 } from "../src/benchmark/protocol_v2_types.js";

const hash = "a".repeat(64);
const draft: BenchmarkRunEnvelopeDraftV2 = {
  schema: "revit-operator.benchmark-run-envelope/v2", protocol_version: "revit-operator.benchmark-protocol/v2",
  corpus: { version: "v1", sha256: hash, original_case_manifest_sha256: hash, case_hashes: { case: hash } },
  evaluator_version: "revit-operator.general-revit-evaluator/v2",
  fixture_adapter: { version: "v1", fixtures: [{ identity: "fixture", rvt_sha256: hash }] },
  revit_version: "2027", installed_release_identity: "test", source_revisions: { public: "a".repeat(40), private: "a".repeat(40) },
  policy_hashes: { tool_registry_sha256: hash, tool_exposure_sha256: hash, certification_policy_sha256: hash },
  instruction_bundle_hashes: { prompt_sha256: hash, system_instruction_sha256: hash, skill_sha256: hash },
  requested_agent: { model: "gpt-5.6-sol", reasoning_effort: "medium" }, feature_flags: {},
  authorization_mode: "explicit_apply", identity: { run_id: "run", session_id: "suite", generation: 1 },
  execution_lane: "committed_apply", started_at: "2026-09-07T00:00:00.000Z",
  runner_schema_version: "revit-operator.benchmark-runner/v2", report_schema_version: "revit-operator.benchmark-report/v2"
};

function fixture() {
  const event = (turn: string, instance = "12345678-1234-1234-1234-123456789abc", pid = 42) => ({
    session_id: "session", message_id: `message-${turn}`, thread_id: "thread", turn_id: turn,
    host_instruction_binding: {
      schema: "revit-operator.host-supplied-instructions/v1", source: "host_supplied_acknowledged",
      prompt_sha256: hash, system_instruction_sha256: hash,
      benchmark_runtime: {
        schema: "revit-operator.benchmark-instruction-runtime/v1", configured: true,
        backend_instance_id: instance, process_id: pid, envelope_sha256: sha256Value(draft), run_id: "run",
        prompt_sha256: hash, system_instruction_sha256: hash
      }
    }
  });
  const binding = { assignment_id: "assignment", run_id: "assignment-run", generation: 1,
    session_id: "session", principal_id: "local", document_fingerprint: hash };
  const call = (id: string, turn: string) => ({ schema: "revit-operator.provider-call/v2", call_id: id,
    controller_turn_id: turn, binding, state: "completed", provider: "openai", model: "gpt-5.6-sol",
    reasoning_effort: "medium", gap_ids: [], criterion_ids: [], expected_information: [],
    admitted_at: draft.started_at, completed_at: draft.started_at, success: true,
    usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } });
  const calls = { response1: call("response1", "turn1"), response2: call("response2", "turn2") };
  const snapshot = { schema: "revit-operator.assignment-snapshot/v2", assignment_version: 1,
    current_binding: binding, provider_call_ids: Object.keys(calls), provider_calls: calls,
    in_flight_provider_call_ids: [] };
  return {
    case_id: "case", context_supplied: { session_id: "session" }, host_instruction_turns_complete: true,
    host_instruction_turns: [event("turn1"), event("turn2", "87654321-1234-1234-1234-123456789abc", 43)],
    model_call_receipts: [
      { call_id: "response1", turn_id: "turn1", thread_id: "thread", message_id: "message-turn1" },
      { call_id: "response2", turn_id: "turn2", thread_id: "thread", message_id: "message-turn2" }
    ],
    tool_results: {
      durable_assignment_kernel_v2: {
        schema: "revit-operator.benchmark-assignment-kernel-v2/v1", assignment_ids: ["assignment"], failures: [],
        assignments: [{ schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: "assignment",
          assignment_version: 1, snapshot, provider_ledger: {
            schema: "revit-operator.assignment-provider-ledger/v2", assignment_id: "assignment", run_id: "assignment-run",
            generation: 1, call_ids: Object.keys(calls), calls, in_flight_call_ids: []
          } }]
      }
    }
  };
}

test("joins paid turns to acknowledged instructions across a backend restart", () => {
  assert.doesNotThrow(() => assertProtocolV2InstructionEvidence(draft, [fixture()]));
});

test("malformed direct publications fail the shared parser even with plausible instruction evidence", () => {
  const trace = fixture();
  trace.tool_results.durable_assignment_kernel_v2.assignments[0].provider_ledger.generation = 2;
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /direct_publication_invalid.*provider_ledger_binding/);
});

test("a legacy projection cannot stand in for canonical direct publication evidence", () => {
  const trace = fixture();
  const legacy = { ...trace, tool_results: { durable_assignment_projection: { assignments: [{
    assignment_snapshot_v2: trace.tool_results.durable_assignment_kernel_v2.assignments[0].snapshot
  }] } } };
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [legacy]), /canonical_provider_publication_missing/);
});

test("direct publication ledger joins still require evidence when normalized usage is absent", () => {
  const trace = fixture();
  const binding = { assignment_id: "assignment", run_id: "assignment-run", generation: 1,
    session_id: "session", principal_id: "local", document_fingerprint: hash };
  const call = { schema: "revit-operator.provider-call/v2", call_id: "response1", controller_turn_id: "turn1",
    binding, state: "completed", provider: "openai", model: "gpt-5.6-sol", reasoning_effort: "medium",
    gap_ids: [], criterion_ids: [], expected_information: [], admitted_at: draft.started_at,
    completed_at: draft.started_at, success: true, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
  const snapshot = { schema: "revit-operator.assignment-snapshot/v2", assignment_version: 1,
    current_binding: binding, provider_call_ids: [call.call_id], provider_calls: { response1: call },
    in_flight_provider_call_ids: [] };
  const direct = { ...trace, model_call_receipts: [], tool_results: { durable_assignment_kernel_v2: {
    schema: "revit-operator.benchmark-assignment-kernel-v2/v1", assignment_ids: ["assignment"], failures: [],
    assignments: [{ schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: "assignment",
      assignment_version: 1, snapshot, provider_ledger: {
        schema: "revit-operator.assignment-provider-ledger/v2", assignment_id: "assignment", run_id: "assignment-run",
        generation: 1, call_ids: [call.call_id], calls: { response1: call }, in_flight_call_ids: []
      } }]
  } } };
  assert.doesNotThrow(() => assertProtocolV2InstructionEvidence(draft, [direct]));
  direct.host_instruction_turns = direct.host_instruction_turns.filter(event => event.turn_id !== "turn1");
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [direct]), /instruction_turn_binding_missing/);
});

test("rejects absent or incomplete collection rather than trusting launcher configuration", () => {
  const trace = fixture();
  trace.host_instruction_turns_complete = false;
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /instruction_event_collection_incomplete/);
  trace.host_instruction_turns_complete = true;
  trace.host_instruction_turns = [];
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /instruction_turn_binding_missing/);
});

test("requires the restarted turn's own envelope and instruction hashes", () => {
  for (const key of ["run_id", "envelope_sha256", "prompt_sha256", "system_instruction_sha256"] as const) {
    const trace = fixture();
    trace.host_instruction_turns[1].host_instruction_binding.benchmark_runtime[key] = "wrong";
    assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /mismatch/);
  }
  const trace = fixture();
  trace.host_instruction_turns[1].host_instruction_binding.source = "launcher_declared";
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /acknowledgement_missing/);
});

test("rejects cross-session, cross-thread, cross-message and duplicate turn joins", () => {
  for (const key of ["thread_id", "message_id"] as const) {
    const trace = fixture();
    trace.model_call_receipts[1][key] = "other";
    assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /mismatch/);
  }
  const trace = fixture();
  // Keep the direct publication internally consistent while testing its session-to-event join.
  trace.tool_results.durable_assignment_kernel_v2.assignments[0].snapshot.current_binding.session_id = "other";
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /provider_session_binding_mismatch/);
  const duplicate = fixture();
  duplicate.host_instruction_turns.push(duplicate.host_instruction_turns[0]);
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [duplicate]), /identity_duplicate/);
});

test("canonical paid turns cannot disappear with missing normalized receipts; compaction needs its own evidence", () => {
  const trace = fixture();
  trace.model_call_receipts = [];
  trace.host_instruction_turns.pop();
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /instruction_turn_binding_missing/);
  const compaction = fixture();
  compaction.model_call_receipts.push({ call_id: "compact", turn_id: "compaction-turn", thread_id: "thread", message_id: "message-turn2" });
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [compaction]), /separately billed compaction turn/);
});

test("one paid call cannot be attributed to a different otherwise valid turn", () => {
  const trace = fixture();
  trace.model_call_receipts[1] = { ...trace.model_call_receipts[0], call_id: "response2" };
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /provider_call_turn_binding_mismatch/);
});

test("validates captured turns even without raw usage and rejects conflicting backend instance identities", () => {
  const trace = fixture();
  trace.model_call_receipts = [];
  trace.host_instruction_turns[1].host_instruction_binding.benchmark_runtime.configured = false;
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [trace]), /runtime_instruction_binding_missing/);
  const conflict = fixture();
  conflict.host_instruction_turns[1].host_instruction_binding.benchmark_runtime.backend_instance_id =
    conflict.host_instruction_turns[0].host_instruction_binding.benchmark_runtime.backend_instance_id;
  assert.throws(() => assertProtocolV2InstructionEvidence(draft, [conflict]), /runtime_process_identity_conflict/);
});

test("scored report cannot bypass instruction coverage with requireCompleteReceipts false in any lane", () => {
  for (const lane of ["committed_apply", "controlled_capability", "ambient_context", "safe_readiness"] as const) {
    const trace = fixture();
    trace.host_instruction_turns_complete = false;
    assert.throws(() => buildProtocolV2ReportFromFlight({
      draft: { ...draft, execution_lane: lane }, legacyReport: { run_id: "run", task_traces: [trace] },
      legacyReportRef: "test.json", cases: [], requireCompleteReceipts: false
    }), /instruction_event_collection_incomplete/);
  }
});

test("no-provider pauses do not invent paid-turn instruction evidence", () => {
  assert.doesNotThrow(() => assertProtocolV2InstructionEvidence(draft, [{ case_id: "pause", model_call_receipts: [] }]));
});
