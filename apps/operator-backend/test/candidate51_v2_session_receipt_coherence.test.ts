import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { loadDurableToolEvidence } from "../src/benchmark/durable_tool_evidence.js";
import { resolveSessionReceiptOperationV2 } from "../src/benchmark/v2_session_receipt_binding.js";

test("typed parent notification binds one exact native child observation, never a foreign child", () => {
  const binding = { assignment_id: "typed-assignment", run_id: "sidecar:typed", generation: 1,
    session_id: "typed-session", principal_id: "local:test" };
  const parentId = "opv2_typed_parent";
  const childId = "opv2_typed_native_child";
  const result = (id: string, capabilityId: string, method?: string, path?: string) => ({
    schema: "revit-operator.operation-result/v2", result_id: `resultv2_${id}`,
    operation_id: id, binding, status: "succeeded", dispatch_state: "dispatched",
    persistent_effect: "none", request_identity: { capability_id: capabilityId,
      ...(method ? { method } : {}), ...(path ? { path } : {}), request_signature: `sig-${id}` }
  });
  const parent = { schema: "revit-operator.operation/v2", operation_id: parentId, binding,
    capability_id: "revit_get_context", requested_effect: "read", result: { ...result(parentId, "revit_get_context"), observation_required: false } };
  const child = { schema: "revit-operator.operation/v2", operation_id: childId, binding,
    parent_operation_id: parentId, root_operation_id: parentId, operation_role: "child",
    capability_id: "native:GET:/revit/context", requested_effect: "read",
    observation_ids: ["obsv2_typed_native_child"], result: { ...result(childId, "native:GET:/revit/context", "GET", "/revit/context"), observation_required: true } };
  const publication = { schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
    session_index: { schema: "revit-operator.assignment-kernel-session-index/v2", session_id: binding.session_id,
      assignments: [{ assignment_id: binding.assignment_id, assignment_version: 3, binding,
        outcome: "active", terminal: false }] },
    assignment_ids: [binding.assignment_id], assignments: [{
      schema: "revit-operator.assignment-kernel-publication/v2", assignment_id: binding.assignment_id,
      assignment_version: 3, snapshot: { schema: "revit-operator.assignment-snapshot/v2",
        assignment_version: 3, current_binding: binding, provider_call_ids: [], provider_calls: {},
        in_flight_provider_call_ids: [], operations: { [parentId]: parent, [childId]: child },
        observations: { obsv2_typed_native_child: { observation_id: "obsv2_typed_native_child", operation_id: childId,
          raw_payload_ref: "evidence:ev1_typed_native_child", binding } } },
      provider_ledger: { schema: "revit-operator.assignment-provider-ledger/v2",
        assignment_id: binding.assignment_id, run_id: binding.run_id, generation: 1,
        assignment_version: 3, call_ids: [], calls: {}, in_flight_call_ids: [] } }] };
  const parsedResult = { evidence_projections: [{ schema: "revit-operator.evidence-projection.v1",
    source: "assignment_kernel_v2:native:GET:/revit/context", assignment_id: binding.assignment_id,
    run_id: binding.run_id, generation: 1, attempt_id: childId, evidence_id: "ev1_typed_native_child" }] };
  const resolve = (kernel: unknown, session = binding.session_id) => resolveSessionReceiptOperationV2({
    assignmentKernelV2: kernel, expectedSessionId: session, toolName: "revit_get_context", parsedResult });
  assert.deepEqual(resolve(publication), { state: "bound", assignment_id: binding.assignment_id,
    operation_id: childId, capability_id: "native:GET:/revit/context", requested_effect: "read", method: "GET", path: "/revit/context" });
  assert.equal(resolve(publication, "other-session").state, "unresolved");
  const wrongChild = structuredClone(publication);
  wrongChild.assignments[0]!.snapshot.operations[childId].parent_operation_id = "opv2_foreign_parent";
  assert.deepEqual(resolve(wrongChild), { state: "unresolved", assignment_id: binding.assignment_id,
    operation_id: childId, reason: "v2_native_child_parent_mismatch" });
  const foreignEvidence = { evidence_projections: [{ ...parsedResult.evidence_projections[0],
    evidence_id: "ev1_foreign" }] };
  assert.deepEqual(resolveSessionReceiptOperationV2({ assignmentKernelV2: publication,
    expectedSessionId: binding.session_id, toolName: "revit_get_context", parsedResult: foreignEvidence }), {
    state: "unresolved", assignment_id: binding.assignment_id, operation_id: childId,
    reason: "v2_native_child_parent_mismatch" });
});

