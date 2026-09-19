import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { prepareAssignmentTurn, bindPreparedAssignmentToRequest } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { advanceAssignmentKernelProgressV2, recordAssignmentProviderCallStateV2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { openAssignmentKernelOperationV2, openAssignmentKernelChildOperationV2, settleAssignmentKernelOperationV2, failAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { supplyAssignmentInputResultV2, requestAssignmentInputV2, evaluateAssignmentObservationCriteriaV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
import { handleAssignmentHttpRoute } from "../src/assignments/http_routes.js";
import { getAssignmentKernelPublicationV2 } from "../src/assignments/assignment_kernel_v2_publication.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { parseAssignmentKernelPublicationV2 } from "@revitoperator/assignment-kernel-v2-contracts";
import { handleCodexDynamicToolCall } from "../src/brains/codex_dynamic_tool_handler.js";
import { checkpointCodexAssignmentProgressV2, finalCodexAssignmentMessageV2, codexAssignmentControllerStopMessage, prepareCodexAssignmentProgressV2 } from "../src/brains/codex_assignment_progress.js";
import { buildTeammateTurnContract } from "../src/teammate_loop_runtime.js";
import { canonicalTeammateInputs } from "../src/teammate_assignment_inputs.js";
import { mutationIntentBlockReason } from "../src/teammate_mutation_intent_binding.js";
import { completionOutboxKeyV2, retainCompletionOutboxV2 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA } from "../src/assignments/assignment_kernel_v2_execution.js";
import { renderTerminalResultV2 } from "../src/assignments/assignment_kernel_v2_terminal_result.js";
import { buildAssignmentResultDeliveryV2 } from "../src/assignments/assignment_kernel_v2_result_delivery.js";
import { canonicalTeammateFinalVerification } from "../src/teammate_assignment_inputs.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner, guardTeammateMcpCall, guardGenericTeammateDecision } from "../src/teammate_loop_runtime.js";
import { appendCurrentAssignmentKernelEventV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { deriveAndSettleAssignmentKernelV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
import { McpInputValidator } from "../src/codex/mcp_input_validation.js";
import { generatedParameterPayload, generatedParameterSource } from "./generated_parameter_postcondition.fixtures.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
import { CodexMcpToolRuntime } from "../src/codex/mcp_tool_runtime.js";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import { attachmentPdf } from "./pdf_attachment.fixtures.js";
import { deriveProgressGapsV2 } from "../src/domain/assignment-kernel/progress/controller.js";
import { retrieveEvidence, storeEvidence } from "../src/evidence/evidence_store.js";

async function workspace(fn: (root: string) => unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-controls-v2-"));
  const previous = [process.env.OPERATOR_WORKSPACE_ROOT, process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  __testOnlyResetGoalListCache();
  try { await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") }, () => fn(root)); }
  finally {
    __testOnlyResetGoalListCache();
    for (const [index, key] of ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function start(prompt = "Count all air devices in the model.") {
  const prepared = prepareAssignmentTurn({ sessionId: "controls-session", messageId: "first-turn", userText: prompt,
    toolResults: [], source: "chat", createdBy: null,
    requestContext: { revit: { document: { projectIdentity: { fingerprint: "controls-model" } } } } })!;
  return { prepared, binding: prepared.bindingV2!, snapshot: getAssignmentKernelSnapshotV2(prepared.assignmentId)! };
}

test("multi-room checklist HTTP retains scope across reload and rejects foreign or stale updates", () => workspace(async () => {
  const { binding } = start("Reconstruct all ductwork in both units from the record drawing.");
  const server = http.createServer((req, res) => {
    void runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") }, async () => {
      await handleAssignmentHttpRoute(req, res, new URL(req.url!, "http://localhost"), session => {
        if (session === binding.session_id) return true;
        res.writeHead(403).end(); return false;
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const send = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/assignments/v2/work-plan`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const body = { ...binding, action: "declare", declaration: { items: ["unit403", "unit407"].map(item_id => ({ item_id,
      description: `Reconstruct all visible branches in ${item_id}`, source_basis: "M104 source PDF" })), assumptions: ["Unshown elevation inferred"] } };
    assert.equal((await send({ ...body, session_id: "foreign" })).status, 403);
    assert.equal((await send({ ...body, generation: 99 })).status, 409);
    assert.equal((await send(body)).status, 200);
    __testOnlyResetGoalListCache();
    const status = await send({ ...binding, action: "status", start: 1 });
    assert.equal(status.status, 200);
    const restored = await status.json() as any;
    assert.equal(restored.work_plan.scope.items[0].item_id, "unit407");
    assert.equal(restored.work_plan.total_count, 2);
    assert.equal(restored.outcome, "active");
    assert.equal((await send(body)).status, 409);
    assert.equal((await send({ ...binding, action: "complete", item_id: "unit403", operation_ids: ["invented"] })).status, 409);
    assert.equal((await send({ ...binding, action: "status", start: -1 })).status, 409);
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.work_plan!.items.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}));

test("document reader inspects late pages beside a paused model task without changing its outcome or enabling native tools", () => workspace(async root => {
  const { prepared, binding } = start();
  controlAssignmentExecutionV2({ binding, action: "pause", command_id: "pause-before-docs", expected_command_id: null });
  const before = getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
  assert.equal(before.execution_control?.state, "paused");
  const attachment = storeAttachmentUpload({ session_id: "controls-session", filename: "checklist.pdf", data_base64: attachmentPdf().toString("base64") });
  const runtime = new CodexMcpToolRuntime({ backendCwd: process.cwd(), workspaceRoot: root, codexHome: root, spawnEnv: {} });
  const auth = runtime.beginBackendAuthLease("controls-session", createOperatorBackendAuth("shared_token", "test-only"));
  const owner = beginTeammateLoopOwner(runtime, { version: "operator.backend.v1", session_id: "controls-session", user_text: "Review the attached checklist and tell me what can be checked in Revit. Do not change the model." } as any);
  const request = { id: "read-late-pages", method: "item/tool/call", params: { namespace: "revit_operator", turnId: "doc-turn", tool: "operator_read_attachment", arguments: { attachment_id: attachment.id, pages: [6, 7, 8] } } } as any;
  try {
    const response: any = await handleCodexDynamicToolCall(runtime, request);
    assert.equal(response.success, true, JSON.stringify(response).slice(0, 300));
    assert.equal(response.contentItems.filter((item: any) => item.type === "inputImage").length, 3);
    assert.match(response.contentItems.filter((item: any) => item.type === "inputText").map((item: any) => item.text).join("\n"), /Fixture page 8/);
    assert.equal((await handleCodexDynamicToolCall(runtime, { ...request, params: { ...request.params, tool: "revit_get_context" } }) as any).success, false);
    assert.deepEqual(getAssignmentKernelSnapshotV2(prepared.assignmentId), before);
  } finally { endTeammateLoopOwner(owner); runtime.endBackendAuthLease(auth); }
  assert.equal((await handleCodexDynamicToolCall(runtime, request) as any).success, false);
}));

test("document support read never completes a live model-read criterion and obeys pause", () => workspace(async root => {
  const { prepared, binding } = start("Review the attached checklist and check the open model against it.");
  const attachment = storeAttachmentUpload({ session_id: "controls-session", filename: "checklist.pdf", data_base64: attachmentPdf().toString("base64") });
  const runtime = new CodexMcpToolRuntime({ backendCwd: process.cwd(), workspaceRoot: root, codexHome: root, spawnEnv: {} });
  const auth = runtime.beginBackendAuthLease("controls-session", createOperatorBackendAuth("shared_token", "test-only"));
  const v2 = runtime.beginAssignmentKernelV2Lease(binding);
  runtime.bindAssignmentKernelV2LeaseTurn(v2, "model-doc-turn");
  const owner = beginTeammateLoopOwner(runtime, { version: "operator.backend.v1", session_id: "controls-session", user_text: "Review the attached checklist and check the open model against it." } as any);
  const request = { id: "support-page", method: "item/tool/call", params: { namespace: "revit_operator", turnId: "model-doc-turn", tool: "operator_read_attachment", arguments: { attachment_id: attachment.id, pages: [8] } } } as any;
  try {
    const before = getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
    assert.equal((await handleCodexDynamicToolCall(runtime, request) as any).success, true);
    assert.deepEqual(getAssignmentKernelSnapshotV2(prepared.assignmentId), before);
    controlAssignmentExecutionV2({ binding, action: "pause", command_id: "pause-current-docs", expected_command_id: null });
    const paused = getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
    assert.equal((await handleCodexDynamicToolCall(runtime, request) as any).success, false);
    assert.deepEqual(getAssignmentKernelSnapshotV2(prepared.assignmentId), paused);
  } finally { endTeammateLoopOwner(owner); runtime.endBackendAuthLease(auth); runtime.endAssignmentKernelV2Lease(v2); }
}));

test("successful generated support report settles as no-effect control evidence while the model task remains incomplete", () => workspace(async () => {
  const { binding, snapshot } = start("Use a custom C# program to set Comments to CHECKED on one duct and verify the edit.");
  const lease = openAssignmentKernelOperationV2({ snapshot, controller_request_id: "support-report", provider_turn_id: "support-turn",
    capability_id: "operator_run_dynamic_revit_program", classified_effect: "read", arguments: { mode: "read", source: "public class Probe {}" } });
  assert.equal(lease.fulfillment_role, "supporting_control");
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const payload = { requested_mode: "read", execution_ok: true, execution_status: "completed", report: { Result: "diagnostic repaired" } };
  const result = settleAssignmentKernelOperationV2(lease, { content: [], structuredContent: {
    schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
    operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: "support-report-result", operation_id: lease.operation_id,
      binding, status: "succeeded", dispatch_state: "dispatched", persistent_effect: "none", native_transaction_state: "not_applicable",
      authority: "dynamic-runtime", result_schema_id: "operator-dynamic-runtime/mcp-program/v2", observation_required: true,
      raw_payload_hash: payloadDigestV2(payload).digest, receipt_id: "dynamic-evidence:support-report", request_identity: lease.request_identity, completed_at: new Date().toISOString() },
    observation: { raw_payload: payload, semantic_facts: [], verification_relevance: ["control"], evidence_class: "control" }
  } });
  const operation = result.snapshot.operations[lease.operation_id]!;
  assert.equal(operation.settlement_state, "settled"); assert.equal(operation.persistent_effect, "none");
  assert.equal(operation.result?.status, "succeeded"); assert.equal(result.snapshot.unresolved_unknown_operation_ids.length, 0);
  const observation = Object.values(result.snapshot.observations).find(row => row.operation_id === lease.operation_id)!;
  assert.equal(observation.evidence_class, "control"); assert.equal(observation.facts.length, 0);
  assert.notEqual(result.snapshot.outcome, "complete"); assert.equal(result.snapshot.terminal, false);
}));

test("a standalone research turn fetches evidence after a blocked model task without reopening model access", () => workspace(async () => {
  const { prepared, binding, snapshot } = start("Use a short custom C# program to inspect twenty ducts. Make no model changes.");
  appendCurrentAssignmentKernelEventV2({ goal_id: prepared.assignmentId, binding: snapshot.current_binding,
    event_id: "retained-failure", actor: "assignment-kernel-v2", body: { event_type: "progress_blocked",
      code: "no_progress_budget_exhausted", gap_ids: [`criterion:${snapshot.spec.criteria[0]!.criterion_id}`] } });
  assert.equal(deriveAndSettleAssignmentKernelV2(binding, "no_progress_budget_exhausted").outcome, "blocked");
  let calls = 0;
  const runtime = { assignmentKernelV2Binding: () => null, callTool: async (tool: string, _args: unknown, context: any) => {
    assert.equal(tool, "web_fetch_evidence"); assert.equal(context.sessionId, "controls-session");
    assert.equal(context.assignmentKernelV2, undefined); calls++;
    return { content: [{ type: "text", text: "Source: https://www.greenheck.com/\nExtracted text: bathroom exhaust fan, 109-144 CFM" }] };
  } };
  const owner = beginTeammateLoopOwner(runtime, { version: "operator.backend.v1", session_id: "controls-session",
    user_text: "Look up current manufacturer information for Greenheck SP-A125-QD. Do not change the model." } as any);
  const request = { id: "research", method: "item/tool/call", params: { namespace: "revit_operator", turnId: "research-turn",
    tool: "web_fetch_evidence", arguments: { url: "https://www.greenheck.com/" } } } as any;
  try {
    const response: any = await handleCodexDynamicToolCall(runtime as any, request);
    assert.equal(response.success, true); assert.match(JSON.stringify(response), /109-144/); assert.equal(calls, 1);
    for (const tool of ["revit_get_context", "operator_run_dynamic_revit_program", "revit_set_parameters"])
      assert.equal((await handleCodexDynamicToolCall(runtime as any, { ...request, params: { ...request.params, tool } }) as any).success, false);
    assert.equal(calls, 1); assert.equal(getAssignmentKernelSnapshotV2(prepared.assignmentId)!.outcome, "blocked");
  } finally { endTeammateLoopOwner(owner); }
  assert.equal((await handleCodexDynamicToolCall(runtime as any, request) as any).success, false, "expired turn cannot fetch");
  assert.equal(calls, 1);
}));

test("invalid generated apply deadlines never enter the operation graph and a corrected request can dispatch", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Set Comments on one duct using a custom C# program and verify the committed change.");
  const validator = new McpInputValidator();
  const definitions = [{ name: "operator_run_dynamic_revit_program", inputSchema: { type: "object",
    properties: { worker_deadline_ms: { type: "integer", maximum: 30000 }, apply_deadline_ms: { type: "integer", maximum: 5000 } } } }];
  let calls = 0;
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    validateToolArguments: async (tool: string, args: unknown) => validator.validate(tool, args, definitions),
    callTool: async (_tool: string, _args: unknown, context: any) => { calls++; context.onMcpAccepted();
      // A lost reply after real dispatch remains uncertain, despite validation.
      throw new Error("Connection lost after dispatch");
    } };
  const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: binding.session_id,
    user_text: snapshot.spec.source_user_request, context: { revit: { process_id: 4242, source: { live: true }, document: { title: "Pilot", projectIdentity: { fingerprint: "controls-model" } } } } } as any, prepared));
  const request: any = { id: "deadline-invalid", method: "item/tool/call", params: { namespace: "revit_operator", turnId: "deadline-test",
    tool: "operator_run_dynamic_revit_program", arguments: { mode: "apply", source: "public class Program {}", worker_deadline_ms: 120000, apply_deadline_ms: 120000 } } };
  try {
    const rejected: any = await handleCodexDynamicToolCall(runtime as any, request);
    assert.equal(rejected.success, false); assert.match(JSON.stringify(rejected), /tool_request_invalid/);
    assert.equal(calls, 0); assert.equal(Object.keys(getAssignmentKernelSnapshotV2(binding.assignment_id)!.operations).length, 0);
    const corrected = { ...request, id: "deadline-corrected", params: { ...request.params,
      arguments: { ...request.params.arguments, worker_deadline_ms: 30000, apply_deadline_ms: 5000 } } };
    await handleCodexDynamicToolCall(runtime as any, corrected);
    assert.equal(calls, 1);
    const after = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.ok(Object.values(after.operations).some(operation => operation.persistent_effect === "unknown"));
    const retry: any = await handleCodexDynamicToolCall(runtime as any, { ...corrected, id: "deadline-lost-reply-retry" });
    assert.equal(retry.success, false); assert.equal(calls, 1, "lost apply cannot be replayed");
  } finally { endTeammateLoopOwner(owner); }
}));

test("generated-tool validation diagnostics survive a missing canonical receipt without inventing native evidence", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Use a short custom C# program to summarize twenty ducts. Make no model changes.");
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (_tool: string, _args: unknown, context: any) => { context.onMcpAccepted();
      return { isError: true, content: [{ type: "text", text: 'Input validation error: category must match OST_[A-Za-z0-9_]+' }] };
    } };
  const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: binding.session_id,
    user_text: snapshot.spec.source_user_request, context: { revit: { process_id: 4242, source: { live: true }, document: { title: "Pilot", projectIdentity: { fingerprint: "controls-model" } } } } } as any, prepared));
  try {
    const result: any = await handleCodexDynamicToolCall(runtime as any, { id: "invalid-category", method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "invalid-category", tool: "operator_run_dynamic_revit_program",
      arguments: { mode: "read", source: "public class Program {}", category: "duct sample summary by type" } } } as any);
    assert.equal(result.success, false); assert.match(JSON.stringify(result), /category must match OST_/);
    const after = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.equal(Object.keys(after.observations).length, 0);
    assert.equal(Object.values(after.operations).some(o => o.persistent_effect === "applied"), false);
  } finally { endTeammateLoopOwner(owner); }
}));

for (const [withAssessment, withProjection] of [[false, false], [true, false], [false, true]]) test(`read-result HTTP delivery ${withAssessment ? "with cited assessment" : withProjection ? "with deterministic projection counts" : "with native values"} rejects foreign or missing evidence and survives publication`, () => workspace(async () => {
  const { binding, snapshot, prepared } = start(withAssessment
    ? "Review the selected element's name, size and system. Tell me how many of these fields are readable and assess what needs attention. Leave the model unchanged."
    : "Tell me what is selected in Revit, its size, and which system it belongs to. Leave the model unchanged.");
  const payload = { name: "PVC - DWV", parameters: { Size: '4"ø', "System Name": "Building Sanitary" }, count: 509, itemsComplete: true, items: Array.from({ length: 509 }, (_, i) => ({ elementId: i + 1, familyName: "Supply.Diffuser", typeName: "12 x 12" })) };
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => { throw new Error("read interrupted before delivery"); },
    callTool: async (_tool: unknown, args: any, context: any) => {
      const lease = context.assignmentKernelV2;
      const payloadForRead = args.path === "/revit/get-element-summary" ? { name: payload.name } : payload;
      context.onMcpAccepted();
      return { content: [], structuredContent: {
    schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
    operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `http-read-result:${lease.operation_id}`, operation_id: lease.operation_id,
      binding, status: "succeeded", dispatch_state: "dispatched", persistent_effect: "none", native_transaction_state: "not_applicable",
      authority: "native-host", result_schema_id: `operator-native/POST:${args.path}/v2`, observation_required: true,
      raw_payload_hash: payloadDigestV2(payloadForRead).digest, receipt_id: `http-read-receipt:${lease.operation_id}`, request_identity: lease.request_identity,
      completed_at: new Date().toISOString() },
    observation: { raw_payload: payloadForRead, semantic_facts: [{ fact_id: "task.result_available", fact_class: "domain", value: true }],
      verification_relevance: ["task_result"], evidence_class: "task_result" }
      } };
    }
  };
  const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: "operator.backend.v1",
    session_id: binding.session_id, user_text: snapshot.spec.source_user_request,
    context: { revit: { process_id: 4242, source: { live: true }, document: { title: "Snowdon Towers Sample Plumbing", projectIdentity: { fingerprint: "controls-model" } } } } } as any, prepared));
  let dynamicResponse: any;
  try {
    const firstRead = await handleCodexDynamicToolCall(runtime as any, { id: "summary-http", method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "read-http", tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/get-element-summary", body: { elementIds: [1380354] } }
    } } as any) as any;
    assert.equal(firstRead.success, true, JSON.stringify(firstRead));
    const afterSummary = advanceAssignmentKernelProgressV2({ binding }).snapshot;
    assert.equal(afterSummary.criteria[snapshot.spec.criteria[0]!.criterion_id]!.status, "pass");
    assert.equal(afterSummary.terminal, false);
    dynamicResponse = await handleCodexDynamicToolCall(runtime as any, { id: "read-http", method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "read-http", tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/get-parameters", body: { elementIds: [1380354] } }
    } } as any);
    assert.equal(dynamicResponse.success, true, JSON.stringify(dynamicResponse));
  } finally { endTeammateLoopOwner(owner); }
  advanceAssignmentKernelProgressV2({ binding });
  const afterReads = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  const deliveryGuidance = deriveProgressGapsV2(afterReads).find(gap => gap.kind === "result_delivery_required")!;
  assert.match(deliveryGuidance.reason, /simple counts, lists or sample reports, omit assessment/);
  assert.match(deliveryGuidance.reason, /requested names, values and scope directly in resultItems/);
  assert.match(deliveryGuidance.reason, /Put requested answer values in the findings/);
  assert.equal(afterReads.result_delivery, undefined, "guidance does not manufacture a delivered result");
  const observation = Object.values(afterReads.observations).find(item =>
    afterReads.operations[item.operation_id]!.request_identity?.path === "/revit/get-parameters")!;
  assert.equal(observation.evidence_class, "task_result");
  assert.ok(afterReads.progress_epochs.at(-1)!.progress_reasons.includes("authoritative_observation_added"));
  const observationId = observation.observation_id;
  assert.throws(() => buildAssignmentResultDeliveryV2(afterReads, [{ label: "Selected pipe", observation_id: observationId, path: ["payload", "parameters"] }]),
    error => error instanceof Error && /assignment_result_path_missing_or_invalid/.test(error.message)
      && /available_keys/.test(error.message) && /parameters/.test(error.message));
  assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.result_delivery, undefined);
  const mapping = dynamicResponse.contentItems.map((item: any) => JSON.parse(item.text)).find((item: any) => item.schema === "revit-operator.model-observation-index/v2");
  assert.equal(mapping.observations[0].observation_id, observationId);
  assert.equal(mapping.observations[0].result_item_eligibility, "result");
  assert.equal(mapping.observations[0].evidence_id, observation.raw_payload_ref.replace(/^evidence:/, ""));
  assert.deepEqual(mapping.observations[0].eligible_criterion_ids, [snapshot.spec.criteria[0]!.criterion_id]);
  const assessment = { overview: "Review the drainage design before treating this pipe as ready.",
    findings: [{ priority: "high" as const, title: "Confirm sizing", text: "The selected pipe belongs to the sanitary system. Check its size against the design load.", evidence_indices: [2, 3] }],
    limitations: ["Fixture-unit demand and slope have not been checked."], questions: ["What design load should this branch serve?"] };
  const body = { ...binding, ...(withAssessment ? { assessment } : {}), claims: [{ criterion_id: snapshot.spec.criteria[0]!.criterion_id, observation_ids: [observationId] }],
    result_items: [{ label: "Selected pipe", observation_id: observationId, path: ["name"] },
      { label: "Size", observation_id: observationId, path: ["parameters", "Size"] },
      { label: "System", observation_id: observationId, path: ["parameters", "System Name"] }] };
  if (withProjection) (body as any).result_items = [
    { label: "Air devices", observation_id: observationId, source: "deterministic_projection", path: ["key_counts", "inventory.total"] },
    { label: "Supply diffusers", observation_id: observationId, source: "deterministic_projection", path: ["key_counts", "inventory.family_type::Supply.Diffuser | 12 x 12"] }
  ];
  const server = http.createServer((req, res) => {
    void runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") }, async () => {
      await handleAssignmentHttpRoute(req, res, new URL(req.url!, "http://localhost"), session => {
        if (session === binding.session_id) return true;
        res.writeHead(403); res.end(); return false;
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const send = (value: unknown) => fetch(`http://127.0.0.1:${address.port}/api/assignments/v2/criteria/evaluate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    assert.equal((await send({ ...body, session_id: "foreign" })).status, 403);
    assert.equal((await send({ ...body, generation: 99 })).status, 400);
    assert.equal((await send({ ...body, result_items: [{ ...body.result_items[0], observation_id: observation.operation_id }] })).status, 400,
      "an operation or correlation identifier cannot substitute for the published Observation ID");
    assert.equal((await send({ ...body, result_items: [{ ...body.result_items[0], path: ["missing"] }] })).status, 400);
    assert.equal((await send({ ...body, result_items: null })).status, 400);
    for (const invalid of [
      { ...body.result_items[0], source: "untrusted_model" },
      { ...body.result_items[0], source: "deterministic_projection", path: ["inventory", "total"] },
      { ...body.result_items[0], source: "raw_payload", path: ["key_counts", "inventory.total"] }
    ]) assert.equal((await send({ ...body, result_items: [invalid] })).status, 400);
    if (withAssessment) {
      for (const invalid of [null, { ...assessment, authority: "native-host" }, { ...assessment, questions: ["1", "2", "3", "4"] },
        { ...assessment, findings: [{ ...assessment.findings[0], evidence_indices: [99] }] }]) {
        assert.equal((await send({ ...body, assessment: invalid })).status, 400);
      }
      assert.equal((await send({ ...body, result_items: undefined })).status, 400);
      assert.equal((await send({ ...body, result_items: [{ label: "Whole payload", observation_id: observationId, path: ["parameters"] }] })).status, 400);
    }
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.terminal, false);
    const response = await send(body);
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as any;
    if (withAssessment) {
      const rendered = renderTerminalResultV2(result.assignment_snapshot_v2);
      assert.match(rendered, /High priority: Confirm sizing/); assert.match(rendered, /\[2\] \[3\]/);
      assert.match(rendered, /Not verified/); assert.match(rendered, /What design load/);
      assert.match(rendered, /\[2\] Size: 4"ø/); assert.doesNotMatch(rendered, /\{"/);
      assert.deepEqual(result.assignment_snapshot_v2.criteria, getAssignmentKernelSnapshotV2(binding.assignment_id)!.criteria);
      assert.equal(result.assignment_snapshot_v2.spec.input_variables.length, 0, "presentation questions cannot manufacture user-input authority");
    } else assert.equal(renderTerminalResultV2(result.assignment_snapshot_v2), withProjection
      ? '- Air devices: 509\n- Supply diffusers: 509'
      : '- Selected pipe: PVC - DWV\n- Size: 4"ø\n- System: Building Sanitary');
    const canonicalBeforeProjection = JSON.stringify(getAssignmentKernelSnapshotV2(binding.assignment_id));
    const modelReply = adaptMcpToolCallResultToDynamicResponse({ content: [{ type: "text", text: JSON.stringify(result) }] },
      { tool: "operator_evaluate_assignment_criteria" });
    const modelStatus = JSON.parse((modelReply.contentItems[0] as any).text).assignment_status;
    assert.deepEqual(modelStatus.result_delivery, result.assignment_snapshot_v2.result_delivery);
    assert.equal(modelStatus.terminal, result.assignment_snapshot_v2.terminal);
    assert.equal(JSON.stringify(getAssignmentKernelSnapshotV2(binding.assignment_id)), canonicalBeforeProjection);
    const published = parseAssignmentKernelPublicationV2(getAssignmentKernelPublicationV2(binding.assignment_id)!);
    assert.deepEqual((published.snapshot as any).result_delivery, result.assignment_snapshot_v2.result_delivery);
    assert.equal((await send(body)).status, 200);
    if (withAssessment) assert.equal((await send({ ...body, assessment: { ...assessment, overview: "Changed after settlement" } })).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("dynamic PDF handoff permits verification helpers after criterion pass without repeating export", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Export M000 in color and verify the PDF.");
  const outputPath = "C:/fixture/M000.pdf";
  const file = { path: outputPath, size_bytes: 8251485, sha256: "a".repeat(64), exists: true, readable: true };
  const receipt = { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: "/revit/export-pdf",
    phase: "apply", status: "complete", expected_output_paths: [outputPath], expected_export_calls: 1, export_calls: [true],
    outputs: [{ ...file, fresh_output: true }] };
  const calls: string[] = [];
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (tool: string, args: any, context: any) => {
      const lease = context.assignmentKernelV2;
      calls.push(args.path || tool);
      context.onMcpAccepted();
      const native = tool === "revit_call_tool";
      const apply = args.path === "/revit/export-pdf";
      const payload = apply ? { ok: true, status: "Success", artifact_receipt: receipt, selectedSheets: [{ sheetNumber: "M000", name: "Cover Sheet" }] }
        : native ? { schema: "revit-operator.exported-file-inspection.v1", ok: true, itemsComplete: true, requestedPaths: [outputPath], files: [file] }
          : tool === "revit_search_tools" ? { matches: [{ method: "POST", path: "/revit/inspect-exported-files" }] } : { artifact_receipt: receipt };
      const facts = native ? [{ fact_id: apply ? "task.result_available" : "control.result_available", fact_class: apply ? "domain" : "control", value: true }]
        : tool === "revit_search_tools" ? [{ fact_id: "control.capability_available", fact_class: "control", value: true,
          cardinality: "many", identity_dimensions: ["capability_id", "method", "path"],
          dimensions: { capability_id: tool, method: "POST", path: "/revit/inspect-exported-files" } }]
          : [{ fact_id: "control.evidence_selection_available", fact_class: "control", value: true,
            cardinality: "many", identity_dimensions: ["capability_id", "evidence_id", "selection_path"],
            dimensions: { capability_id: tool, evidence_id: "retained-export", selection_path: "payload.artifact_receipt" } }];
      const retrieval = { ok: true, result: { schema: "revit-operator.evidence-retrieval.v1",
        selection: { "payload.artifact_receipt": receipt }, complete: false } };
      return { content: tool === "operator_retrieve_evidence" ? [{ type: "text", text: JSON.stringify(retrieval) }] : [], structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `handoff:${lease.operation_id}`,
          operation_id: lease.operation_id, binding, status: "succeeded",
          dispatch_state: "dispatched", persistent_effect: apply ? "applied" : "none",
          native_transaction_state: "not_applicable", authority: native ? "native-host" : tool === "operator_retrieve_evidence" ? "operator-evidence-store" : "operator-mcp-transport",
          result_schema_id: native ? `operator-native/POST:${args.path}/v2` : `operator-capability/${tool}/v2`,
          observation_required: true, request_identity: lease.request_identity, completed_at: new Date().toISOString(),
          raw_payload_hash: payloadDigestV2(payload).digest,
          ...(apply ? { native_artifact_receipt: receipt, affected_target_identities: [`artifact_path:${outputPath}`] } : {}) },
        observation: { raw_payload: payload, semantic_facts: facts, verification_relevance: [apply ? "task_result" : "control"] }
      } };
    }
  };
  const loopRequest = bindPreparedAssignmentToRequest({ version: "operator.backend.v1",
    session_id: binding.session_id, user_text: snapshot.spec.source_user_request,
    context: { revit: { process_id: 4242, source: { live: true }, document: { title: "Snowdon HVAC", projectIdentity: { fingerprint: "controls-model" } } } }
  } as any, prepared);
  const owner = beginTeammateLoopOwner(runtime, loopRequest);
  const run = async (id: string, tool: string, args: any) => {
    const result = await handleCodexDynamicToolCall(runtime as any, { id, method: "item/tool/call",
      params: { namespace: "revit_operator", turnId: "pdf-handoff", tool, arguments: args } } as any) as any;
    assert.equal(result.success, true, JSON.stringify(result));
    if (tool === "operator_retrieve_evidence") {
      const rendered = result.contentItems.map((item: any) => item.text).join("\n");
      const parsed = JSON.parse(rendered);
      assert.deepEqual(parsed.result.selection["payload.artifact_receipt"], receipt);
      assert.equal(parsed.model_observation_index.schema, "revit-operator.model-observation-index/v2");
      assert.equal(parsed.model_observation_index.observations[0].capability_id, "operator_retrieve_evidence");
      assert.equal(result.contentItems.length, 1);
    }
  };
  try {
    await run("export", "revit_call_tool", { method: "POST", path: "/revit/export-pdf", body: { viewIds: [1420963], fileName: "M000.pdf", colorMode: "Color", dryRun: false } });
    const applied = advanceAssignmentKernelProgressV2({ binding }).snapshot;
    assert(Object.values(applied.criteria).every(c => c.status === "pass"));
    assert.equal(applied.terminal, false, JSON.stringify({ outcome: applied.outcome, effect: applied.spec.requested_effect,
      operations: Object.values(applied.operations).map(o => ({ purpose: o.purpose, requested: o.requested_effect, result: o.result })) }));
    await run("lookup", "revit_search_tools", { query: "verify exported PDF file", max: 5, includeSchemas: true });
    await run("evidence", "operator_retrieve_evidence", { evidenceId: "retained-export", fields: ["payload.artifact_receipt"] });
    const afterHelpers = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.equal(afterHelpers.terminal, false, JSON.stringify({ outcome: afterHelpers.outcome, blocker: afterHelpers.progress_blocker,
      operations: Object.values(afterHelpers.operations).map(o => ({ purpose: o.purpose, requested: o.requested_effect, result: o.result })) }));
    await run("inspect", "revit_call_tool", { method: "POST", path: "/revit/inspect-exported-files", body: { paths: [outputPath] } });
    const final = advanceAssignmentKernelProgressV2({ binding }).snapshot;
    assert.equal(final.outcome, "complete");
    assert.match(renderTerminalResultV2(final), /Verified file: C:\/fixture\/M000.pdf/);
    const proofRequest = { user_text: snapshot.spec.source_user_request, session_id: binding.session_id,
      assignment_id: binding.assignment_id, assignment_run_id: binding.run_id, assignment_generation: binding.generation };
    assert.ok(canonicalTeammateFinalVerification(proofRequest));
    assert.equal(canonicalTeammateFinalVerification({ ...proofRequest, assignment_generation: 99 }), null);
    const presentation = guardGenericTeammateDecision(loopRequest,
      { assistant_message: renderTerminalResultV2(final), actions: [] } as any);
    assert.doesNotMatch(presentation.assistant_message, /post apply verification required/);
    assert.match(presentation.assistant_message, /Exported sheet M000: Cover Sheet/);
    assert.equal(presentation.teammate_loop_receipt?.verified, true);
    assert.deepEqual(calls, ["/revit/export-pdf", "revit_search_tools", "operator_retrieve_evidence", "/revit/inspect-exported-files"]);
    assert.equal(Object.values(final.operations).filter(o => o.persistent_effect === "applied").length, 1);
    assert.deepEqual(final.unresolved_unknown_operation_ids, []);
  } finally { endTeammateLoopOwner(owner); }
}));

test("generated read report satisfies the canonical read task and delivers retained report values", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Use a short custom C# program to summarize a sample of up to twenty ducts by type. Make no model changes. Tell me what it inspected and the limits of the result.");
  assert.equal(snapshot.spec.requested_effect, "read");
  const payload = { schema: "revit-operator.dynamic-revit-program-run.v1", requested_mode: "read", execution_ok: true,
    execution_status: "completed", report: { Inspected: "20", "Type: Rectangular": "12", "Type: Round": "8", Limit: "Bounded sample; not a model census." } };
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (tool: string, _args: unknown, context: any) => {
      assert.equal(tool, "operator_run_dynamic_revit_program");
      const lease = context.assignmentKernelV2;
      assert.equal(lease.requested_effect, "read");
      context.onMcpAccepted();
      return { content: [], structuredContent: { schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `dynamic:${lease.operation_id}`,
          operation_id: lease.operation_id, binding, status: "succeeded", dispatch_state: "dispatched", persistent_effect: "none",
          native_transaction_state: "not_applicable", authority: "dynamic-runtime", result_schema_id: "operator-dynamic-runtime/mcp-program/v2",
          observation_required: true, raw_payload_hash: payloadDigestV2(payload).digest, receipt_id: `dynamic-evidence:${lease.operation_id}`,
          request_identity: lease.request_identity, completed_at: new Date().toISOString() },
        observation: { raw_payload: payload, semantic_facts: [{ fact_id: "task.result_available", fact_class: "domain", value: true }],
          verification_relevance: ["task_result"], evidence_class: "task_result" } } };
    } };
  const request = bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: binding.session_id,
    user_text: snapshot.spec.source_user_request, context: { revit: { process_id: 4242, source: { live: true },
      document: { title: "Snowdon HVAC", projectIdentity: { fingerprint: "controls-model" } } } } } as any, prepared);
  const owner = beginTeammateLoopOwner(runtime, request);
  try {
    const response: any = await handleCodexDynamicToolCall(runtime as any, { id: "generated-report", method: "item/tool/call",
      params: { namespace: "revit_operator", turnId: "generated-report", tool: "operator_run_dynamic_revit_program",
        arguments: { source: "public class SampleReport {}", mode: "read", category: "OST_DuctCurves", snapshot_limit: 20 } } } as any);
    assert.equal(response.success, true, JSON.stringify(response));
    const after = advanceAssignmentKernelProgressV2({ binding }).snapshot;
    const observation = Object.values(after.observations).find(o => o.authority === "dynamic-runtime")!;
    assert.ok(observation);
    assert.equal(after.criteria[snapshot.spec.criteria[0]!.criterion_id]!.status, "pass");
    assert.equal(after.terminal, false, "report still needs user-facing delivery");
    evaluateAssignmentObservationCriteriaV2({ binding, claims: [{ criterion_id: snapshot.spec.criteria[0]!.criterion_id, observation_ids: [observation.observation_id] }],
      result_items: [{ label: "Duct sample", observation_id: observation.observation_id, path: ["report"] }] });
    const final = advanceAssignmentKernelProgressV2({ binding }).snapshot;
    assert.equal(final.outcome, "complete");
    assert.match(renderTerminalResultV2(final), /Bounded sample; not a model census/);
    assert.equal(Object.values(final.operations).some(o => o.persistent_effect !== "none"), false);
  } finally { endTeammateLoopOwner(owner); }
}));

test("intentional read failure and repaired success retain both outcomes through the controller and HTTP answer delivery", () => workspace(async () => {
  const {binding,snapshot,prepared}=start('Test custom C# diagnostics without changing the model. Log "diagnostic probe reached", throw InvalidOperationException "diagnostic probe failure", then repair it and report both outcomes. Do not change any elements or parameters.');
  let calls=0;
  const runtime={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop:()=>{},callTool:async(_tool:string,_args:any,context:any)=>{
    const lease=context.assignmentKernelV2;context.onMcpAccepted(); const failed=++calls===1;
    const payload=failed?{execution_status:"failed",diagnostics:[{code:"PROGRAM_EXCEPTION",message:"diagnostic probe failure",line:8},{code:"PROGRAM_PARTIAL_OUTPUT",message:'{"logs":["diagnostic probe reached"]}'}]}
      :{execution_status:"completed",report:{Result:"diagnostic probe repaired"},logs:["diagnostic probe reached"]};
    return {content:[],isError:failed,structuredContent:{schema:ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2:{schema:"revit-operator.operation-result/v2",result_id:`result:${lease.operation_id}`,operation_id:lease.operation_id,binding,
        status:failed?"failed_after_dispatch":"succeeded",dispatch_state:"dispatched",persistent_effect:"none",native_transaction_state:"not_applicable",authority:"dynamic-runtime",
        result_schema_id:"operator-dynamic-runtime/mcp-program/v2",observation_required:true,raw_payload_hash:payloadDigestV2(payload).digest,receipt_id:`receipt:${lease.operation_id}`,
        request_identity:lease.request_identity,completed_at:new Date().toISOString()},
      observation:{raw_payload:payload,semantic_facts:failed?[]:[{fact_id:"task.result_available",fact_class:"domain",value:true}],verification_relevance:["task_result"],evidence_class:"task_result"}}};
  }};
  const owner=beginTeammateLoopOwner(runtime,bindPreparedAssignmentToRequest({version:"operator.backend.v1",session_id:binding.session_id,user_text:snapshot.spec.source_user_request,
    context:{revit:{process_id:4242,source:{live:true},document:{title:"Fixture",projectIdentity:{fingerprint:"controls-model"}}}}} as any,prepared));
  try {
    const run=(id:string)=>handleCodexDynamicToolCall(runtime as any,{id,method:"item/tool/call",params:{namespace:"revit_operator",turnId:"diagnostics",tool:"operator_run_dynamic_revit_program",arguments:{source:`public class ${id} {}`,mode:"read"}}} as any);
    await run("Fail");
    const failed=advanceAssignmentKernelProgressV2({binding}).snapshot;
    const failure=Object.values(failed.observations).find(o=>o.authority==="dynamic-runtime")!;
    assert.ok(failure); assert.equal(failed.terminal,false);
    assert.notEqual(failed.criteria[snapshot.spec.criteria[0]!.criterion_id]?.status,"pass","diagnostic presence must not satisfy work");
    const selection={label:"Exception source line",observation_id:failure.observation_id,path:["diagnostics",0,"line"]};
    assert.equal(buildAssignmentResultDeliveryV2(failed,[selection]).items[0]!.value,8);
    await run("Repair");
    const after=advanceAssignmentKernelProgressV2({binding}).snapshot;
    const success=Object.values(after.observations).find(o=>o.authority==="dynamic-runtime"&&o.observation_id!==failure.observation_id)!;
    const body={...binding,claims:[{criterion_id:snapshot.spec.criteria[0]!.criterion_id,observation_ids:[success.observation_id]}],result_items:[selection,
      {label:"Exception",observation_id:failure.observation_id,path:["diagnostics",0,"message"]},
      {label:"Retained log",observation_id:failure.observation_id,path:["diagnostics",1,"message"]},
      {label:"Repair result",observation_id:success.observation_id,path:["report","Result"]}]};
    const server=http.createServer((req,res)=>{void runWithRequestContext({operator_backend_auth:createOperatorBackendAuth("shared_token","test-only")},async()=>{
      await handleAssignmentHttpRoute(req,res,new URL(req.url!,"http://localhost"),session=>{if(session===binding.session_id)return true;res.writeHead(403);res.end();return false;});});});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    try {
      const address=server.address() as import("node:net").AddressInfo;
      const response=await fetch(`http://127.0.0.1:${address.port}/api/assignments/v2/criteria/evaluate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());
      const final=(await response.json()) as any;
      assert.equal(final.assignment_snapshot_v2.outcome,"complete");
      const answer=renderTerminalResultV2(final.assignment_snapshot_v2);
      assert.match(answer,/Exception source line \(failed run\): 8/);assert.match(answer,/diagnostic probe failure/);
      assert.match(answer,/diagnostic probe reached/);assert.match(answer,/diagnostic probe repaired/);
      assert.equal(calls,2);assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.result_delivery!.items.length,4);
    } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
  } finally {endTeammateLoopOwner(owner);}
}));

test("generated committed checkpoint retains evidence and completes only after exact native parameter readback", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Use a custom C# program to set Comments to PILOT-42 on one duct and verify the edit.");
  const payload = generatedParameterPayload(binding.document_fingerprint!);
  let calls = 0;
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (_tool: string, _args: unknown, context: any) => {
      calls++; const lease = context.assignmentKernelV2; context.onMcpAccepted();
      if (_tool === "revit_call_tool") {
        const raw = { items: [{ id: 42, parameters: { Comments: "PILOT-42" } }] };
        return { content: [], structuredContent: { schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
          operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `read:${lease.operation_id}`,
            operation_id: lease.operation_id, binding, status: "succeeded", dispatch_state: "dispatched", persistent_effect: "none",
            native_transaction_state: "not_applicable", authority: "native-host", result_schema_id: "operator-native/test/v2",
            observation_required: true, raw_payload_hash: payloadDigestV2(raw).digest, request_identity: lease.request_identity, completed_at: new Date().toISOString() },
          observation: { raw_payload: raw, semantic_facts: [], verification_relevance: ["verification"], evidence_class: "verification" } } };
      }
      return { content: [], structuredContent: { schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `dynamic:${lease.operation_id}`,
          operation_id: lease.operation_id, binding, status: "succeeded", dispatch_state: "dispatched", persistent_effect: "applied",
          native_transaction_state: "committed", authority: "dynamic-runtime", result_schema_id: "operator-dynamic-runtime/mcp-program/v2",
          affected_target_identities: ["element_id:42", "element_id:99"],
          observation_required: true, raw_payload_hash: payloadDigestV2(payload).digest, receipt_id: `dynamic-evidence:${lease.operation_id}`,
          request_identity: lease.request_identity, completed_at: new Date().toISOString() },
        observation: { raw_payload: payload, semantic_facts: [{ fact_id: "task.result_available", fact_class: "domain", value: true }],
          verification_relevance: ["task_result"], evidence_class: "task_result" } } };
    } };
  const request = bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: binding.session_id,
    user_text: snapshot.spec.source_user_request, context: { revit: { process_id: 4242, source: { live: true },
      document: { title: "Snowdon HVAC", projectIdentity: { fingerprint: "controls-model" } } } } } as any, prepared);
  const owner = beginTeammateLoopOwner(runtime, request);
  try {
  const response: any = await handleCodexDynamicToolCall(runtime as any, { id: "checkpoint", method: "item/tool/call",
    params: { namespace: "revit_operator", turnId: "checkpoint", tool: "operator_run_dynamic_revit_program",
      arguments: { source: generatedParameterSource, mode: "apply", category: "OST_DuctCurves", snapshot_limit: 20 } } } as any);
  assert.equal(response.success, true, JSON.stringify(response));
  const after = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  assert.equal(calls, 1);
  assert.deepEqual(after.unresolved_unknown_operation_ids, []);
  const operation = Object.values(after.operations).find(o => o.capability_id === "operator_run_dynamic_revit_program")!;
  assert.equal(operation.persistent_effect, "applied");
  const observation = Object.values(after.observations).find(o => o.authority === "dynamic-runtime")!;
  assert.ok(observation);
  assert.equal(observation.raw_payload_hash, payloadDigestV2(payload).digest);
  assert.equal(after.terminal, false, "a committed receipt alone does not waive independent verification");
  const verified: any = await handleCodexDynamicToolCall(runtime as any, { id: "read-checkpoint", method: "item/tool/call",
    params: { namespace: "revit_operator", turnId: "checkpoint", tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/get-parameters", body: { elementIds: [42], names: ["Comments"] } } } } as any);
  assert.equal(verified.success, true, JSON.stringify(verified));
  const final = advanceAssignmentKernelProgressV2({ binding }).snapshot;
  assert.equal(final.outcome, "complete");
  assert.equal(calls, 2, "verification cannot repeat the generated apply");
  assert.ok(canonicalTeammateFinalVerification(request));
  const presentation = guardGenericTeammateDecision(request, { assistant_message: renderTerminalResultV2(final), actions: [] } as any);
  assert.doesNotMatch(presentation.assistant_message, /post apply verification required|has not finished/);
  } finally { endTeammateLoopOwner(owner); }
}));

test("a supplementary read after verified apply uses its canonical discovery role despite the legacy verification assertion", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Put UI CHECK in Comments for this pipe.");
  const payload = { items: [{ id: 1380354, parameterDetails: [{ name: "Comments", value: "UI CHECK", valueString: "UI CHECK" }] }] };
  const stops: string[] = [];
  const envelope = (lease: any, value: any, effect: "none" | "applied") => ({
    content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: {
      schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `result:${lease.operation_id}`, operation_id: lease.operation_id,
        binding, status: "succeeded", dispatch_state: "dispatched", persistent_effect: effect,
        native_transaction_state: effect === "applied" ? "committed" : lease.requested_effect === "preview" ? "rolled_back" : "not_applicable", authority: "native-host",
        result_schema_id: "operator-native/test/v2", observation_required: true, raw_payload_hash: payloadDigestV2(value).digest,
        request_identity: lease.request_identity, completed_at: new Date().toISOString() },
      observation: { raw_payload: value, semantic_facts: [{ fact_id: "control.result_available", fact_class: "control", value: true }], verification_relevance: ["control"] }
    }
  });
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: (_turn: string, reason: string) => stops.push(reason),
    callTool: async (tool: string, args: any, context: any) => {
      const lease = context.assignmentKernelV2;
      context.onMcpAccepted();
      if (tool !== "revit_set_parameters") return envelope(lease, payload, "none");
      const apply = args.apply === true;
      // Replay the retained live failure: native mutation was committed but its
      // child had no task-fulfillment grant. Readback can verify the mutation;
      // it cannot invent the missing task-result evidence or duplicate the edit.
      const child = openAssignmentKernelChildOperationV2({ binding, parent_operation_id: lease.operation_id, child_ordinal: 0,
        operation_role: "child", capability_id: "native:POST:/revit/set-parameter", classified_effect: apply ? "apply" : "preview",
        method: "POST", path: "/revit/set-parameter", arguments: { method: "POST", path: "/revit/set-parameter", body: args },
        fulfillment_role: "supporting_control", eligible_criterion_ids: [] });
      markAssignmentKernelOperationDispatchStartedV2(child);
      const nativePayload = { status: apply ? "Applied and Verified" : "Dry Run", dryRun: !apply,
        changedCount: 1, changedElementIds: [1380354], verificationPerformed: apply, verifiedCount: apply ? 1 : 0 };
      settleAssignmentKernelOperationV2(child, envelope(child, nativePayload, apply ? "applied" : "none"));
      return { content: [{ type: "text", text: JSON.stringify(nativePayload) }], structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA, operation_result_v2: {
          schema: "revit-operator.operation-result/v2", result_id: `root:${lease.operation_id}`, operation_id: lease.operation_id, binding,
          status: "completed_without_native_dispatch", dispatch_state: "not_dispatched", persistent_effect: "none",
          native_transaction_state: "not_applicable", authority: "operator-mcp-transport", result_schema_id: "operator-mcp/transport/v2",
          observation_required: false, request_identity: lease.request_identity, completed_at: new Date().toISOString()
        }
      } };
    }
  };
  const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: binding.session_id,
    user_text: snapshot.spec.source_user_request, context: { revit: { process_id: 4242, source: { live: true },
      document: { title: "Snowdon Towers Sample Plumbing", projectIdentity: { fingerprint: "controls-model" } }, selection: { elementIds: [1380354] } } }
  } as any, prepared));
  const run = (id: string, tool: string, args: any) => handleCodexDynamicToolCall(runtime as any, {
    id, method: "item/tool/call", params: { namespace: "revit_operator", turnId: "supplementary-turn", tool, arguments: args }
  } as any) as Promise<{ success: boolean }>;
  try {
    const changes = [{ elementId: 1380354, parameterName: "Comments", value: "UI CHECK" }];
    const preview = await run("preview", "revit_set_parameters", { dryRun: true, apply: false, changes });
    assert.equal(preview.success, true, JSON.stringify(preview));
    const apply = await run("apply", "revit_set_parameters", { dryRun: false, apply: true, changes });
    assert.equal(apply.success, true, JSON.stringify(apply));
    const read = await run("verification", "revit_call_tool", { method: "POST", path: "/revit/get-parameters", body: { elementIds: [1380354], names: ["Comments"] } });
    assert.equal(read.success, true, JSON.stringify(read));
    const supplementary = await run("supplementary", "revit_call_tool", { method: "POST", path: "/revit/get-parameters", body: { elementIds: [1380354], names: ["Comments", "Mark"] } });
    assert.equal(supplementary.success, true, JSON.stringify(supplementary));
    const retained = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.notEqual(retained.outcome, "complete", "missing task-result evidence must remain missing");
    const reads = Object.values(retained.operations).filter(op => op.capability_id === "revit_call_tool");
    assert.deepEqual(reads.map(op => op.purpose), ["verification", "discovery"]);
    assert.equal(Object.values(retained.operations).filter(op => op.persistent_effect === "applied").length, 1);
    assert.equal(Object.values(retained.observations).filter(obs => obs.evidence_class === "verification").length, 1);
  } finally { endTeammateLoopOwner(owner); }
}));

test("pause persists through a fresh process; resume retains identity, budget usage, and command fencing", () => workspace(() => {
  const { binding, snapshot } = start();
  recordAssignmentProviderCallStateV2({ binding, call_id: "p1", state: "admitted", provider: "test", model: "test",
    gap_ids: ["criterion:test"], criterion_ids: [snapshot.spec.criteria[0]!.criterion_id], expected_information: ["inventory.total"] });
  const pause = { binding, command_id: "pause-1", expected_command_id: null, action: "pause" as const };
  controlAssignmentExecutionV2(pause);
  assert.throws(() => controlAssignmentExecutionV2({ ...pause, action: "resume", command_id: "too-early", expected_command_id: "pause-1" }), /not_quiescent/);
  recordAssignmentProviderCallStateV2({ binding, call_id: "p1", state: "completed", success: false, error_class: "canceled", usage: { total_tokens: 123, input_tokens: 100, output_tokens: 23, reasoning_tokens: null, estimated_cost_usd: null } });
  const paused = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  assert.equal(advanceAssignmentKernelProgressV2({ binding }).decision.decision, "paused");
  assert.equal(controlAssignmentExecutionV2(pause).assignment_version, paused.assignment_version);
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { getAssignmentKernelSnapshotV2 } from './src/assignments/assignment_kernel_v2_store.ts'; process.stdout.write(JSON.stringify(getAssignmentKernelSnapshotV2(${JSON.stringify(binding.assignment_id)})));`
  ], { cwd: process.cwd(), encoding: "utf8", env: process.env });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), paused);
  const resumed = controlAssignmentExecutionV2({ binding, command_id: "resume-1", expected_command_id: "pause-1", action: "resume" });
  assert.deepEqual(resumed.current_binding, snapshot.current_binding);
  assert.deepEqual(resumed.provider_calls, paused.provider_calls);
  assert.deepEqual(resumed.spec, snapshot.spec);
  assert.equal(resumed.terminal, false);
  controlAssignmentExecutionV2({ binding, command_id: "pause-2", expected_command_id: "resume-1", action: "pause" });
  assert.throws(() => controlAssignmentExecutionV2({ binding, command_id: "stale-resume", expected_command_id: "pause-1", action: "resume" }), /stale/);
  assert.equal(controlAssignmentExecutionV2({ binding, command_id: "resume-1", expected_command_id: "pause-1", action: "resume" }).execution_control?.state, "paused");
}));

test("pause stops new admission while an already admitted operation can settle", () => workspace(() => {
  const { binding, snapshot } = start();
  const args = { snapshot, provider_turn_id: "provider-1", controller_request_id: "op-1", capability_id: "inventory.read", classified_effect: "read", arguments: { category: "air devices" } };
  const lease = openAssignmentKernelOperationV2(args);
  controlAssignmentExecutionV2({ binding, command_id: "pause", expected_command_id: null, action: "pause" });
  assert.throws(() => openAssignmentKernelOperationV2({ ...args, controller_request_id: "op-2", arguments: { category: "rooms" } }), /paused/);
  assert.throws(() => recordAssignmentProviderCallStateV2({ binding, call_id: "new-provider", state: "admitted", provider: "test", model: "test",
    gap_ids: ["test"], criterion_ids: [snapshot.spec.criteria[0]!.criterion_id], expected_information: ["inventory.total"] }), /paused/);
  failAssignmentKernelOperationV2(lease, new Error("not dispatched"), "not_dispatched");
  const settled = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  assert.equal(settled.quiescent, true);
  assert.equal(settled.operations[lease.operation_id]!.persistent_effect, "none");
  assert.equal(settled.terminal, false);
  assert.equal(advanceAssignmentKernelProgressV2({ binding }).decision.decision, "paused");
}));

test("pending answers survive pause and resume into the same normal chat binding", () => workspace(() => {
  const { binding, prepared } = start("Replace Revit TextNote element 1478627 with the approved wording.");
  const waiting = advanceAssignmentKernelProgressV2({ binding }).snapshot;
  assert.equal(waiting.outcome, "awaiting_user_input");
  const question = Object.values(waiting.clarifications)[0]!;
  assert.ok(question);
  controlAssignmentExecutionV2({ binding, command_id: "pause", expected_command_id: null, action: "pause" });
  const answer = { binding, clarification_id: question.clarification_id, external_values: { [question.variable_id]: "Issued for Construction" } };
  supplyAssignmentInputResultV2(answer);
  assert.equal(supplyAssignmentInputResultV2(answer).idempotent, true);
  assert.throws(() => supplyAssignmentInputResultV2({ ...answer, external_values: { [question.variable_id]: "Other text" } }), /integrity_conflict/);
  const resumed = controlAssignmentExecutionV2({ binding, command_id: "resume", expected_command_id: "pause", action: "resume" });
  assert.equal(resumed.execution_control?.state, "running");
  assert.deepEqual(resumed.pending_input_variable_ids, []);
  const redundant = requestAssignmentInputV2({ binding, clarification_id: "duplicate-question",
    variable_ids: [question.variable_id], question: "Please confirm that wording again." });
  assert.equal(redundant.assignment_version, resumed.assignment_version);
  assert.deepEqual(redundant.pending_input_variable_ids, []);
  assert.equal(redundant.input_values.replacement_text, "Issued for Construction");
  assert.equal(redundant.clarifications["duplicate-question"], undefined);
  const continued = prepareAssignmentTurn({ sessionId: binding.session_id, messageId: "second-turn", userText: "Continue saved work",
    toolResults: [], source: "chat", createdBy: null, suppliedBinding: { assignment_id: binding.assignment_id, assignment_run_id: binding.run_id, assignment_generation: binding.generation } })!;
  assert.deepEqual(continued, prepared);
  const request = bindPreparedAssignmentToRequest({ session_id: binding.session_id, message_id: "second-turn", user_text: "Continue saved work", tool_results: [] } as any, continued);
  assert.match(request.user_text!, /Issued for Construction/);
  assert.equal(request.assignment_id, binding.assignment_id);
  assert.deepEqual(buildTeammateTurnContract(request).required_user_inputs, [], "saved answers must resolve the legacy execution guard too");
  const savedText = canonicalTeammateInputs(request).replacement_text as string;
  assert.equal(savedText, "Issued for Construction");
  assert.equal(mutationIntentBlockReason("apply", "/revit/replace-text-note", { newText: savedText }, "approved wording", savedText), null);
  assert.equal(mutationIntentBlockReason("apply", "/revit/replace-text-note", { newText: "invented wording" }, "approved wording", savedText), "desired_postcondition_conflicts_with_authenticated_input");
  assert.deepEqual(canonicalTeammateInputs({ ...request, assignment_generation: 999 }), {});
  assert.deepEqual(canonicalTeammateInputs({ user_text: "approved wording", context: { input_values: { replacement_text: "forged" } } }), {});
}));

test("saved multiline clarification reaches typed and generic mutation admission without losing the final newline", () => workspace(() => {
  const { binding, prepared } = start("Replace the outdated selected note with the current issue wording without creating a duplicate.");
  const question = Object.values(advanceAssignmentKernelProgressV2({ binding }).snapshot.clarifications)[0]!;
  const exact = "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX\n";
  supplyAssignmentInputResultV2({ binding, clarification_id: question.clarification_id, external_values: { [question.variable_id]: exact } });
  const request = bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: binding.session_id,
    message_id: "exact-wording-followup", user_text: "Use this exact replacement wording:\n" + exact.trimEnd(),
    context: { revit: { source: { live: true }, version: "Autodesk Revit 2024", process_id: 4242,
      document: { title: "Text note test", path: "C:\\fixtures\\text-note.rvt", projectIdentity: { fingerprint: "controls-model" } } } }
  } as any, prepared);
  assert.equal(canonicalTeammateInputs(request).replacement_text, exact);
  for (const tool of ["revit_call_tool", "revit_replace_text_note"]) {
    for (const proposed of [exact, exact.trimEnd(), exact.replace(/\n/g, "\r\n")]) {
      const owner = {};
      const lease = beginTeammateLoopOwner(owner, request);
      try {
        const body = { elementId: 1478627, newText: proposed, dryRun: true, apply: false };
        const gate = guardTeammateMcpCall(owner, { tool, arguments: tool === "revit_call_tool"
          ? { method: "POST", path: "/revit/replace-text-note", body } : body });
        assert.equal(gate.allowed, proposed === exact, gate.message);
        if (proposed === exact) assert.equal(gate.call?.effect, "preview");
        else assert.match(gate.message || "", /conflicts with authenticated input/);
      } finally { endTeammateLoopOwner(lease); }
    }
  }
  assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id)!.operations, {}, "guard checks do not invent native dispatch");
}));

test("canonical control HTTP boundary rejects foreign sessions and malformed bindings", () => workspace(async () => {
  const { binding } = start("Replace Revit TextNote element 1478627 with the approved wording.");
  const question = Object.values(advanceAssignmentKernelProgressV2({ binding }).snapshot.clarifications)[0]!;
  const server = http.createServer((req, res) => {
    void runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") }, async () => {
      await handleAssignmentHttpRoute(req, res, new URL(req.url!, "http://localhost"), session => {
        if (session === binding.session_id) return true;
        res.writeHead(403); res.end(); return false;
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const send = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/assignments/v2/execution-control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const body = { ...binding, command_id: "http-pause", expected_command_id: null, action: "pause" };
    assert.equal((await send({ ...body, session_id: "foreign" })).status, 403);
    assert.equal((await send({ ...body, run_id: "wrong" })).status, 409);
    assert.equal((await send({ ...body, command_id: undefined })).status, 409);
    assert.equal((await send(body)).status, 200);
    supplyAssignmentInputResultV2({ binding, clarification_id: question.clarification_id,
      external_values: { replacement_text: "Authenticated saved wording" } });
    const beforeQuestion = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    const questionResponse = await fetch(`http://127.0.0.1:${address.port}/api/assignments/clarifications`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...binding, missing_fields: ["replacement_text"], question: "Confirm again?" })
    });
    const answerText = await questionResponse.text();
    assert.equal(questionResponse.status, 200);
    const answerPayload = JSON.parse(answerText);
    assert.equal(answerPayload.already_resolved, true);
    assert.equal(answerPayload.authenticated_input_values.replacement_text, "Authenticated saved wording");
    assert.ok(answerText.length < 1000, "interaction replies must not dump raw native evidence and the full journal");
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.assignment_version, beforeQuestion.assignment_version);
    const publication = getAssignmentKernelPublicationV2(binding.assignment_id)!;
    assert.equal((parseAssignmentKernelPublicationV2(publication).snapshot.execution_control as { state: string }).state, "paused");
    assert.throws(() => parseAssignmentKernelPublicationV2({ ...publication, snapshot: { ...publication.snapshot, execution_control: { state: "complete" } } }), /execution_control/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("completion recovery HTTP command is bound, repeatable, and cannot resume or settle missing evidence", () => workspace(async root => {
  const { binding, snapshot } = start();
  const lease = openAssignmentKernelOperationV2({ snapshot, provider_turn_id: "provider", controller_request_id: "recover-http",
    capability_id: "inventory.read", classified_effect: "read", arguments: {} });
  controlAssignmentExecutionV2({ binding, command_id: "paused", expected_command_id: null, action: "pause" });
  const before = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  const server = http.createServer((req, res) => {
    const context = req.headers["x-test-no-authority"] ? {} : { operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") };
    void runWithRequestContext(context, async () => {
      await handleAssignmentHttpRoute(req, res, new URL(req.url!, "http://localhost"), session => {
        if (session === binding.session_id) return true;
        res.writeHead(403); res.end(); return false;
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const send = (body: unknown, noAuthority = false) => fetch(`http://127.0.0.1:${address.port}/api/assignments/v2/recover-completions`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(noAuthority ? { "x-test-no-authority": "1" } : {}) }, body: JSON.stringify(body) });
    assert.equal((await send({ ...binding, session_id: "foreign" })).status, 403);
    assert.equal((await send({ ...binding, generation: binding.generation + 1 })).status, 409);
    assert.equal((await send({ ...binding, run_id: "foreign" })).status, 409);
    assert.equal((await send({ ...binding, assignment_id: undefined })).status, 409);
    const denied = await send(binding, true);
    assert.equal(denied.status, 409);
    assert.match(await denied.text(), /foreign_principal/);
    const forged = { ...binding, principal_id: "model-authored-principal", document_fingerprint: "model-authored-target" };
    const ignoredClaims = await (await send(forged)).json() as any;
    assert.equal(ignoredClaims.assignment_snapshot_v2.current_binding.principal_id, snapshot.current_binding.principal_id);
    assert.equal(ignoredClaims.assignment_snapshot_v2.current_binding.document_fingerprint, snapshot.current_binding.document_fingerprint);
    const absent = await (await send(binding)).json() as any;
    assert.deepEqual(absent.recovered_operation_ids, []);
    assert.deepEqual(absent.unresolved_operation_ids, [lease.operation_id]);
    assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id), before);
    retainCompletionOutboxV2(root, completionOutboxKeyV2(root), lease, { content: [], structuredContent: {
      schema: "revit-operator.assignment-kernel-mcp-result/v2",
      operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `retained:${lease.operation_id}`,
        operation_id: lease.operation_id, binding: lease.binding, status: "failed_before_dispatch", dispatch_state: "not_dispatched",
        persistent_effect: "none", native_transaction_state: "not_applicable", authority: "operator-mcp-transport",
        result_schema_id: "operation-transport-failure/v2", observation_required: false, completed_at: new Date().toISOString(),
        request_identity: lease.request_identity, error_code: "pre_dispatch_failure" }
    } });
    const recoveredResponse = await send(binding);
    const recovered = await recoveredResponse.json() as any;
    assert.equal(recoveredResponse.status, 200, JSON.stringify(recovered));
    assert.deepEqual(recovered.recovered_operation_ids, [lease.operation_id]);
    assert.deepEqual(recovered.unresolved_operation_ids, []);
    assert.equal(recovered.assignment_snapshot_v2.execution_control.state, "paused");
    assert.equal(recovered.assignment_snapshot_v2.terminal, false);
    const repeated = await (await send(binding)).json() as any;
    assert.deepEqual(repeated.recovered_operation_ids, []);
    assert.deepEqual(repeated.assignment_snapshot_v2, recovered.assignment_snapshot_v2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("paused dynamic calls queue the existing safe provider-stop boundary without dispatch", () => workspace(async () => {
  const { binding, snapshot } = start();
  controlAssignmentExecutionV2({ binding, command_id: "pause", expected_command_id: null, action: "pause" });
  const stopped: string[] = [];
  const runtime = {
    assignmentKernelV2Binding: () => binding,
    queueAssignmentKernelV2TurnStop: (_turn: unknown, reason: string) => stopped.push(reason),
    callTool: () => { throw new Error("A paused task dispatched a tool"); }
  };
  const result = await handleCodexDynamicToolCall(runtime as any, { id: "call", method: "item/tool/call", params: {
    namespace: "revit_operator", tool: "revit_call_tool", turnId: "turn", arguments: { method: "POST", path: "/revit/quantify", body: {} }
  } } as any) as any;
  assert.equal(result.success, false);
  assert.deepEqual(stopped, ["user_requested_pause"]);
  const checkpoint = checkpointCodexAssignmentProgressV2({ binding, turn_start: snapshot, receipts: [] })!;
  assert.deepEqual(checkpoint.progress_epochs, [], "intentional pause must not consume the no-progress allowance");
  assert.deepEqual(checkpoint.operations, {});
}));

test("C57 covered evidence rereads stop before dynamic dispatch or canonical progress", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Review this model using its sheets, levels and views. Tell me what kind of project it is, which disciplines and levels are represented, and any obvious documentation gaps. Keep this read-only.");
  const scope = { session_id: binding.session_id, assignment_id: binding.assignment_id, run_id: binding.run_id,
    attempt_id: "views", generation: binding.generation };
  const rows = Array.from({ length: 68 }, (_, id) => ({ id, name: `View ${id}`, type: id % 2 ? "FloorPlan" : "CeilingPlan",
    discipline: "Mechanical", levelName: `L${id % 6}`, isTemplate: false, isPlacedOnSheet: id < 17, sheetNumber: id < 17 ? `M${id}` : null }));
  const stored = storeEvidence({ scope, source: "native-views", trust_level: "authoritative_native", raw: { payload: { views: rows } } });
  const calls: unknown[] = [];
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (tool: string, args: any, context: any) => {
      calls.push({ tool, args });
      const lease = context.assignmentKernelV2;
      context.onMcpAccepted();
      const result = retrieveEvidence({ scope, evidence_id: args.evidenceId, purpose: args.purpose,
        item_range: args.itemRange, max_bytes: args.maxBytes });
      const payload = { ok: true, result };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `result:${lease.operation_id}`,
          operation_id: lease.operation_id, binding, status: "succeeded", dispatch_state: "dispatched",
          persistent_effect: "none", native_transaction_state: "not_applicable", authority: "operator-evidence-store",
          result_schema_id: "operator-capability/operator_retrieve_evidence/v2", observation_required: true,
          raw_payload_hash: payloadDigestV2(payload).digest, request_identity: lease.request_identity, completed_at: new Date().toISOString() },
        observation: { raw_payload: payload, semantic_facts: [{ fact_id: "control.evidence_selection_available", fact_class: "control", value: true,
          cardinality: "many", identity_dimensions: ["capability_id", "evidence_id", "selection_path"],
          dimensions: { capability_id: tool, evidence_id: args.evidenceId, selection_path: args.itemRange.path } }],
          verification_relevance: ["control"] }
      } };
    }
  };
  const request = bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: binding.session_id,
    user_text: snapshot.spec.source_user_request, context: { revit: { process_id: 4242, source: { live: true },
      document: { title: "Snowdon Towers Sample HVAC", projectIdentity: { fingerprint: "controls-model" } } } } } as any, prepared);
  const owner = beginTeammateLoopOwner(runtime, request);
  const fields = ["id", "name", "type", "discipline", "levelName", "isTemplate", "isPlacedOnSheet", "sheetNumber"];
  const invoke = (id: string, count: number, purpose: string) => handleCodexDynamicToolCall(runtime as any, { id, method: "item/tool/call", params: {
    namespace: "revit_operator", turnId: "c57-review", tool: "operator_retrieve_evidence", arguments: {
      evidenceId: stored.ref.evidence_id, purpose, itemRange: { path: "payload.views", start: 0, count, fields }, maxBytes: 1_048_576
    }
  } } as any) as Promise<any>;
  try {
    const first = await invoke("views-all", 100, "Determine represented view types, disciplines, levels, and documentation gaps");
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(calls.length, 1);
    const afterFirst = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    const operationIds = Object.keys(afterFirst.operations);
    assert.equal(operationIds.length, 1);
    assert.equal(afterFirst.progress_epochs.length, 1);
    for (const count of [10, 68, 100]) {
      const before = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
      const replay = await invoke(`views-replay-${count}`, count, `Reworded reread ${count}`);
      assert.equal(replay.success, false);
      assert.match(replay.contentItems.map((item: any) => item.text).join("\n"), /evidence selection already available/i);
      const after = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
      assert.equal(calls.length, 1, "covered evidence must not reach the MCP runtime");
      assert.equal(after.assignment_version, before.assignment_version, "covered evidence must not open a canonical operation");
      assert.deepEqual(Object.keys(after.operations), operationIds);
      assert.equal(after.progress_epochs.length, 1, "covered evidence must not consume a no-progress epoch");
      assert.equal(after.terminal, false);
    }
  } finally { endTeammateLoopOwner(owner); }
}));

test("duplicate-view unknown native settlement survives dynamic handoff and prevents false completion or replay", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Make a coordination copy of this plan, including its annotations. Call it M-COORDINATION COPY.");
  let dispatches = 0;
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (_tool: string, _args: any, context: any) => {
      dispatches++;
      const lease = context.assignmentKernelV2;
      context.onMcpAccepted();
      const payload = { success: true, viewId: 1542917, name: "M-COORDINATION COPY" };
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `result:${lease.operation_id}`,
          operation_id: lease.operation_id, binding, status: "succeeded", dispatch_state: "dispatched",
          persistent_effect: "unknown", native_transaction_state: "unknown", authority: "native-host",
          result_schema_id: "operator-native/POST:/revit/duplicate-view/v2", observation_required: true,
          raw_payload_hash: payloadDigestV2(payload).digest, request_identity: lease.request_identity, completed_at: new Date().toISOString() },
        observation: { raw_payload: payload, semantic_facts: [{ fact_id: "task.result_available", fact_class: "domain", value: true }],
          verification_relevance: ["task_result"], evidence_class: "task_result" }
      } };
    }
  };
  const args = { method: "POST", path: "/revit/duplicate-view", body: { viewId: 1363433, newName: "M-COORDINATION COPY", withDetailing: true } };
  const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: "operator.backend.v1",
    session_id: binding.session_id, user_text: snapshot.spec.source_user_request,
    context: { revit: { process_id: 4242, source: { live: true }, activeView: { id: 1363433, name: "L4" },
      document: { title: "Snowdon Towers Sample HVAC", projectIdentity: { fingerprint: "controls-model" } } } }
  } as any, prepared));
  let dynamic: unknown;
  try {
    dynamic = await handleCodexDynamicToolCall(runtime as any, { id: "duplicate", method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "duplicate-turn", tool: "revit_call_tool", arguments: args
    } } as any);
  } finally { endTeammateLoopOwner(owner); }
  const retained = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  assert.equal(dispatches, 1, JSON.stringify(dynamic));
  assert.equal(retained.terminal, false);
  assert.equal(retained.unresolved_unknown_operation_ids.length, 1);
  assert.equal(retained.operations[retained.unresolved_unknown_operation_ids[0]!]!.settlement_state, "settled");
  const final = finalCodexAssignmentMessageV2(retained, "Created M-COORDINATION COPY with annotations.");
  assert.match(final, /could not confirm/);
  assert.doesNotMatch(final, /Created M-COORDINATION COPY/);
  assert.throws(() => openAssignmentKernelOperationV2({ snapshot: retained, provider_turn_id: "retry",
    controller_request_id: "duplicate-again", capability_id: "revit_call_tool", classified_effect: "apply", arguments: args }), /unknown|reconciliation/);
  assert.equal(dispatches, 1);
}));

