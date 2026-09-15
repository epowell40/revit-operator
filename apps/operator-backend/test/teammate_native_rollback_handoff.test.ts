import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { handleCodexDynamicToolCall } from "../src/brains/codex_dynamic_tool_handler.js";
import { prepareAssignmentTurn, bindPreparedAssignmentToRequest } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA } from "../src/assignments/assignment_kernel_v2_execution.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner, teammateLoopReceiptForOwner, __testOnlyResetTeammateLoopState } from "../src/teammate_loop_runtime.js";

async function workspace(fn: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-rollback-handoff-"));
  const keys = ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"];
  const previous = keys.map(key => process.env[key]);
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  __testOnlyResetGoalListCache();
  __testOnlyResetTeammateLoopState();
  try { await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") }, fn); }
  finally {
    __testOnlyResetGoalListCache();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Retains the observed MEP workflow result shape: native Blocked/rolled_back,
// no MCP isError and no root success:false. Geometry is synthetic, not an oracle.
const route = "/revit/mep-route-workflow";
const requestBody = { kind: "duct", viewId: 44, levelId: 4,
  points: [{ xyz: [0, 0, 12] }, { xyz: [10, 0, 12] }], systemType: "Supply Air",
  ductTypeId: 101, ductShape: "rectangular", ductSize: "12x10", sizePolicy: "explicit_required",
  elevationPolicy: "explicit_required", routingMode: "polyline", connectSegments: false,
  connectToExisting: false, requireExistingEndpointConnections: false,
  verify: true, apply: true, visualVerify: true, visualViewId: 44, imageSize: 2200, focusPaddingFt: 6 };

for (const nativeState of ["rolled_back", "not_started"] as const)
test(`status-only blocked MEP result yields to retained ${nativeState} before corrected dynamic dispatch`, () => workspace(async () => {
  const prompt = "Apply the attached 12x10 supply-duct redline. Use the existing rectangular supply-duct type and leave the ends open.";
  const prepared = prepareAssignmentTurn({ sessionId: "rollback-session", messageId: "redline", userText: prompt,
    toolResults: [], source: "chat", createdBy: null,
    requestContext: { revit: { document: { projectIdentity: { fingerprint: "rollback-model" } } } } })!;
  const binding = prepared.bindingV2!;
  let dispatches = 0;
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {},
    callTool: async (_tool: string, _args: any, context: any) => {
      context.onMcpAccepted();
      const lease = context.assignmentKernelV2;
      const failed = ++dispatches === 1;
      const payload = failed
        ? { status: "Blocked", dryRun: { status: "Blocked", message: "Selected duct type created round; rectangular is required.",
            transaction: { status: nativeState, committed: false }, createdElementIds: [], modifiedElementIds: [], deletedElementIds: [] } }
        : { status: "Success", createdElementIds: [1001], transaction: { status: "committed", committed: true } };
      const receipt = "receipt:" + lease.operation_id;
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: {
        schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: "result:" + lease.operation_id,
          operation_id: lease.operation_id, binding, status: failed ? "failed_after_dispatch" : "succeeded", dispatch_state: "dispatched",
          persistent_effect: failed ? "none" : "applied", native_transaction_state: failed ? nativeState : "committed", authority: "native-host",
          result_schema_id: `operator-native/POST:${route}/v2`, observation_required: true, receipt_id: receipt, native_correlation_id: receipt,
          raw_payload_hash: payloadDigestV2(payload).digest, request_identity: lease.request_identity, completed_at: new Date().toISOString() },
        observation: { raw_payload: payload, semantic_facts: [], verification_relevance: ["task_result"], evidence_class: "task_result" }
      } };
    }
  };
  const owner = beginTeammateLoopOwner(runtime, bindPreparedAssignmentToRequest({ version: "operator.backend.v1",
    session_id: binding.session_id, user_text: prompt,
    context: { revit: { process_id: 4242, source: { live: true }, activeView: { id: 44, name: "L4" },
      document: { title: "Mechanical model", projectIdentity: { fingerprint: "rollback-model" } } } }
  } as any, prepared));
  try {
    const run = (ductTypeId: number, id: string) => handleCodexDynamicToolCall(runtime as any, { id, method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "redline-turn", tool: "revit_call_tool", arguments: { method: "POST", path: route,
        body: { ...requestBody, ductTypeId } }
    } } as any);
    const firstResponse = await run(101, "round-type");
    const rollback = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    const first = Object.values(rollback.operations).find(operation => operation.requested_effect === "apply")!;
    assert.ok(first, JSON.stringify(firstResponse));
    assert.equal(first.result?.native_transaction_state, nativeState);
    assert.equal(first.persistent_effect, "none");
    assert.equal(rollback.unresolved_unknown_operation_ids.length, 0);
    assert.equal(teammateLoopReceiptForOwner(runtime)!.verified, false);
    const corrected = await run(102, "rectangular-type");
    assert.equal(dispatches, 2, JSON.stringify(corrected));
    const after = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    const operations = Object.values(after.operations).filter(operation => operation.requested_effect === "apply");
    assert.equal(operations.length, 2);
    assert.equal(operations[1]!.persistent_effect, "applied");
    assert.equal(teammateLoopReceiptForOwner(runtime)!.apply_attempts, 2);
    assert.equal(teammateLoopReceiptForOwner(runtime)!.verified, false);
    const unverified = await run(103, "another-type");
    assert.equal(dispatches, 2, JSON.stringify(unverified));
    assert.match(JSON.stringify(unverified), /prior apply verification required/);
  } finally { endTeammateLoopOwner(owner); }
}));
