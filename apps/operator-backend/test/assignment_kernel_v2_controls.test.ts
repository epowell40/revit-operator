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
import { supplyAssignmentInputResultV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
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
  const { binding } = start();
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
    const publication = getAssignmentKernelPublicationV2(binding.assignment_id)!;
    assert.equal((parseAssignmentKernelPublicationV2(publication).snapshot.execution_control as { state: string }).state, "paused");
    assert.throws(() => parseAssignmentKernelPublicationV2({ ...publication, snapshot: { ...publication.snapshot, execution_control: { state: "complete" } } }), /execution_control/);
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
