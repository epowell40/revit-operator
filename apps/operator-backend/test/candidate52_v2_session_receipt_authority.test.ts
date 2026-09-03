import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadDurableToolEvidence } from "../src/benchmark/durable_tool_evidence.js";
import { resolveSessionReceiptOperationV2 } from "../src/benchmark/v2_session_receipt_binding.js";

const sessionId = "candidate-52-session";
const assignmentId = "candidate-52-assignment";
const binding = {
  assignment_id: assignmentId,
  run_id: "sidecar:candidate-52-run",
  generation: 1,
  session_id: sessionId,
  principal_id: "local:test"
};

const assignmentKernelV2 = {
  schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
  session_index: {
    schema: "revit-operator.assignment-kernel-session-index/v2",
    session_id: sessionId,
    assignments: [{
      assignment_id: assignmentId,
      assignment_version: 9,
      binding,
      outcome: "in_progress",
      terminal: false
    }]
  },
  assignment_ids: [assignmentId],
  assignments: [{
    schema: "revit-operator.assignment-kernel-publication/v2",
    assignment_id: assignmentId,
    assignment_version: 9,
    snapshot: {
      schema: "revit-operator.assignment-snapshot/v2",
      assignment_version: 9,
      current_binding: binding,
      provider_call_ids: [],
      provider_calls: {},
      in_flight_provider_call_ids: [],
      operations: {}
    },
    provider_ledger: {
      schema: "revit-operator.assignment-provider-ledger/v2",
      assignment_id: assignmentId,
      run_id: binding.run_id,
      generation: binding.generation,
      assignment_version: 9,
      call_ids: [],
      calls: {},
      in_flight_call_ids: []
    }
  }],
  failures: []
};

const untaggedFailedSearchNotification = {
  id: 52,
  ts: "2026-09-02T11:24:31.241Z",
  type: "codex.tool_call",
  payload: {
    server: "revit_operator",
    tool: "revit_search_tools",
    status: "failed",
    error: "tool invocation failed before V2 operation admission",
    arguments: {
      query: "air terminals grouped by family and type",
      max: 5
    },
    result: [{
      type: "inputText",
      text: JSON.stringify({ status: "failed", request_dispatched: false })
    }]
  }
};

async function withNotificationServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url?.startsWith("/api/notifications")
      ? { notifications: [untaggedFailedSearchNotification], next_after_id: 52 }
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

test("Candidate 52 known V2 session rejects an untagged legacy notification instead of inferring execution truth", async () => {
  assert.deepEqual(resolveSessionReceiptOperationV2({
    assignmentKernelV2,
    expectedSessionId: sessionId,
    toolName: "revit_search_tools",
    parsedResult: { status: "failed", request_dispatched: false }
  }), {
    state: "unresolved",
    assignment_id: assignmentId,
    operation_id: null,
    reason: "v2_evidence_projection_missing"
  });

  await withNotificationServer(async (baseUrl) => {
    const evidence = await loadDurableToolEvidence(
      baseUrl,
      { assignments: [] },
      "Count all air devices by family and type.",
      { session_id: sessionId, started_at: "2026-09-02T11:24:00.000Z" },
      assignmentKernelV2
    );
    assert.deepEqual(evidence.session_result_receipts, []);
    assert.deepEqual(evidence.failed_paths, []);
    assert.deepEqual(evidence.historical_failed_paths, []);
    assert.deepEqual(evidence.session_result_receipt_policy, {
      mode: "exact_v2_operation_binding",
      binding_required: true,
      rejected_count: 1
    });
    assert.deepEqual(evidence.session_result_receipt_rejections, [{
      notification_id: 52,
      notification_ts: "2026-09-02T11:24:31.241Z",
      source_session_id: sessionId,
      tool: "revit_search_tools",
      status: "failed",
      assignment_id: assignmentId,
      operation_id: null,
      reason: "v2_evidence_projection_missing"
    }]);
  });
});

test("historical V1 notification projection remains isolated when no V2 Assignment exists", async () => {
  await withNotificationServer(async (baseUrl) => {
    const evidence = await loadDurableToolEvidence(
      baseUrl,
      { assignments: [] },
      "Count all air devices by family and type.",
      { session_id: sessionId, started_at: "2026-09-02T11:24:00.000Z" }
    );
    assert.equal((evidence.session_result_receipts as unknown[]).length, 1);
    assert.deepEqual(evidence.session_result_receipt_rejections, []);
    assert.deepEqual(evidence.session_result_receipt_policy, {
      mode: "legacy_v1_notification_projection",
      binding_required: false,
      rejected_count: 0
    });
  });
});
