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

test("C35 answered airflow invalidates the old workbook through the authenticated lifecycle and survives restart", () => workspace(async () => {
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
    requestAssignmentInputV2({ binding, clarification_id: "space-307", variable_ids: ["space_307_flow"], new_variable_ids: ["space_307_flow"], question: "Supply and return for Space 307?" } as any);
    const final = evaluateAssignmentObservationCriteriaV2({ binding, claims: [{ criterion_id: snapshot.spec.criteria[0]!.criterion_id,
      observation_ids: [artifact.observation_id] }], result_items: selected, assessment });
    assert.equal(final.outcome,"awaiting_user_input");
    assert.ok(final.result_delivery);
    const answered=supplyAssignmentInputResultV2({binding,clarification_id:"space-307",external_values:{space_307_flow:"450 supply, 450 return, 0 exhaust"}}).snapshot;
    assert.equal(answered.result_delivery,undefined);
    assert.equal(answered.terminal,false);
    assert.ok(answered.input_invalidated_operation_ids?.includes(artifact.operation_id));
    assert.throws(()=>buildAssignmentResultDeliveryV2(answered,selected,assessment),/ineligible/);
    const progress=prepareCodexAssignmentProgressV2(binding);
    assert.ok(progress.prompt.includes("450 supply"));
    assert.equal(progress.snapshot.terminal,false);
    assert.deepEqual(progress.snapshot.spec,snapshot.spec);
    const replay=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",
      "import {getAssignmentKernelSnapshotV2} from './src/assignments/assignment_kernel_v2_store.ts'; process.stdout.write(JSON.stringify(getAssignmentKernelSnapshotV2("+JSON.stringify(binding.assignment_id)+")));"],{cwd:process.cwd(),env:process.env,encoding:"utf8"});
    assert.equal(replay.status,0,replay.stderr);
    const recovered=JSON.parse(replay.stdout);
    assert.equal(recovered.terminal,false);
    assert.equal(recovered.result_delivery,undefined);
    assert.deepEqual(recovered.input_invalidated_operation_ids,answered.input_invalidated_operation_ids);
    assert.equal(Object.values(recovered.operations).filter((op:any)=>op.persistent_effect==="applied").length,1);
  } finally {endTeammateLoopOwner(owner);}
}));