test("unknown mutation effects prevent resume even after the dispatch settles", () => workspace(() => {
  const { binding, snapshot } = start("Replace selected note with exact literal 'Verified text'.");
  const lease = openAssignmentKernelOperationV2({ snapshot, provider_turn_id: "provider", controller_request_id: "edit",
    capability_id: "revit_call_tool", classified_effect: "apply", arguments: { method: "POST", path: "/revit/replace-text-note", body: { elementId: 1, newText: "Verified text", dryRun: false } } });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  controlAssignmentExecutionV2({ binding, command_id: "pause", expected_command_id: null, action: "pause" });
  failAssignmentKernelOperationV2(lease, new Error("response lost"), "dispatched");
  assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.unresolved_unknown_operation_ids.length, 1);
  assert.throws(() => controlAssignmentExecutionV2({ binding, command_id: "resume", expected_command_id: "pause", action: "resume" }), /reconciliation_required/);
}));


test("canonical rolled-back create-view releases the legacy guard for a corrected native request", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Make a Level 2 mechanical coordination plan called M-LEVEL 2 COORDINATION.");
  let dispatches = 0;
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (_tool: string, args: any, context: any) => {
      const lease = context.assignmentKernelV2;
      context.onMcpAccepted();
      const failed = ++dispatches === 1;
      const payload = failed ? { success: false, error: "The requested level was not found.", transaction: { status: "rolled_back" } }
        : { success: true, viewId: 123, name: args.body.name };
      const receipt = "receipt:" + lease.operation_id;
      return { isError: failed, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: "result:" + lease.operation_id,
          operation_id: lease.operation_id, binding, status: failed ? "failed_after_dispatch" : "succeeded", dispatch_state: "dispatched",
          persistent_effect: failed ? "none" : "applied", native_transaction_state: failed ? "rolled_back" : "committed", authority: "native-host",
          result_schema_id: "operator-native/POST:/revit/create-view/v2", observation_required: true, receipt_id: receipt, native_correlation_id: receipt,
          raw_payload_hash: payloadDigestV2(payload).digest, request_identity: lease.request_identity, completed_at: new Date().toISOString() },
        observation: { raw_payload: payload, semantic_facts: [], verification_relevance: ["task_result"], evidence_class: "task_result" }
      } };
    }
  };
  const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: "operator.backend.v1",
    session_id: binding.session_id, user_text: snapshot.spec.source_user_request,
    context: { revit: { process_id: 4242, source: { live: true }, activeView: { id: 44, name: "L4" },
      document: { title: "Mechanical model", projectIdentity: { fingerprint: "controls-model" } } } }
  } as any, prepared));
  try {
    const run = (levelName: string, id: string) => handleCodexDynamicToolCall(runtime as any, { id, method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "create-turn", tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/create-view",
        body: { action: "create_floor_plan", name: "M-LEVEL 2 COORDINATION", levelName, planType: "engineering", discipline: "Mechanical", dryRun: false } }
    } } as any);
    await run("Level 2", "first");
    const second = await run("L2", "corrected");
    assert.equal(dispatches, 2, JSON.stringify(second));
    const retained = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.equal(retained.unresolved_unknown_operation_ids.length, 0);
    const operations = Object.values(retained.operations).filter(o => o.requested_effect === "apply");
    assert.equal(operations.length, 2);
    assert.equal(operations[0]!.result?.native_transaction_state, "rolled_back");
    assert.equal(operations[1]!.persistent_effect, "applied");
    const third = await run("L3", "unverified-next");
    assert.equal(dispatches, 2, JSON.stringify(third));
    assert.match(JSON.stringify(third), /prior apply verification required/);
  } finally { endTeammateLoopOwner(owner); }
}));

