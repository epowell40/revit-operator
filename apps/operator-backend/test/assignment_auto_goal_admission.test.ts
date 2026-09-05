import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareAssignmentTurn, bindPreparedAssignmentToRequest } from "../src/assignments/turn_preparation.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { runWithRequestContext } from "../src/request_context.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";
import { handleCodexDynamicToolCall } from "../src/brains/codex_dynamic_tool_handler.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";

for (const [effect, prompt, facts] of [
  ["read", "Count all air devices in the project and break the total down by family and type. Do not change the model.", ["inventory.complete", "inventory.total", "inventory.group"]],
  ["read", "Tell me what is selected in Revit, its size, and which system it belongs to. Leave the model unchanged.", ["task.result_available"]],
  ["read", "What size is this?", ["task.result_available"]],
  ["read", "Which system does this belong to?", ["task.result_available"]],
  ["preview", "Run a rollback preview moving the selected device one foot east. Do not commit.", ["task.preview_valid"]],
  ["apply", "Replace the selected note text with the exact literal 'Issued for Construction'.", ["task.result_available"]]
] as const) {
  test(`normal chat admits ${effect} auto-goals with a native evidence contract under V2`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-auto-admission-"));
    const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
    const previousV2 = process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
    process.env.OPERATOR_WORKSPACE_ROOT = root;
    process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
    __testOnlyResetGoalListCache();
    try {
      runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-token") }, () => {
        // Same admission edge as /chat and /chat/stream; no hand-made Goal or
        // benchmark-only acceptance criteria bypass the normal UI producer.
        const prepared = prepareAssignmentTurn({
          sessionId: "normal-ui-session", messageId: "normal-ui-message",
          userText: prompt, toolResults: [], source: "chat", createdBy: null,
          requestContext: { revit: { document: { projectIdentity: { fingerprint: "test-model" } } } }
        });
        assert.equal(prepared?.kernelVersion, 2);
        const snapshot = getAssignmentKernelSnapshotV2(prepared!.assignmentId)!;
        assert.equal(snapshot.spec.requested_effect, effect);
        assert.equal(snapshot.current_binding.principal_id, "local:shared-token");
        assert.equal(snapshot.current_binding.document_fingerprint, "test-model");
        assert.equal(snapshot.spec.source_user_request, prompt);
        assert.equal(snapshot.spec.criteria.length, 1);
        assert.deepEqual(snapshot.spec.criteria[0]!.semantic_fact_requirements, facts);
        assert.equal(snapshot.spec.criteria[0]!.evidence_policy?.require_native_dispatch, true);
        assert.equal(snapshot.spec.criteria[0]!.evidence_policy?.require_current_generation, true);
        assert.equal(snapshot.terminal, false, "admission must not certify completion");
        assert.deepEqual(snapshot.criteria, {}, "no criterion passes before native evidence");
        const bound = bindPreparedAssignmentToRequest({ session_id: "normal-ui-session", user_text: prompt } as any, prepared);
        assert.equal(bound.assignment_id, snapshot.current_binding.assignment_id);
        assert.equal(bound.assignment_run_id, snapshot.current_binding.run_id);
        assert.equal(bound.assignment_generation, snapshot.current_binding.generation);
        assert.throws(() => prepareAssignmentTurn({ sessionId: "different-session", messageId: "foreign",
          userText: prompt, toolResults: [], source: "chat", createdBy: null, suppliedBinding: bound }), /stale_or_mismatched/);
      });
    } finally {
      if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
      else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
      if (previousV2 === undefined) delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
      else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = previousV2;
      __testOnlyResetGoalListCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("context admission does not turn empty input, tool continuations, or unrelated conversation into new work", () => {
  const base = { sessionId: "no-admission", messageId: "no-admission", toolResults: [], source: "chat", createdBy: null };
  assert.equal(classifyAutoGoalRequest("What size is this?").shouldStart, false, "the regression requires contextual admission");
  assert.equal(prepareAssignmentTurn({ ...base, userText: "What size is this?" }), null);
  assert.equal(prepareAssignmentTurn({ ...base, userText: "", requestContext: { revit: {} } }), null);
  assert.equal(prepareAssignmentTurn({ ...base, userText: "What size is this?", toolResults: [{}] as any, requestContext: { revit: {} } }), null);
});

test("a short UI read reaches the MCP boundary only with its admitted canonical binding", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-context-mcp-"));
  const previous = [process.env.OPERATOR_WORKSPACE_ROOT, process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  __testOnlyResetGoalListCache();
  try {
    await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-token") }, async () => {
      const prompt = "What size is this?";
      const context = { revit: { source: { live: true }, document: { title: "Disposable", projectIdentity: { fingerprint: "model" } } } };
      const prepared = prepareAssignmentTurn({ sessionId: "short-read", messageId: "read", userText: prompt,
        toolResults: [], source: "chat_stream", createdBy: null, requestContext: context })!;
      let calls = 0;
      let binding = prepared.bindingV2;
      const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
        callTool: async (_tool: unknown, _args: unknown, callContext: any) => {
          calls += 1;
          assert.equal(callContext.assignmentKernelV2.binding.assignment_id, prepared.assignmentId);
          throw new Error("MCP test boundary reached before native dispatch");
        } };
      const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: OPERATOR_BACKEND_CONTRACT_VERSION,
        session_id: "short-read", message_id: "read", user_text: prompt, context }, prepared));
      try {
        const request = { id: "context-read", method: "item/tool/call", params: { namespace: "revit_operator",
          turnId: "short-read-turn", tool: "revit_get_context", arguments: {} } } as any;
        const result = await handleCodexDynamicToolCall(runtime as any, request) as any;
        assert.equal(calls, 1, JSON.stringify(result));
        assert.match(JSON.stringify(result), /MCP test boundary reached/);
        assert.equal(getAssignmentKernelSnapshotV2(prepared.assignmentId)!.terminal, false);
        binding = undefined;
        const denied = await handleCodexDynamicToolCall(runtime as any, { ...request, id: "unbound-read" }) as any;
        assert.equal(calls, 1);
        assert.equal(denied.success, false);
      } finally { endTeammateLoopOwner(owner); }
    });
  } finally {
    for (const [index, key] of ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
    __testOnlyResetGoalListCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
