import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadDurableToolEvidence } from "../src/benchmark/durable_tool_evidence.js";
import { summarizeGeneralRevitLatency } from "../src/benchmark/general_revit_latency.js";

const sessionId = "candidate-53-session";
const assignmentId = "candidate-53-assignment";
const binding = {
  assignment_id: assignmentId,
  run_id: "sidecar:candidate-53-run",
  generation: 1,
  session_id: sessionId,
  principal_id: "local:test"
};

function operation(input: {
  operationId: string;
  capabilityId: string;
  fulfillmentRole: "supporting_control" | "delegated_task_execution";
  resultSchemaId: string;
  requestPath: string;
  evidenceClass: "control" | "task_result";
}) {
  const observationId = `observation:${input.operationId}`;
  return {
    operation: {
      schema: "revit-operator.operation/v2",
      operation_id: input.operationId,
      binding,
      work_unit_id: "work-unit-candidate-53",
      capability_id: input.capabilityId,
      requested_effect: "read",
      purpose: input.fulfillmentRole === "delegated_task_execution" ? "work" : "discovery",
      operation_role: "root",
      fulfillment_role: input.fulfillmentRole,
      request_identity: {
        capability_id: input.capabilityId,
        method: "POST",
        path: input.requestPath,
        request_signature: `signature:${input.operationId}`
      },
      advances_criterion_ids: [],
      eligible_criterion_ids: input.fulfillmentRole === "delegated_task_execution" ? ["criterion-inventory"] : [],
      resolves_gap_ids: [],
      target: {},
      input: {},
      admission_state: "admitted",
      dispatch_state: "dispatched",
      persistent_effect: "none",
      settlement_state: "settled",
      observation_ids: [observationId],
      verification_operation_ids: [],
      opened_at: "2026-09-02T12:00:00.000Z",
      deadline_at: "2026-09-02T12:05:00.000Z",
      settled_at: "2026-09-02T12:00:01.000Z",
      result: {
        schema: "revit-operator.operation-result/v2",
        result_id: `result:${input.operationId}`,
        operation_id: input.operationId,
        binding,
        status: "succeeded",
        dispatch_state: "dispatched",
        persistent_effect: "none",
        native_transaction_state: "not_applicable",
        authority: "native_host",
        result_schema_id: input.resultSchemaId,
        observation_required: true,
        completed_at: "2026-09-02T12:00:01.000Z",
        request_identity: {
          capability_id: input.capabilityId,
          method: "POST",
          path: input.requestPath,
          request_signature: `signature:${input.operationId}`
        }
      }
    },
    observation: {
      schema: "revit-operator.observation/v2",
      observation_id: observationId,
      operation_id: input.operationId,
      binding,
      evidence_class: input.evidenceClass,
      result_schema_id: input.resultSchemaId
    }
  };
}

function bundle(entries: ReturnType<typeof operation>[]) {
  return {
    schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
    session_index: {
      schema: "revit-operator.assignment-kernel-session-index/v2",
      session_id: sessionId,
      assignments: [{ assignment_id: assignmentId, assignment_version: 12, binding, outcome: "in_progress", terminal: false }]
    },
    assignment_ids: [assignmentId],
    assignments: [{
      schema: "revit-operator.assignment-kernel-publication/v2",
      assignment_id: assignmentId,
      assignment_version: 12,
      snapshot: {
        schema: "revit-operator.assignment-snapshot/v2",
        assignment_version: 12,
        current_binding: binding,
        provider_call_ids: [],
        provider_calls: {},
        in_flight_provider_call_ids: [],
        operations: Object.fromEntries(entries.map((entry) => [entry.operation.operation_id, entry.operation])),
        observations: Object.fromEntries(entries.map((entry) => [entry.observation.observation_id, entry.observation]))
      },
      provider_ledger: {
        schema: "revit-operator.assignment-provider-ledger/v2",
        assignment_id: assignmentId,
        run_id: binding.run_id,
        generation: binding.generation,
        assignment_version: 12,
        call_ids: [],
        calls: {},
        in_flight_call_ids: []
      }
    }],
    failures: []
  };
}

function taggedNotification(operationId: string) {
  return {
    id: 53,
    ts: "2026-09-02T12:00:01.000Z",
    type: "codex.tool_call",
    payload: {
      server: "revit_operator",
      tool: "revit_tool_doc",
      status: "success",
      arguments: { method: "POST", path: "/revit/quantify" },
      result: [{
        type: "inputText",
        text: JSON.stringify({
          ok: true,
          evidence_projections: [{
            schema: "revit-operator.evidence-projection.v1",
            source: "assignment_kernel_v2:test",
            assignment_id: assignmentId,
            attempt_id: operationId,
            run_id: binding.run_id,
            generation: binding.generation
          }]
        })
      }]
    }
  };
}

