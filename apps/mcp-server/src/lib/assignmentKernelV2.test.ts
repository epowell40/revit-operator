import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
  ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
  ASSIGNMENT_KERNEL_V2_BINDING_META_KEY,
  ASSIGNMENT_KERNEL_V2_META_KEY,
  beginAssignmentKernelNativeRequestV2,
  currentAssignmentKernelV2Binding,
  decorateAssignmentKernelMcpResultV2,
  markAssignmentKernelNativeRequestDispatchingV2,
  recordAssignmentKernelNativeResultV2,
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

function payloadRegressionFixture(name: string): any {
  const relative = path.join("contracts", "assignment-kernel-v2", "payload-digest", name);
  const candidates = [
    path.resolve(process.cwd(), "..", "..", relative),
    path.resolve(process.cwd(), "..", relative)
  ];
  const fixturePath = candidates.find(candidate => existsSync(candidate));
  assert.ok(fixturePath, `Missing payload regression fixture ${name}`);
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function meta(
  effect: "read" | "preview" | "apply" = "read",
  purpose = "work",
  nativeRequest?: { method: "GET" | "POST"; path: string }
) {
  return {
    [ASSIGNMENT_KERNEL_V2_META_KEY]: {
      schema: ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA,
      assignment_id: binding.assignment_id,
      binding,
      operation_id: "operation-1",
      capability_id: "inventory.read",
      requested_effect: effect,
      purpose,
      operation_role: "root",
      root_operation_id: "operation-1",
      blocks_parent_settlement: false,
      request_identity: {
        capability_id: "inventory.read",
        ...nativeRequest,
        request_signature: "inventory-read-request"
      },
      opened_at: "2026-08-26T15:00:00.000Z",
      deadline_at: "2026-08-26T15:04:00.000Z"
    }
  };
}

test("native result is normalized once into an explicit OperationResultV2 and semantic facts", async () => {
  const decorated = await runWithAssignmentKernelV2(meta("read", "work", { method: "POST", path: "/revit/find-elements" }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/find-elements");
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/find-elements", {
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
    }, request);
    return decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: "bounded model projection" }] }, "inventory.read") as any;
  });
  assert.equal(decorated.structuredContent.schema, ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA);
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "native-host");
  assert.ok(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "inventory.total" && fact.value === 2));
  assert.ok(decorated.structuredContent.observation.semantic_facts.some((fact: any) => fact.fact_id === "inventory.group" && fact.value === 2));
});

test("Candidate 2 tool-registry payload uses the cross-process ordinal digest", async () => {
  const fixture = payloadRegressionFixture("candidate2-tool-registry-sanitized.json");
  const decorated = await runWithAssignmentKernelV2(
    meta("read", "discovery", { method: "GET", path: "/revit/tool-registry" }),
    async () => {
      const request = await beginAssignmentKernelNativeRequestV2("GET", "/revit/tool-registry");
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("GET", "/revit/tool-registry", fixture.payload, request);
      return decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
    }
  ) as any;
  assert.equal(
    decorated.structuredContent.operation_result_v2.raw_payload_hash,
    "a7c639107bc169b5077712e82bd0c2f9886c3d8bde34c7599dff966097e12f40"
  );
  const { canonical_attempt_settlement: _control, ...expectedObservationPayload } = fixture.payload;
  assert.deepEqual(decorated.structuredContent.observation.raw_payload, expectedObservationPayload);
  assert.equal(decorated.structuredContent.operation_result_v2.payload_provenance.source.representation, "utf8_json_bytes");
  assert.equal(decorated.structuredContent.operation_result_v2.payload_provenance.normalized.representation, "canonical_json");
  assert.equal(
    decorated.structuredContent.operation_result_v2.payload_provenance.transformation_id,
    "revit-operator.native-result-control-extraction"
  );
});

test("source field spelling aliases normalize to identical semantic fact identities", async () => {
  async function facts(payload: unknown) {
    return await runWithAssignmentKernelV2(meta("read", "work", { method: "POST", path: "/transport-only" }), async () => {
      const request = await beginAssignmentKernelNativeRequestV2("POST", "/transport-only");
      await markAssignmentKernelNativeRequestDispatchingV2(request);
      await recordAssignmentKernelNativeResultV2("POST", "/transport-only", {
        ...(payload as object),
        canonical_attempt_settlement: { attempt_id: "receipt", requested_effect: "read", effect_state: "none", request_dispatched: true }
      }, request);
      return (decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any).structuredContent.observation.semantic_facts;
    });
  }
  const camel = await facts({ totalCount: 1, items: [{ familyName: "A", typeName: "B" }] });
  const snake = await facts({ total_count: 1, items: [{ family_name: "A", type_name: "B" }] });
  const select = (rows: any[]) => rows.filter(row => row.fact_id === "inventory.total" || row.fact_id === "inventory.group");
  assert.deepEqual(select(camel), select(snake));
});

