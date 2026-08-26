import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
  ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
  ASSIGNMENT_KERNEL_V2_BINDING_META_KEY,
  ASSIGNMENT_KERNEL_V2_META_KEY,
  currentAssignmentKernelV2Binding,
  decorateAssignmentKernelMcpResultV2,
  markAssignmentKernelNativeRequestDispatchingV2,
  recordAssignmentKernelNativeResultV2,
  reserveAssignmentKernelNativeRequestV2,
  runWithAssignmentKernelV2
} from "./assignmentKernelV2.js";

const binding = {
  assignment_id: "assignment-1",
  run_id: "run-1",
  generation: 1,
  session_id: "session-1",
  principal_id: "principal-1",
  document_fingerprint: "document-1"
};

function meta(effect: "read" | "preview" | "apply" = "read", purpose = "work") {
  return {
    [ASSIGNMENT_KERNEL_V2_META_KEY]: {
      schema: ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
      assignment_id: binding.assignment_id,
      binding,
      operation_id: "operation-1",
      capability_id: "inventory.read",
      requested_effect: effect,
      purpose,
      opened_at: "2026-08-26T15:00:00.000Z",
      deadline_at: "2026-08-26T15:04:00.000Z"
    }
  };
}

test("native result is normalized once into an explicit OperationResultV2 and semantic facts", async () => {
  const decorated = await runWithAssignmentKernelV2(meta(), async () => {
    recordAssignmentKernelNativeResultV2("POST", "/revit/find-elements", {
      totalCount: 2,
      items: [
        { familyName: "Supply Diffuser", typeName: "24x24" },
        { family_name: "Supply Diffuser", type_name: "24x24" }
      ],
      canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1",
        attempt_id: "native-attempt-1",
        requested_effect: "read",
        effect_state: "none",
        effect_authority: "native_receipt",
        request_dispatched: true
      }
    });
    return decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: "bounded model projection" }] }, "inventory.read") as any;
  });
  assert.equal(decorated.structuredContent.schema, ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA);
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "native-host");
  assert.ok(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "inventory.total" && fact.value === 2));
  assert.ok(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "inventory.group" && fact.value === 2));
});

test("source field spelling aliases normalize to identical semantic fact identities", async () => {
  async function facts(payload: unknown) {
    return await runWithAssignmentKernelV2(meta(), async () => {
      recordAssignmentKernelNativeResultV2("POST", "/transport-only", {
        ...(payload as object),
        canonical_attempt_settlement: { attempt_id: "receipt", requested_effect: "read", effect_state: "none", request_dispatched: true }
      });
      return (decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any).structuredContent.observation.semantic_facts;
    });
  }
  const camel = await facts({ totalCount: 1, items: [{ familyName: "A", typeName: "B" }] });
  const snake = await facts({ total_count: 1, items: [{ family_name: "A", type_name: "B" }] });
  const select = (rows: any[]) => rows.filter(row => row.fact_id === "inventory.total" || row.fact_id === "inventory.group");
  assert.deepEqual(select(camel), select(snake));
});

test("native request correlation is derived from the canonical Operation and survives result settlement", async () => {
  const decorated = await runWithAssignmentKernelV2(meta(), async () => {
    const requestId = reserveAssignmentKernelNativeRequestV2("POST", "/revit/schedules");
    assert.match(requestId ?? "", /^[0-9a-f]{64}$/);
    markAssignmentKernelNativeRequestDispatchingV2(requestId);
    recordAssignmentKernelNativeResultV2("POST", "/revit/schedules", {
      schedules: [{ id: 1 }],
      canonical_attempt_settlement: {
        attempt_id: "native-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, requestId);
    const result = decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
    assert.equal(result.structuredContent.operation_result_v2.native_correlation_id, requestId);
    return result;
  });
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
});

test("retained evidence retrieval settles as a non-native read and cannot claim mutation", async () => {
  const decorated = await runWithAssignmentKernelV2(meta("read", "evidence_read"), async () =>
    decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: "focused retained selection" }] }, "operator_retrieve_evidence") as any);
  assert.equal(decorated.structuredContent.operation_result_v2.status, "succeeded");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "operator-evidence-store");
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
});

test("read context rejects a contradictory native applied settlement", async () => {
  await assert.rejects(() => runWithAssignmentKernelV2(meta("read"), async () => {
    recordAssignmentKernelNativeResultV2("POST", "/transport-only", {
      ok: true,
      canonical_attempt_settlement: { attempt_id: "receipt", requested_effect: "apply", effect_state: "applied", request_dispatched: true }
    });
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read");
  }), /read_effect_conflict/);
});

test("without trusted V2 meta, transport output is unchanged", async () => {
  const original = { content: [{ type: "text", text: "legacy" }] };
  const result = await runWithAssignmentKernelV2({}, async () => decorateAssignmentKernelMcpResultV2(original, "legacy"));
  assert.equal(result, original);
});

test("trusted host binding is available to lifecycle tools without model-authored identifiers", async () => {
  const seen = await runWithAssignmentKernelV2({ [ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]: binding }, async () => {
    return currentAssignmentKernelV2Binding();
  });
  assert.deepEqual(seen, binding);
  assert.equal(currentAssignmentKernelV2Binding(), null);
});

test("malformed trusted lifecycle binding fails before a lifecycle handler can dispatch", async () => {
  await assert.rejects(
    () => runWithAssignmentKernelV2({ [ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]: { ...binding, generation: 0 } }, async () => "unreachable"),
    /assignment_kernel_v2_binding_context_invalid/
  );
});