test("dynamic criterion handoff projects status after canonical evaluation", () => workspace(async () => {
  const { prepared, binding, snapshot } = start();
  let canonicalResponse: any;
  const runtime = { assignmentKernelV2Binding: () => binding,
    queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (tool: string, args: any, context: any) => {
      assert.equal(tool, "operator_evaluate_assignment_criteria");
      assert.deepEqual(context.assignmentKernelV2Binding, binding);
      canonicalResponse = { ok: true, assignment_snapshot_v2: evaluateAssignmentObservationCriteriaV2({ binding, claims: args.claims }) };
      return { content: [{ type: "text", text: JSON.stringify(canonicalResponse) }] };
    } };
  const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: "operator.backend.v1",
    session_id: binding.session_id, user_text: snapshot.spec.source_user_request } as any, prepared));
  try {
    const result: any = await handleCodexDynamicToolCall(runtime as any, { id: "criterion-handoff", method: "item/tool/call",
      params: { namespace: "revit_operator", turnId: "criterion-turn", tool: "operator_evaluate_assignment_criteria",
        arguments: { claims: [{ criterion_id: snapshot.spec.criteria[0]!.criterion_id, observation_ids: [] }] } } } as any);
    assert.equal(result.success, true, JSON.stringify(result));
    const status = JSON.parse(result.contentItems[0].text).assignment_status;
    assert.equal(status.outcome, canonicalResponse.assignment_snapshot_v2.outcome);
    assert.equal(status.terminal, canonicalResponse.assignment_snapshot_v2.terminal);
    assert.notEqual(status.criteria[0].status, "pass", "no evidence cannot become successful completion");
    assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id), canonicalResponse.assignment_snapshot_v2);
  } finally { endTeammateLoopOwner(owner); }
}));

