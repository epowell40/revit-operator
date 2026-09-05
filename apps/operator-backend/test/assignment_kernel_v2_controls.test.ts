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
import { openAssignmentKernelOperationV2, failAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { supplyAssignmentInputResultV2, requestAssignmentInputV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
import { handleAssignmentHttpRoute } from "../src/assignments/http_routes.js";
import { getAssignmentKernelPublicationV2 } from "../src/assignments/assignment_kernel_v2_publication.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { parseAssignmentKernelPublicationV2 } from "@revitoperator/assignment-kernel-v2-contracts";
import { handleCodexDynamicToolCall } from "../src/brains/codex_dynamic_tool_handler.js";
import { checkpointCodexAssignmentProgressV2 } from "../src/brains/codex_assignment_progress.js";
import { buildTeammateTurnContract } from "../src/teammate_loop_runtime.js";
import { canonicalTeammateInputs } from "../src/teammate_assignment_inputs.js";
import { mutationIntentBlockReason } from "../src/teammate_mutation_intent_binding.js";
import { completionOutboxKeyV2, retainCompletionOutboxV2 } from "@revitoperator/assignment-kernel-v2-contracts/completion-outbox";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA } from "../src/assignments/assignment_kernel_v2_execution.js";
import { renderTerminalResultV2 } from "../src/assignments/assignment_kernel_v2_terminal_result.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";

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

test("read-result HTTP delivery returns native values, rejects foreign or missing evidence, and survives publication", () => workspace(async () => {
  const { binding, snapshot, prepared } = start("Tell me what is selected in Revit, its size, and which system it belongs to. Leave the model unchanged.");
  const payload = { name: "PVC - DWV", parameters: { Size: '4"ø', "System Name": "Building Sanitary" } };
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
  const observation = Object.values(afterReads.observations).find(item =>
    afterReads.operations[item.operation_id]!.request_identity?.path === "/revit/get-parameters")!;
  assert.equal(observation.evidence_class, "task_result");
  assert.ok(afterReads.progress_epochs.at(-1)!.progress_reasons.includes("authoritative_observation_added"));
  const observationId = observation.observation_id;
  const mapping = dynamicResponse.contentItems.map((item: any) => JSON.parse(item.text)).find((item: any) => item.schema === "revit-operator.model-observation-index/v2");
  assert.equal(mapping.observations[0].observation_id, observationId);
  assert.equal(mapping.observations[0].evidence_id, observation.raw_payload_ref.replace(/^evidence:/, ""));
  assert.deepEqual(mapping.observations[0].eligible_criterion_ids, [snapshot.spec.criteria[0]!.criterion_id]);
  const body = { ...binding, claims: [{ criterion_id: snapshot.spec.criteria[0]!.criterion_id, observation_ids: [observationId] }],
    result_items: [{ label: "Selected pipe", observation_id: observationId, path: ["name"] },
      { label: "Size", observation_id: observationId, path: ["parameters", "Size"] },
      { label: "System", observation_id: observationId, path: ["parameters", "System Name"] }] };
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
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.terminal, false);
    const response = await send(body);
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as any;
    assert.equal(renderTerminalResultV2(result.assignment_snapshot_v2), '- Selected pipe: PVC - DWV\n- Size: 4"ø\n- System: Building Sanitary');
    const published = parseAssignmentKernelPublicationV2(getAssignmentKernelPublicationV2(binding.assignment_id)!);
    assert.deepEqual((published.snapshot as any).result_delivery, result.assignment_snapshot_v2.result_delivery);
    assert.equal((await send(body)).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
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