async function withServer<T>(notifications: unknown[], run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url?.startsWith("/api/notifications")
      ? { notifications, next_after_id: notifications.length > 0 ? 53 : 0 }
      : { goal: { action_log: [] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Candidate 53 bound tool-documentation notification cannot promote its target as executed Revit work", async () => {
  const control = operation({
    operationId: "operation-tool-doc",
    capabilityId: "revit_tool_doc",
    fulfillmentRole: "supporting_control",
    resultSchemaId: "operator-capability/revit_tool_doc/v2",
    requestPath: "/revit/quantify",
    evidenceClass: "control"
  });
  await withServer([taggedNotification(control.operation.operation_id)], async (baseUrl) => {
    const evidence = await loadDurableToolEvidence(baseUrl, { assignments: [] },
      "Count all air devices by family and type.",
      { session_id: sessionId, started_at: "2026-09-02T11:59:00.000Z" }, bundle([control]));
    assert.equal((evidence.session_result_receipts as unknown[]).length, 1);
    assert.deepEqual(evidence.successful_paths, []);
    assert.deepEqual(evidence.failed_paths, []);
  });
});

test("Candidate 53 exact V2 native task result supplies execution truth without notification inference", async () => {
  const task = operation({
    operationId: "operation-quantify",
    capabilityId: "revit_call_tool",
    fulfillmentRole: "delegated_task_execution",
    resultSchemaId: "operator-native/POST:/revit/quantify/v2",
    requestPath: "/revit/quantify",
    evidenceClass: "task_result"
  });
  await withServer([], async (baseUrl) => {
    const evidence = await loadDurableToolEvidence(baseUrl, { assignments: [] },
      "Count all air devices by family and type.",
      { session_id: sessionId, started_at: "2026-09-02T11:59:00.000Z" }, bundle([task]));
    assert.deepEqual(evidence.successful_paths, ["/revit/quantify"]);
    assert.deepEqual(evidence.failed_paths, []);
  });
});

test("V2 native evidence keeps an in-progress Observation commit pending instead of calling the publication malformed", async () => {
  const task = operation({
    operationId: "operation-observation-pending",
    capabilityId: "revit_call_tool",
    fulfillmentRole: "delegated_task_execution",
    resultSchemaId: "operator-native/POST:/revit/quantify/v2",
    requestPath: "/revit/quantify",
    evidenceClass: "task_result"
  });
  task.operation.settlement_state = "retaining_observation";
  task.operation.observation_ids = [];
  const publication = bundle([task]);
  publication.assignments[0]!.snapshot.observations = {};
  await withServer([], async (baseUrl) => {
    const evidence = await loadDurableToolEvidence(baseUrl, { assignments: [] },
      "Count all air devices by family and type.",
      { session_id: sessionId, started_at: "2026-09-02T11:59:00.000Z" }, publication);
    assert.deepEqual(evidence.successful_paths, []);
    const nativeEvidence = evidence.assignment_kernel_v2_native_evidence as Record<string, unknown>;
    assert.equal(nativeEvidence.present, true);
    assert.equal(nativeEvidence.malformed, false);
    assert.equal(nativeEvidence.operation_count, 1);
    assert.equal((nativeEvidence.operations as Array<Record<string, unknown>>)[0]?.outcome, "pending");
  });
});

test("V2 latency uses the native result contract and never counts a control wrapper's target route", () => {
  const control = operation({
    operationId: "operation-latency-tool-doc",
    capabilityId: "revit_tool_doc",
    fulfillmentRole: "supporting_control",
    resultSchemaId: "operator-capability/revit_tool_doc/v2",
    requestPath: "/revit/quantify",
    evidenceClass: "control"
  });
  const task = operation({
    operationId: "operation-latency-quantify",
    capabilityId: "revit_call_tool",
    fulfillmentRole: "delegated_task_execution",
    resultSchemaId: "operator-native/POST:/revit/quantify/v2",
    requestPath: "/revit/quantify",
    evidenceClass: "task_result"
  });
  const controlOnly = summarizeGeneralRevitLatency([{
    case_id: "candidate53-control-only",
    tool_results: { durable_assignment_kernel_v2: bundle([control]), durable_tool_evidence: {} },
    efficiency: {}
  }], {});
  assert.equal((controlOnly.revit_tool_duration as Record<string, unknown>).count, 0);
  assert.equal((controlOnly.by_revit_path as Record<string, unknown>)["/revit/quantify"], undefined);

  const actualTask = summarizeGeneralRevitLatency([{
    case_id: "candidate53-actual-task",
    tool_results: { durable_assignment_kernel_v2: bundle([control, task]), durable_tool_evidence: {} },
    efficiency: {}
  }], {});
  assert.equal((actualTask.revit_tool_duration as Record<string, unknown>).count, 1);
  assert.ok((actualTask.by_revit_path as Record<string, unknown>)["/revit/quantify"]);
});