test("native request correlation is derived from the canonical Operation and survives result settlement", async () => {
  const decorated = await runWithAssignmentKernelV2(meta("read", "work", { method: "POST", path: "/revit/schedules" }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/revit/schedules");
    assert.match(request?.request_id ?? "", /^[0-9a-f]{64}$/);
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/schedules", {
      schedules: [{ id: 1 }],
      canonical_attempt_settlement: {
        attempt_id: "native-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, request);
    const result = decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
    assert.equal(result.structuredContent.operation_result_v2.native_correlation_id, request?.request_id);
    return result;
  });
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
});

test("Candidate 1 prerequisite and parent native calls retain distinct operation identities", async () => {
  const childLeases: any[] = [];
  const settled: any[] = [];
  const edge = {
    async openChild(input: any) {
      const lease = {
        ...meta()[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: `child-${input.child_ordinal}`,
        capability_id: input.capability_id,
        requested_effect: "read",
        purpose: "discovery",
        operation_role: input.operation_role,
        parent_operation_id: input.parent_operation_id,
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: `child-signature-${input.child_ordinal}`
        }
      };
      childLeases.push(lease);
      return lease as any;
    },
    async markDispatch() {},
    async settle(lease: any, result: any) {
      settled.push({ lease, result });
      return { settled: true };
    }
  };
  const decorated = await runWithAssignmentKernelV2({
    [ASSIGNMENT_KERNEL_V2_META_KEY]: {
      ...meta()[ASSIGNMENT_KERNEL_V2_META_KEY],
      capability_id: "revit_call_tool",
      request_identity: {
        capability_id: "revit_call_tool",
        method: "POST",
        path: "/revit/quantify",
        request_signature: "request-quantify"
      }
    }
  }, async () => {
    const prerequisite = await beginAssignmentKernelNativeRequestV2("GET", "/revit/tool-registry", undefined, {
      operation_role: "prerequisite"
    });
    assert.notEqual(prerequisite?.operation_id, "operation-1");
    await markAssignmentKernelNativeRequestDispatchingV2(prerequisite);
    await recordAssignmentKernelNativeResultV2("GET", "/revit/tool-registry", {
      tools: [{ method: "POST", path: "/revit/quantify" }],
      canonical_attempt_settlement: {
        attempt_id: "registry-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, prerequisite);

    const parent = await beginAssignmentKernelNativeRequestV2("POST", "/revit/quantify");
    assert.equal(parent?.operation_id, "operation-1");
    await markAssignmentKernelNativeRequestDispatchingV2(parent);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/quantify", {
      total: 509,
      canonical_attempt_settlement: {
        attempt_id: "quantify-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, parent);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "revit_call_tool") as any;
  }, edge);
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.observation.raw_payload.total, 509);
  assert.equal(decorated.structuredContent.child_operation_results_v2.length, 1);
  assert.notEqual(decorated.structuredContent.child_operation_results_v2[0].operation_id, "operation-1");
  assert.equal(childLeases[0].parent_operation_id, "operation-1");
  assert.equal(settled[0].result.structuredContent.operation_result_v2.operation_id, childLeases[0].operation_id);
  assert.equal(settled[0].result.structuredContent.observation.raw_payload.tools[0].path, "/revit/quantify");
});

test("typed MCP parent retains controller identity while its exact native action settles as a child", async () => {
  const settled: any[] = [];
  const edge = {
    async openChild(input: any) {
      return {
        ...meta()[ASSIGNMENT_KERNEL_V2_META_KEY],
        operation_id: "native-child-1",
        capability_id: input.capability_id,
        requested_effect: "read",
        purpose: "work",
        operation_role: "child",
        parent_operation_id: "operation-1",
        root_operation_id: "operation-1",
        blocks_parent_settlement: true,
        request_identity: {
          capability_id: input.capability_id,
          method: input.method,
          path: input.path,
          request_signature: "native-child-signature"
        }
      } as any;
    },
    async markDispatch() {},
    async settle(lease: any, result: any) {
      settled.push({ lease, result });
      return { operation_id: lease.operation_id, settled: true };
    }
  };
  const decorated = await runWithAssignmentKernelV2(meta(), async () => {
    const native = await beginAssignmentKernelNativeRequestV2("POST", "/revit/find-elements");
    assert.equal(native?.operation_role, "child");
    assert.equal(native?.parent_operation_id, "operation-1");
    await markAssignmentKernelNativeRequestDispatchingV2(native);
    await recordAssignmentKernelNativeResultV2("POST", "/revit/find-elements", {
      total: 2,
      canonical_attempt_settlement: {
        attempt_id: "typed-native-receipt",
        requested_effect: "read",
        effect_state: "none",
        request_dispatched: true
      }
    }, native);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, "inventory.read") as any;
  }, edge);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].result.structuredContent.operation_result_v2.operation_id, "native-child-1");
  assert.equal(decorated.structuredContent.operation_result_v2.operation_id, "operation-1");
  assert.equal(decorated.structuredContent.operation_result_v2.status, "completed_without_native_dispatch");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "operator-mcp-transport");
  assert.equal(decorated.structuredContent.child_operation_results_v2[0].operation_id, "native-child-1");
  assert.equal(decorated.structuredContent.observation, undefined);
});

test("retained evidence retrieval settles as a non-native read and cannot claim mutation", async () => {
  const decorated = await runWithAssignmentKernelV2(meta("read", "evidence_read"), async () =>
    decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: "focused retained selection" }] }, "operator_retrieve_evidence") as any);
  assert.equal(decorated.structuredContent.operation_result_v2.status, "succeeded");
  assert.equal(decorated.structuredContent.operation_result_v2.authority, "operator-evidence-store");
  assert.equal(decorated.structuredContent.operation_result_v2.persistent_effect, "none");
});

test("read context rejects a contradictory native applied settlement", async () => {
  await assert.rejects(() => runWithAssignmentKernelV2(meta("read", "work", { method: "POST", path: "/transport-only" }), async () => {
    const request = await beginAssignmentKernelNativeRequestV2("POST", "/transport-only");
    await markAssignmentKernelNativeRequestDispatchingV2(request);
    await recordAssignmentKernelNativeResultV2("POST", "/transport-only", {
      ok: true,
      canonical_attempt_settlement: { attempt_id: "receipt", requested_effect: "apply", effect_state: "applied", request_dispatched: true }
    }, request);
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
