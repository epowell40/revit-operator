import assert from "node:assert/strict";
import test from "node:test";
import { presentDynamicProgramResult } from "./dynamicProgramPresentation.js";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { runWithAssignmentKernelV2, decorateAssignmentKernelMcpResultV2, recordAssignmentKernelDynamicResultV2, beginAssignmentKernelDynamicDispatchV2,
  ASSIGNMENT_KERNEL_V2_META_KEY, ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA } from "./assignmentKernelV2.js";

const capability = "operator_run_dynamic_revit_program";
const binding = { assignment_id: "dynamic-assignment", run_id: "dynamic-turn", generation: 1, session_id: "pilot", principal_id: "local:pilot", document_fingerprint: "a".repeat(64) };
function meta(effect: "read" | "preview" | "apply" = "read") {
  return { [ASSIGNMENT_KERNEL_V2_META_KEY]: { schema: ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA, assignment_id: binding.assignment_id, binding,
    operation_id: "dynamic-operation", capability_id: capability, requested_effect: effect, purpose: "work", operation_role: "root", root_operation_id: "dynamic-operation",
    blocks_parent_settlement: false, fulfillment_role: "delegated_task_execution", delegation_authority_id: "delegation:dynamic-operation", eligible_criterion_ids: ["report"],
    request_identity: { capability_id: capability, request_signature: "source-and-mode-bound" }, opened_at: "2026-09-14T02:00:00Z", deadline_at: "2026-09-14T02:04:00Z" } };
}
function result(mode = "read", success = true) {
  return { schema: "revit-operator.dynamic-revit-program-run.v1", requested_mode: mode, execution_ok: success, execution_status: success ? "completed" : "failed",
    report: { Inspected: "20", "Type: Rectangular": "20", Limit: "Bounded snapshot sample; not a complete model inventory." },
    iteration: { source_sha256: "sha256:" + "b".repeat(64) }, verification: { evidence_sha256: "sha256:" + "c".repeat(64) },
    evidence: { snapshotReceipt: JSON.stringify({ document: { ProjectFingerprint: "sha256:" + binding.document_fingerprint } }), previewReceipt: "",
      hostAuthenticationReceipts: ["authenticated-bootstrap", "authenticated-snapshot"], workerOutput: { ok: success, graph: { operations: [] } }, failure: success ? null : "CS0103: unknown member" } };
}

test("trusted generated report crosses the MCP boundary as bound task evidence", async () => {
  const payload = result();
  const output: any = await runWithAssignmentKernelV2(meta(), async () => {
    beginAssignmentKernelDynamicDispatchV2(); recordAssignmentKernelDynamicResultV2(payload);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, capability);
  });
  const r = output.structuredContent.operation_result_v2;
  assert.equal(r.authority, "dynamic-runtime"); assert.equal(r.status, "succeeded"); assert.equal(r.request_identity.capability_id, capability);
  assert.equal(r.persistent_effect, "none"); assert.equal(r.native_transaction_state, "not_applicable");
  assert.equal(r.raw_payload_hash, payloadDigestV2(payload).digest);
  assert.deepEqual(output.structuredContent.observation.raw_payload.report, payload.report);
  assert.deepEqual(output.structuredContent.observation.semantic_facts, [{ fact_id: "task.result_available", fact_class: "domain", value: true }]);
});

test("generated support read retains its successful result without attaching task facts to control evidence", async () => {
  const metadata: any = meta();
  metadata[ASSIGNMENT_KERNEL_V2_META_KEY].fulfillment_role = "supporting_control";
  metadata[ASSIGNMENT_KERNEL_V2_META_KEY].eligible_criterion_ids = [];
  delete metadata[ASSIGNMENT_KERNEL_V2_META_KEY].delegation_authority_id;
  const payload = result();
  const output: any = await runWithAssignmentKernelV2(metadata, async () => {
    beginAssignmentKernelDynamicDispatchV2(); recordAssignmentKernelDynamicResultV2(payload);
    return decorateAssignmentKernelMcpResultV2({ content: [] }, capability);
  });
  assert.equal(output.structuredContent.operation_result_v2.status, "succeeded");
  assert.equal(output.structuredContent.operation_result_v2.persistent_effect, "none");
  assert.equal(output.structuredContent.observation.evidence_class, "control");
  assert.deepEqual(output.structuredContent.observation.semantic_facts, []);
  assert.deepEqual(output.structuredContent.observation.raw_payload.report, payload.report);
});