test("new engineering decisions persist through two questions and process restart without rewriting task or authority", () => workspace(() => {
  const original = "Prepare a proposed zoning schedule. Keep unlike room uses separate, give corner rooms their own zones, and aim for groups no larger than 600 square feet. Do not draw zones or place VAVs yet.";
  const { binding, snapshot, prepared } = start(original);
  assert.equal(snapshot.spec.requested_effect, "read");
  assert.deepEqual(snapshot.spec.input_variables, []);
  const question = { binding, clarification_id: "choose-floor", variable_ids: ["floor_name"],
    new_variable_ids: ["floor_name"], question: "Which floor should I use for the proposed zoning schedule?" };
  const waiting = requestAssignmentInputV2(question as any);
  assert.equal(codexAssignmentControllerStopMessage(waiting, "assignment_progress_controller_stop"), question.question,
    "C27: a provider interrupted by the input controller must deliver the durable question");
  assert.deepEqual(waiting.spec, snapshot.spec);
  assert.deepEqual(waiting.pending_input_variable_ids, ["floor_name"]);
  assert.equal(requestAssignmentInputV2(question as any).assignment_version, waiting.assignment_version);
  assert.equal(advanceAssignmentKernelProgressV2({ binding }).decision.decision, "request_user_input");
  assert.throws(() => supplyAssignmentInputResultV2({ binding, clarification_id: "choose-floor", external_values: { unknown: "L2" } }), /unknown/);
  assert.throws(() => supplyAssignmentInputResultV2({ binding: { ...binding, session_id: "other-session" }, clarification_id: "choose-floor", external_values: { floor_name: "L2" } }), /binding/);
  const answer = { binding, clarification_id: "choose-floor", external_values: { floor_name: "L2" } };
  supplyAssignmentInputResultV2(answer);
  assert.equal(supplyAssignmentInputResultV2(answer).idempotent, true);
  assert.throws(() => supplyAssignmentInputResultV2({ ...answer, external_values: { floor_name: "L4" } }), /integrity_conflict/);
  const second = requestAssignmentInputV2({ binding, clarification_id: "corner-definition", variable_ids: ["corner_definition"],
    new_variable_ids: ["corner_definition"], question: "Should corner rooms mean spaces with exterior walls facing two directions?" } as any);
  assert.equal(second.input_values.floor_name, "L2");
  assert.deepEqual(second.pending_input_variable_ids, ["corner_definition"]);
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { getAssignmentKernelSnapshotV2 } from './src/assignments/assignment_kernel_v2_store.ts'; process.stdout.write(JSON.stringify(getAssignmentKernelSnapshotV2(${JSON.stringify(binding.assignment_id)})));`
  ], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const replay = JSON.parse(child.stdout);
  assert.equal(codexAssignmentControllerStopMessage(replay, "assignment_progress_controller_stop"),
    "Should corner rooms mean spaces with exterior walls facing two directions?", "restart must not repeat the answered floor question");
  assert.deepEqual(replay.spec, snapshot.spec);
  assert.deepEqual(replay.input_values, second.input_values);
  assert.deepEqual(replay.pending_input_variable_ids, ["corner_definition"]);
  supplyAssignmentInputResultV2({ binding, clarification_id: "corner-definition", external_values: { corner_definition: "Yes: exterior walls facing two directions; keep uncertain exposure separate for review." } });
  const complete = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  assert.deepEqual(complete.spec, snapshot.spec);
  assert.equal(complete.input_values.floor_name, "L2");
  assert.match(String(complete.input_values.corner_definition), /uncertain exposure/);
  assert.deepEqual(complete.pending_input_variable_ids, []);
  assert.equal(complete.terminal, false, "answers alone never complete engineering work");
  const resumed = bindPreparedAssignmentToRequest({ user_text: "Continue the existing task using its saved answers and evidence." } as any, prepared);
  assert.match(String((resumed.context as any).ui.authoritative_user_text), /Keep unlike room uses separate/);
  assert.match(String((resumed.context as any).ui.authoritative_user_text), /floor_name.*L2/);
  assert.throws(() => openAssignmentKernelOperationV2({ snapshot: complete, provider_turn_id: "resume", controller_request_id: "forbidden-write",
    capability_id: "revit_call_tool", classified_effect: "apply", arguments: { method: "POST", path: "/revit/set-parameter", body: { changes: [{ elementId: 42, parameterName: "Comments", value: "not authorized" }] } } }), /effect|write|intent/);
  assert.deepEqual(requestAssignmentInputV2(question as any).input_values, complete.input_values, "a repeated question cannot reopen an answered decision");
}));

test("discovered inputs reject reserved names and unannounced variables before journal changes", () => workspace(() => {
  const { binding, snapshot } = start();
  const base = { binding, clarification_id: "new-question", question: "Which floor?" };
  for (const name of ["session_id", "principal_id", "document_fingerprint", "generation", "constructor", "prototype", "bad-name"])
    assert.throws(() => requestAssignmentInputV2({ ...base, variable_ids: [name], new_variable_ids: [name] } as any), /invalid|forbidden/);
  assert.throws(() => requestAssignmentInputV2({ ...base, variable_ids: ["floor_name"] }), /unknown/);
  assert.throws(() => requestAssignmentInputV2({ ...base, variable_ids: ["floor_name"], new_variable_ids: ["room_use"] } as any), /declaration|variable/);
  assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id)!.spec, snapshot.spec);
  assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.assignment_version, snapshot.assignment_version);
}));

test("HTTP discovered questions keep session authority and reach compact model status and authenticated answers", () => workspace(async () => {
  const { binding, snapshot } = start();
  const server = http.createServer((req,res) => {
    const auth = req.headers["x-test-no-authority"] ? {} : { operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") };
    void runWithRequestContext(auth, async () => {
      await handleAssignmentHttpRoute(req,res,new URL(req.url!,"http://localhost"),session => {
        if (session === binding.session_id) return true;
        res.writeHead(403); res.end(); return false;
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    const address=server.address() as import("node:net").AddressInfo;
    const send=(route:string,body:unknown,noAuthority=false)=>fetch(`http://127.0.0.1:${address.port}/api/assignments/v2/${route}`,{
      method:"POST",headers:{"Content-Type":"application/json",...(noAuthority?{"x-test-no-authority":"1"}:{})},body:JSON.stringify(body)});
    const question={...binding,clarification_id:"http-floor",variable_ids:["floor_name"],new_variable_ids:["floor_name"],question:"Which floor should I inspect?"};
    assert.equal((await send("clarifications",{...question,session_id:"foreign"})).status,403);
    assert.equal((await send("clarifications",{...question,generation:binding.generation+1})).status,400);
    assert.equal((await send("clarifications",question,true)).status,400);
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.assignment_version,snapshot.assignment_version);
    const response=await send("clarifications",question);
    assert.equal(response.status,202);
    const waiting=await response.json() as any;
    assert.deepEqual(waiting.assignment_snapshot_v2.spec,snapshot.spec);
    const {projectAssignmentStatusForModel}=await import("../src/brains/assignment_status_projection.js");
    const compact=projectAssignmentStatusForModel(waiting)!.assignment_status;
    assert.ok(compact.pending_input_definitions.some((item:any)=>item.variable_id==="floor_name"));
    assert.ok(compact.clarifications.some((item:any)=>item.question===question.question));
    const oldQuestions=Object.fromEntries(Array.from({length:40},(_,i)=>[`old-${i}`,{clarification_id:`old-${i}`,variable_id:`old_${i}`,question:`Resolved question ${i}`,requested_at:"2026-09-01T00:00:00Z",resolved_at:"2026-09-01T01:00:00Z"}]));
    const longStatus=projectAssignmentStatusForModel({...waiting,assignment_snapshot_v2:{...waiting.assignment_snapshot_v2,
      clarifications:{...oldQuestions,...waiting.assignment_snapshot_v2.clarifications}}})!.assignment_status;
    assert.equal(longStatus.clarifications[0].question,question.question,"active question must survive a long resolved history");
    assert.ok(longStatus.omitted.clarifications.count > 0);
    const badAnswer=await send("inputs",{...binding,clarification_id:"http-floor",values:{floor_name:"L2",generation:99}});
    assert.equal(badAnswer.status,400);
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.input_values.floor_name,undefined);
    const answered=await send("inputs",{...binding,clarification_id:"http-floor",values:{floor_name:"L2"}});
    assert.equal(answered.status,200);
    const saved=await answered.json() as any;
    assert.deepEqual(saved.assignment_snapshot_v2.spec,snapshot.spec);
    assert.deepEqual(saved.assignment_snapshot_v2.input_values,{floor_name:"L2"});
    assert.equal(saved.assignment_snapshot_v2.terminal,false);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
}));

