import assert from "node:assert/strict";
import test from "node:test";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
const source = () => ({ ok: true, assignment_snapshot_v2: {
  schema: "revit-operator.assignment-snapshot/v2", assignment_version: 7,
  current_binding: { assignment_id: "task", run_id: "run", generation: 1 }, outcome: "complete", terminal: false,
  quiescent: false, in_flight_provider_call_ids: ["provider"], unresolved_unknown_operation_ids: [],
  criteria: { c: { criterion_id: "c", status: "pass", reason: "Verified by readback" } },
  result_delivery: { items: [{ label: "Selected duct diameter", value: '4"ø', evidence_ref: "evidence:duct", observation_id: "o", path: ["diameter"] }] },
  operations: { registry: { observation_commit: { native_registry: "registry-data".repeat(20000) } } },
  observations: { o: {} }, provider_calls: { provider: {} }, spec: { input_variables: [] }, clarifications: {},
  pending_input_variable_ids: [], pending_review_ids: []
} });
function adapt(value: unknown, isError = false, tool = "operator_evaluate_assignment_criteria") {
  return adaptMcpToolCallResultToDynamicResponse({ isError, content: [{ type: "text", text: JSON.stringify(value) }] }, { tool });
}
test("criterion handoff keeps exact answer and completion barrier without repeating the registry", () => {
  const value = source(); const before = JSON.stringify(value);
  const result = adapt(value);
  const text = (result.contentItems[0] as any).text;
  assert.ok(text.length < 3000);
  const status = JSON.parse(text).assignment_status;
  assert.equal(status.schema, "revit-operator.assignment-status-for-model.v1");
  assert.deepEqual(status.result_delivery, value.assignment_snapshot_v2.result_delivery);
  assert.equal(status.outcome, "complete"); assert.equal(status.terminal, false);
  assert.equal(status.in_flight_provider_call_count, 1);
  assert.equal(status.retained_history.operations, 1);
  assert.doesNotMatch(text, /native_registry|registry-data/);
  assert.equal(JSON.stringify(value), before, "canonical payload remains byte-identical");
});
test("oversized result values are explicitly omitted with evidence references; pending questions and unknown effects remain visible", () => {
  const value = source() as any;
  const snapshot = value.assignment_snapshot_v2;
  snapshot.result_delivery.items[0].value = "large".repeat(50000);
  snapshot.outcome = "awaiting_user_input";
  snapshot.pending_input_variable_ids = ["wording"];
  snapshot.spec.input_variables = [{ variable_id: "wording", description: "Exact approved wording" }];
  snapshot.clarifications = { q: { question: "Which wording should I use?", variable_id: "wording" } };
  snapshot.unresolved_unknown_operation_ids = ["unsettled-write"];
  const text = (adapt(value, false, "operator_request_assignment_input").contentItems[0] as any).text;
  const status = JSON.parse(text).assignment_status;
  assert.ok(text.length < 30000); assert.deepEqual(status.result_delivery.items, []);
  assert.equal(status.result_delivery.omitted_evidence[0].evidence_ref, "evidence:duct");
  assert.equal(status.result_delivery.omitted_evidence[0].value_omitted, true);
  assert.equal(status.omitted["result_delivery.items"].count, 1);
  assert.equal(status.unresolved_unknown_operation_count, 1);
  assert.equal(status.clarifications[0].question, "Which wording should I use?");
});
test("errors and unknown snapshot schemas retain their exact diagnostic contract", () => {
  for (const value of [{ ok: false, error: "binding mismatch", assignment_snapshot_v2: source().assignment_snapshot_v2 },
    { ok: true, assignment_snapshot_v2: { schema: "unknown" } }, source()]) {
    for (const isError of [true, false]) {
      if (!isError && (value as any).assignment_snapshot_v2?.schema === "revit-operator.assignment-snapshot/v2" && value.ok) continue;
      assert.equal((adapt(value, isError).contentItems[0] as any).text, JSON.stringify(value));
    }
  }
  assert.equal((adapt(source(), false, "unrelated_tool").contentItems[0] as any).text, JSON.stringify(source()));
});