test("caller-authored dynamic-shaped content cannot acquire runtime authority", async () => {
  const output: any = await runWithAssignmentKernelV2(meta(), async () => decorateAssignmentKernelMcpResultV2({ content: [{ type: "text", text: JSON.stringify(result()) }] }, capability));
  assert.equal(output.structuredContent.operation_result_v2.authority, "operator-mcp-transport");
  assert.equal(output.structuredContent.operation_result_v2.observation_required, false);
});

test("bounded failure presentation preserves the original canonical observation and digest", async () => {
  const payload = { ...result("preview", false), diagnostics: [{ code: "CS0103", line: 8, column: 38 }],
    iteration: { source_sha256: "sha256:" + "b".repeat(64), task_session_id: "task-289013d60cff4ff0a782e5a1e7ac2ce6" } };
  const output: any = await runWithAssignmentKernelV2(meta("preview"), async () => {
    beginAssignmentKernelDynamicDispatchV2(); recordAssignmentKernelDynamicResultV2(payload);
    return decorateAssignmentKernelMcpResultV2({ isError: true,
      content: [{ type: "text", text: JSON.stringify(presentDynamicProgramResult(payload)) }] }, capability);
  });
  assert.equal(output.isError, true);
  assert.equal(output.structuredContent.operation_result_v2.raw_payload_hash, payloadDigestV2(payload).digest);
  assert.deepEqual(output.structuredContent.observation.raw_payload, payload);
  assert.equal(output.structuredContent.operation_result_v2.persistent_effect, "none");
  assert.deepEqual(output.structuredContent.observation.semantic_facts, []);
  assert.equal(JSON.parse(output.content[0].text).diagnostics[0].line, 8);
  assert.equal(JSON.parse(output.content[0].text).evidence, undefined);
});

test("an empty-graph report requested as preview cannot claim a native rollback preview", async () => {
  const payload = result("preview");
  const output: any = await runWithAssignmentKernelV2(meta("preview"), async () => {
    beginAssignmentKernelDynamicDispatchV2();
    recordAssignmentKernelDynamicResultV2({ ...payload, evidence: { ...payload.evidence,
      previewReceipt: JSON.stringify({ schema: "dynamic-revit-read-report-receipt/v0", ok: true }) } });
    return decorateAssignmentKernelMcpResultV2({ content: [] }, capability);
  });
  assert.equal(output.structuredContent.operation_result_v2.native_transaction_state, "not_applicable");
  assert.equal(output.structuredContent.observation.semantic_facts.some((f: any) => f.fact_id === "task.preview_valid"), false);
});

test("dynamic report rejects another document, another mode, and missing authenticated host evidence", async () => {
  for (const changed of [
    { ...result(), requested_mode: "apply" },
    { ...result(), evidence: { ...result().evidence, snapshotReceipt: JSON.stringify({ document: { ProjectFingerprint: "sha256:" + "d".repeat(64) } }) } },
    { ...result(), evidence: { ...result().evidence, hostAuthenticationReceipts: [] } }
  ]) await runWithAssignmentKernelV2(meta(), async () => {
    beginAssignmentKernelDynamicDispatchV2(); assert.throws(() => recordAssignmentKernelDynamicResultV2(changed), /assignment_dynamic_result_/);
  });
});

test("lost dynamic apply completion stays unknown while failed compilation stays no-effect and retains diagnostics", async () => {
  for (const mode of ["read", "preview", "apply"] as const) {
    const missing: any = await runWithAssignmentKernelV2(meta(mode), async () => {
      beginAssignmentKernelDynamicDispatchV2(); return decorateAssignmentKernelMcpResultV2({ isError: true, content: [] }, capability);
    });
    assert.equal(missing.structuredContent.operation_result_v2.persistent_effect, mode === "apply" ? "unknown" : "none");
    const compilation: any = await runWithAssignmentKernelV2(meta(mode), async () => {
      beginAssignmentKernelDynamicDispatchV2(); recordAssignmentKernelDynamicResultV2(result(mode, false));
      return decorateAssignmentKernelMcpResultV2({ isError: true, content: [] }, capability);
    });
    assert.equal(compilation.structuredContent.operation_result_v2.persistent_effect, "none");
    assert.equal(compilation.structuredContent.observation.raw_payload.evidence.failure, "CS0103: unknown member");
    assert.deepEqual(compilation.structuredContent.observation.semantic_facts, []);
  }
});