test("C26 HVAC workbook replay keeps requested assessment pending after exact file verification", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Prepare a room-by-room Excel workbook of the information we can get from this model for HVAC load calculations. Check that the room or space list and the exported values are correct, keep the units clear, and flag anything important that is missing or cannot be verified. Include a short list of the decisions or other inputs you need from me. Do not change the Revit model or invent final heating and cooling loads.");
  const outputPath = "C:/fixture/rooms.xlsx";
  const file = { path: outputPath, size_bytes: 8251485, sha256: "a".repeat(64), exists: true, readable: true };
  const receipt = { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: "/revit/export-elements-xlsx",
    phase: "apply", status: "complete", expected_output_paths: [outputPath], expected_export_calls: 1, export_calls: [true],
    outputs: [{ ...file, fresh_output: true }] };
  const calls: string[] = [];
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (tool: string, args: any, context: any) => {
      const lease = context.assignmentKernelV2;
      calls.push(args.path || tool);
      context.onMcpAccepted();
      const native = tool === "revit_call_tool";
      const apply = args.path === "/revit/export-elements-xlsx";
      const payload = apply ? { ok: true, status: "Success", artifact_receipt: receipt, path: outputPath, selectedCount: 67, parameterCount: 29, issueCount: 670, issueCounts: { ambiguous_parameter: 67, missing_parameter: 335, unset: 268 } }
        : native ? { schema: "revit-operator.exported-file-inspection.v1", ok: true, itemsComplete: true, requestedPaths: [outputPath], files: [file] }
          : tool === "revit_search_tools" ? { matches: [{ method: "POST", path: "/revit/inspect-exported-files" }] } : { artifact_receipt: receipt };
      const facts = native ? [{ fact_id: apply ? "task.result_available" : "control.result_available", fact_class: apply ? "domain" : "control", value: true }]
        : tool === "revit_search_tools" ? [{ fact_id: "control.capability_available", fact_class: "control", value: true,
          cardinality: "many", identity_dimensions: ["capability_id", "method", "path"],
          dimensions: { capability_id: tool, method: "POST", path: "/revit/inspect-exported-files" } }]
          : [{ fact_id: "control.evidence_selection_available", fact_class: "control", value: true,
            cardinality: "many", identity_dimensions: ["capability_id", "evidence_id", "selection_path"],
            dimensions: { capability_id: tool, evidence_id: "retained-export", selection_path: "payload.artifact_receipt" } }];
      const retrieval = { ok: true, result: { schema: "revit-operator.evidence-retrieval.v1",
        selection: { "payload.artifact_receipt": receipt }, complete: false } };
      return { content: tool === "operator_retrieve_evidence" ? [{ type: "text", text: JSON.stringify(retrieval) }] : [], structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `handoff:${lease.operation_id}`,
          operation_id: lease.operation_id, binding, status: "succeeded",
          dispatch_state: "dispatched", persistent_effect: apply ? "applied" : "none",
          native_transaction_state: "not_applicable", authority: native ? "native-host" : tool === "operator_retrieve_evidence" ? "operator-evidence-store" : "operator-mcp-transport",
          result_schema_id: native ? `operator-native/POST:${args.path}/v2` : `operator-capability/${tool}/v2`,
          observation_required: true, request_identity: lease.request_identity, completed_at: new Date().toISOString(),
          raw_payload_hash: payloadDigestV2(payload).digest,
          ...(apply ? { native_artifact_receipt: receipt, affected_target_identities: [`artifact_path:${outputPath}`] } : {}) },
        observation: { raw_payload: payload, semantic_facts: facts, verification_relevance: [apply ? "task_result" : "control"] }
      } };
    }
  };
  const loopRequest = bindPreparedAssignmentToRequest({ version: "operator.backend.v1",
    session_id: binding.session_id, user_text: snapshot.spec.source_user_request,
    context: { revit: { process_id: 4242, source: { live: true }, document: { title: "Snowdon HVAC", projectIdentity: { fingerprint: "controls-model" } } } }
  } as any, prepared);
  const owner = beginTeammateLoopOwner(runtime, loopRequest);
  const run = async (id: string, tool: string, args: any) => {
    const result = await handleCodexDynamicToolCall(runtime as any, { id, method: "item/tool/call",
      params: { namespace: "revit_operator", turnId: "pdf-handoff", tool, arguments: args } } as any) as any;
    assert.equal(result.success, true, JSON.stringify(result));
    if (tool === "operator_retrieve_evidence") {
      const rendered = result.contentItems.map((item: any) => item.text).join("\n");
      const parsed = JSON.parse(rendered);
      assert.deepEqual(parsed.result.selection["payload.artifact_receipt"], receipt);
      assert.equal(parsed.model_observation_index.schema, "revit-operator.model-observation-index/v2");
      assert.equal(parsed.model_observation_index.observations[0].capability_id, "operator_retrieve_evidence");
      assert.equal(result.contentItems.length, 1);
    }
  };
  try {
    assert.equal(snapshot.spec.result_delivery_required, true);
    assert.equal(snapshot.spec.result_assessment_required, true);
    const initialGuidance = prepareCodexAssignmentProgressV2(binding).prompt;
    assert.doesNotMatch(initialGuidance, /The exported file is verified/,
      "C27: an assessment requirement must not invent an export before the first operation");
    assert.match(initialGuidance, /If export is still outstanding, complete that work first/);
    await run("export", "revit_call_tool", { method: "POST", path: "/revit/export-elements-xlsx",
      body: { elementIds: [42], parameterNames: ["Area"], fileName: "rooms.xlsx", dryRun: false } });
    const applied = advanceAssignmentKernelProgressV2({ binding }).snapshot;
    const artifact = Object.values(applied.observations).find(o => o.evidence_class === "task_result")!;
    const selected = [{ label: "Workbook", observation_id: artifact.observation_id, path: ["path"] },
      { label: "Spaces", observation_id: artifact.observation_id, path: ["selectedCount"] },
      { label: "Missing fields", observation_id: artifact.observation_id, path: ["issueCounts", "missing_parameter"] }];
    const assessment = { overview: "Exported 67 spaces. Review the missing and ambiguous inputs before calculating loads.",
      findings: [{ priority: "high" as const, title: "Missing source data", text: "335 requested fields are absent in the selected spaces.", evidence_indices: [2,3] }],
      limitations: ["Recorded values do not establish final heating or cooling loads or code compliance."],
      questions: ["Which occupancy, envelope and equipment-load assumptions should be used?"] };
    assert.throws(() => buildAssignmentResultDeliveryV2(applied, selected, assessment), /ineligible/,
      "successful export alone cannot deliver an unverified artifact");
    await run("lookup", "revit_search_tools", { query: "verify exported workbook", max: 5, includeSchemas: true });
    await run("inspect", "revit_call_tool", { method: "POST", path: "/revit/inspect-exported-files", body: { paths: [outputPath] } });
    const verified = advanceAssignmentKernelProgressV2({ binding }).snapshot;
    assert.equal(verified.terminal, false, "file verification must not silently omit requested analysis");
    assert(deriveProgressGapsV2(verified).some(g => g.kind === "result_delivery_required"));
    assert.throws(() => buildAssignmentResultDeliveryV2(verified, selected), /assessment_required/);
    const lookup = Object.values(verified.observations).find(o => o.authority === "operator-mcp-transport")!;
    assert.throws(() => buildAssignmentResultDeliveryV2(verified,
      [{ label: "Tool documentation", observation_id: lookup.observation_id, path: ["matches"] }]), /ineligible/);
    const before = JSON.stringify(verified.criteria);
    const delivery = buildAssignmentResultDeliveryV2(verified, selected, assessment);
    assert.equal(JSON.stringify(verified.criteria), before, "interpretation never becomes evaluator truth");
    for (const change of [{ status: "unverified" }, { export_calls: [false] }, { outputs: [] }]) {
      const tampered = structuredClone(verified);
      const op = tampered.operations[artifact.operation_id]!;
      (op.result as any).native_artifact_receipt = { ...op.result!.native_artifact_receipt, ...change };
      assert.throws(() => buildAssignmentResultDeliveryV2(tampered, selected, assessment), /ineligible/);
    }
    const final = evaluateAssignmentObservationCriteriaV2({ binding, claims: [{ criterion_id: snapshot.spec.criteria[0]!.criterion_id,
      observation_ids: [artifact.observation_id] }], result_items: selected, assessment });
    assert.equal(final.outcome, "complete");
    const answer = renderTerminalResultV2(final);
    assert.match(answer, /rooms.xlsx/); assert.match(answer, /335/); assert.match(answer, /occupancy, envelope/);
    assert.deepEqual(final.spec, snapshot.spec);
    assert.deepEqual(final.result_delivery, delivery);
    assert.equal(Object.values(final.operations).filter(o => o.persistent_effect === "applied").length, 1);
    const replay = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { getAssignmentKernelSnapshotV2 } from './src/assignments/assignment_kernel_v2_store.ts'; process.stdout.write(JSON.stringify(getAssignmentKernelSnapshotV2(${JSON.stringify(binding.assignment_id)})));`
    ], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
    assert.equal(replay.status, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout).result_delivery, delivery);
  } finally { endTeammateLoopOwner(owner); }
}));