test("Candidate 51 V2-tagged discovery notification uses the exact published operation effect", async () => {
  const sessionId = "candidate-51-session";
  const assignmentId = "candidate-51-assignment";
  const operationId = "opv2_candidate51_search";
  const binding = {
    assignment_id: assignmentId,
    run_id: "sidecar:candidate-51-run",
    generation: 1,
    session_id: sessionId,
    principal_id: "local:test"
  };
  const notifications = [{
    id: 51,
    ts: "2026-09-02T09:49:49.780Z",
    type: "codex.tool_call",
    payload: {
      server: "revit_operator",
      tool: "revit_search_tools",
      status: "completed",
      error: null,
      arguments: {
        query: "complete project air terminal device count grouped by family and type",
        max: 5,
        includeSchemas: true,
        // A caller-shaped or stale transport field cannot override the exact
        // OperationV2 contract carried by the evidence projection.
        request_effect: "apply"
      },
      result: [{
        type: "inputText",
        text: JSON.stringify({
          schema: "revit-operator.model-evidence-envelope.v1",
          evidence_projections: [{
            schema: "revit-operator.evidence-projection.v1",
            evidence_id: "ev1_candidate51_search",
            assignment_id: assignmentId,
            run_id: binding.run_id,
            generation: binding.generation,
            attempt_id: operationId,
            source: "assignment_kernel_v2:revit_search_tools"
          }]
        })
      }]
    }
  }];
  const assignmentKernelV2 = {
    schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
    session_index: {
      schema: "revit-operator.assignment-kernel-session-index/v2",
      session_id: sessionId,
      assignments: [{
        assignment_id: assignmentId,
        assignment_version: 14,
        binding,
        outcome: "in_progress",
        terminal: false
      }]
    },
    assignment_ids: [assignmentId],
    assignments: [{
      schema: "revit-operator.assignment-kernel-publication/v2",
      assignment_id: assignmentId,
      assignment_version: 14,
      snapshot: {
        schema: "revit-operator.assignment-snapshot/v2",
        assignment_version: 14,
        current_binding: binding,
        provider_call_ids: [],
        provider_calls: {},
        in_flight_provider_call_ids: [],
        operations: {
          [operationId]: {
            schema: "revit-operator.operation/v2",
            operation_id: operationId,
            binding,
            capability_id: "revit_search_tools",
            requested_effect: "read",
            fulfillment_role: "supporting_control",
            result: {
              schema: "revit-operator.operation-result/v2",
              result_id: "resultv2_candidate51_search",
              operation_id: operationId,
              binding,
              status: "succeeded",
              dispatch_state: "dispatched",
              persistent_effect: "none",
              request_identity: {
                capability_id: "revit_search_tools",
                request_signature: "candidate51-search-signature"
              }
            }
          }
        }
      },
      provider_ledger: {
        schema: "revit-operator.assignment-provider-ledger/v2",
        assignment_id: assignmentId,
        run_id: binding.run_id,
        generation: binding.generation,
        assignment_version: 14,
        call_ids: [],
        calls: {},
        in_flight_call_ids: []
      }
    }],
    failures: []
  };

  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url?.startsWith("/api/notifications")
      ? { notifications, next_after_id: 51 }
      : { goal: { action_log: [] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const loadWithV2 = loadDurableToolEvidence as unknown as (...args: unknown[]) => Promise<Record<string, unknown>>;
    const evidence = await loadWithV2(
      `http://127.0.0.1:${address.port}`,
      { assignments: [] },
      "Count all air devices by family and type.",
      { session_id: sessionId, started_at: "2026-09-02T09:49:00.000Z" },
      assignmentKernelV2
    );
    const receipts = evidence.session_result_receipts as Array<Record<string, unknown>>;
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.path, "/revit/search-tools");
    assert.equal(receipts[0]?.request_effect, "read");
    assert.equal(receipts[0]?.requested_effect_source, "assignment_kernel_v2");
    assert.equal(receipts[0]?.canonical_assignment_id, assignmentId);
    assert.equal(receipts[0]?.canonical_operation_id, operationId);

    const parsedResult = {
      evidence_projections: [{
        schema: "revit-operator.evidence-projection.v1",
        assignment_id: assignmentId,
        run_id: binding.run_id,
        generation: binding.generation,
        attempt_id: operationId,
        source: "assignment_kernel_v2:revit_search_tools"
      }]
    };
    assert.deepEqual(resolveSessionReceiptOperationV2({
      assignmentKernelV2,
      expectedSessionId: sessionId,
      toolName: "revit_call_tool",
      parsedResult
    }), {
      state: "unresolved",
      assignment_id: assignmentId,
      operation_id: operationId,
      reason: "v2_capability_mismatch"
    });
    assert.deepEqual(resolveSessionReceiptOperationV2({
      assignmentKernelV2,
      expectedSessionId: sessionId,
      toolName: "revit_search_tools",
      parsedResult: {
        evidence_projections: [{
          schema: "revit-operator.evidence-projection.v1",
          assignment_id: assignmentId,
          run_id: binding.run_id,
          generation: binding.generation,
          source: "assignment_kernel_v2:revit_search_tools"
        }]
      }
    }), {
      state: "unresolved",
      assignment_id: assignmentId,
      operation_id: null,
      reason: "v2_evidence_projection_invalid"
    });
    assert.deepEqual(resolveSessionReceiptOperationV2({
      assignmentKernelV2,
      expectedSessionId: sessionId,
      toolName: "revit_search_tools",
      parsedResult: { status: "completed" }
    }), {
      state: "unresolved",
      assignment_id: assignmentId,
      operation_id: null,
      reason: "v2_evidence_projection_missing"
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
