import type { CodexServerRequest } from "../codex/app_server.js";
import { CodexMcpToolRuntime } from "../codex/mcp_tool_runtime.js";
import { RevitToolParallelGuard } from "../codex/revit_tool_parallel_guard.js";
import { filterQuarantinedToolSearchResult, findActiveToolQuarantine } from "../codex/revit_tool_contract_memory.js";
import { findInterruptedAutoGoalForSession } from "../goals/auto_goal_runtime.js";
import {
  guardTeammateMcpCall,
  recordTeammateMcpResult,
  reconcileTeammateCanonicalSettlementV2,
  teammateLoopIsConversationForOwner,
  teammateLoopSessionIdForOwner
} from "../teammate_loop_runtime.js";
import { storeEvidence } from "../evidence/evidence_store.js";
import { assembleBoundedEvidenceContext, getEvidenceContextBudget } from "../evidence/model_context_budget.js";
import type { EvidenceProjectionV1, EvidenceRefV1 } from "../evidence/evidence_ref.js";
import { adaptMcpToolCallResultToDynamicResponse, attachDynamicObservationContext } from "./codex_dynamic_result_adapter.js";
import {
  assignmentEvidenceScope,
  assignmentToolEvidenceTrust,
  failAssignmentEvidenceRetention,
  failAssignmentToolAfterDispatch,
  failAssignmentToolBeforeDispatch,
  markAssignmentMcpRuntimeAccepted,
  markAssignmentToolDispatching,
  openAssignmentToolLease,
  quarantineLateAssignmentToolResult,
  recordAssignmentToolNativeResult,
  settleAssignmentToolEvidence,
  type AssignmentToolLease
} from "../assignments/async_tool_settlement.js";
import { recordAssignmentTurnProgress } from "../assignments/turn_settlement.js";
import { currentAssignmentJournalContext } from "../assignments/turn_journal.js";
import { bindCanonicalAssignmentToolArguments } from "../assignments/tool_argument_binding.js";
import { getAssignmentKernelSnapshotV2 } from "../assignments/assignment_kernel_v2_store.js";
import { codexAssignmentEvidenceContextV2 } from "./codex_assignment_evidence.js";
import {
  failAssignmentKernelOperationV2,
  markAssignmentKernelOperationDispatchStartedV2,
  openAssignmentKernelOperationV2,
  settleAssignmentKernelOperationV2
} from "../assignments/assignment_kernel_v2_execution.js";
import { settleAssignmentKernelProviderBudgetAtQuiescenceV2 } from "../assignments/assignment_kernel_v2_provider_budget.js";
import {
  advanceAssignmentKernelProgressV2,
  recordAssignmentProgressEpochV2
} from "../assignments/assignment_kernel_v2_progress.js";
import { deriveProgressGapsV2 } from "../domain/assignment-kernel/index.js";

const parallelGuard = new RevitToolParallelGuard();

function checkpointAssignmentKernelProgressV2(input: Readonly<{
  runtime: CodexMcpToolRuntime;
  turn_id: unknown;
  before: NonNullable<ReturnType<typeof getAssignmentKernelSnapshotV2>>;
  after: NonNullable<ReturnType<typeof getAssignmentKernelSnapshotV2>>;
  operation_id: string;
}>): void {
  const gapIds = deriveProgressGapsV2(input.before).map(gap => gap.gap_id);
  const epoch = recordAssignmentProgressEpochV2({
    before: input.before,
    after: input.after,
    stated_gap_ids: gapIds,
    admitted_operation_ids: [input.operation_id]
  });
  // Operation settlement is the causal boundary for criterion progression.
  // The active provider-turn terminal barrier keeps the final terminal event
  // open until its receipt is reconciled; delaying evaluation itself permits
  // another operation to overtake already-authoritative task evidence.
  const advanced = advanceAssignmentKernelProgressV2({ binding: epoch.current_binding });
  if (["terminal", "blocked", "paused", "request_user_input", "request_user_review"].includes(advanced.decision.decision)) {
    // The canonical decision is already durable, but interrupting the Codex
    // turn here races the item/tool/call response and can make a successful
    // native result appear as a failed dynamic tool item. Arm the stop now;
    // the Codex notification boundary flushes it after the completed tool
    // result has been observed and journaled.
    input.runtime.queueAssignmentKernelV2TurnStop(input.turn_id, advanced.decision.reason);
  }
}

export async function handleCodexDynamicToolCall(runtime: CodexMcpToolRuntime, request: CodexServerRequest): Promise<unknown> {
  const params = request.params ?? {};
  if ((params.namespace === "revit_operator" || params.namespace === "mcp__revit_operator") && params.tool === "operator_read_attachment") {
    try {
      const sessionId = teammateLoopSessionIdForOwner(runtime, params.turnId);
      if (!sessionId) throw new Error("Attachment reads require a current host-owned conversation turn.");
      const conversation = teammateLoopIsConversationForOwner(runtime, params.turnId);
      const binding = runtime.assignmentKernelV2Binding?.(params.turnId, sessionId);
      const snapshot = binding ? getAssignmentKernelSnapshotV2(binding.assignment_id) : null;
      if (!conversation) {
        const interrupted = findInterruptedAutoGoalForSession(sessionId);
        const journal = binding ? null : currentAssignmentJournalContext(sessionId);
        if (interrupted || snapshot?.execution_control?.state === "paused" || snapshot?.terminal
          || (!snapshot && (!journal || journal.projection.terminal_state !== "open"))) {
          throw new Error("The model task is not active; resume it before reading more task documents.");
        }
      } else if (binding) {
        throw new Error("An independent document question cannot use an earlier model-task binding.");
      }
      // Document inspection cannot satisfy model observation/change criteria.
      // The source receipt and page pixels are delivered directly to the active
      // provider, without opening or settling a native/model operation.
      return adaptMcpToolCallResultToDynamicResponse(await runtime.readAttachmentForTurn(params.arguments, { turnId: params.turnId, sessionId }));
    } catch (error) {
      return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false };
    }
  }
  // Standalone research owns the current provider turn, not an earlier model
  // assignment in this conversation. Only this read-only, policy-enforced tool
  // may execute without a model assignment; native tools still need one.
  if ((params.namespace === "revit_operator" || params.namespace === "mcp__revit_operator")
      && params.tool === "web_fetch_evidence" && teammateLoopIsConversationForOwner(runtime, params.turnId)) {
    const sessionId = teammateLoopSessionIdForOwner(runtime, params.turnId)!;
    if (!runtime.assignmentKernelV2Binding?.(params.turnId, sessionId)) {
      try {
        return adaptMcpToolCallResultToDynamicResponse(await runtime.callTool(params.tool, params.arguments ?? {}, { turnId: params.turnId, sessionId }));
      } catch (error) {
        return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false };
      }
    }
  }
  const interruptedAssignment = findInterruptedAutoGoalForSession(teammateLoopSessionIdForOwner(runtime, params.turnId));
  if (interruptedAssignment) {
    return {
      contentItems: [{
        type: "inputText",
        text: `[assignment_${interruptedAssignment.status}] Assignment ${interruptedAssignment.id} is ${interruptedAssignment.status}; no further tool dispatch is allowed until it is explicitly resumed.`
      }],
      success: false
    };
  }
  const namespace = typeof params.namespace === "string" ? params.namespace : "";
  if (namespace !== "revit_operator" && !namespace.startsWith("mcp__")) {
    return { contentItems: [{ type: "inputText", text: `Unsupported dynamic tool namespace: ${namespace || "(none)"}` }], success: false };
  }
  const server = namespace === "revit_operator" ? namespace : namespace.slice("mcp__".length);
  if (server !== "revit_operator") {
    return { contentItems: [{ type: "inputText", text: `Unsupported MCP server namespace: ${namespace}` }], success: false };
  }
  const quarantine = findActiveToolQuarantine(params.tool, params.arguments);
  if (quarantine) {
    const label = quarantine.method && quarantine.path ? `${quarantine.method} ${quarantine.path}` : quarantine.tool ?? "tool";
    return {
      contentItems: [{
        type: "inputText",
        text: `[revit_tool_quarantined] ${label} is retained but unavailable for autonomous execution: ${quarantine.reason}. Inspect current tool docs/evidence and use another primitive or clear the quarantine after a regression-tested repair.`
      }],
      success: false
    };
  }
  const sessionId = teammateLoopSessionIdForOwner(runtime, params.turnId)
    || `codex_dynamic_${String(params.turnId || "unbound").replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 160)}`;
  // Keep the V2 hook additive while legacy/runtime test doubles transition.
  // A runtime that does not expose the hook is necessarily on the V1 path.
  const v2Binding =
    typeof runtime.assignmentKernelV2Binding === "function"
      ? runtime.assignmentKernelV2Binding(params.turnId, sessionId)
      : null;
  const v2Snapshot = v2Binding ? getAssignmentKernelSnapshotV2(v2Binding.assignment_id) : null;
  if (v2Snapshot?.execution_control?.state === "paused") {
    runtime.queueAssignmentKernelV2TurnStop(params.turnId, "user_requested_pause");
    return { contentItems: [{ type: "inputText", text: "Task paused by the user. No new work was dispatched; retain completed work for resume." }], success: false };
  }
  const journalContext = v2Binding ? null : currentAssignmentJournalContext(sessionId);
  if (!v2Snapshot && !journalContext) {
    return {
      contentItems: [{ type: "inputText", text: "[assignment_settlement_blocked] No current canonical Assignment binding exists for this tool call." }],
      success: false
    };
  }
  if ((v2Snapshot?.terminal ?? false) || (journalContext && journalContext.projection.terminal_state !== "open")) {
    return {
      contentItems: [{
        type: "inputText",
        text: `[assignment_${v2Snapshot?.outcome ?? journalContext?.projection.terminal_state ?? "terminal"}] Canonical Assignment is already terminal; no further tool dispatch is allowed.`
      }],
      success: false
    };
  }
  const boundArguments = bindCanonicalAssignmentToolArguments(params.tool, params.arguments ?? {}, {
    session_id: sessionId,
    assignment_id: v2Binding?.assignment_id ?? journalContext!.assignmentId,
    run_id: v2Binding?.run_id ?? journalContext!.runId,
    generation: v2Binding?.generation ?? journalContext!.generation
  });
  const boundParams = { ...params, arguments: boundArguments.arguments };
  const boundRequest = { ...request, params: boundParams };
  // The connected runtime's advertised schema is checked before the mutation
  // guard and durable admission. Invalid input has no possible native effect;
  // errors received after dispatch still require authoritative reconciliation.
  try {
    await runtime.validateToolArguments?.(String(params.tool || ""), boundArguments.arguments);
  } catch (error) {
    return { contentItems: [{ type: "inputText", text: `[tool_request_invalid] ${
      (error instanceof Error ? error.message : String(error)).slice(0, 5_000)}` }], success: false };
  }
  const parallel = parallelGuard.tryAcquire(boundParams);
  if (!parallel.accepted) {
    return { contentItems: [{ type: "inputText", text: parallel.message ?? "Concurrent dependent Revit call blocked." }], success: false };
  }
  const teammateGate = guardTeammateMcpCall(runtime, boundParams);
  if (!teammateGate.allowed) {
    parallel.release();
    return { contentItems: [{ type: "inputText", text: teammateGate.message ?? "Host teammate-loop guard blocked this Revit call." }], success: false };
  }
  if (v2Snapshot && v2Binding) {
    if (teammateGate.call?.effect === "interaction" || teammateGate.call?.effect === "completion_claim") {
      try {
        const result = await runtime.callTool(params.tool, boundArguments.arguments, {
          turnId: params.turnId,
          sessionId,
          assignmentKernelV2Binding: v2Binding
        });
        recordTeammateMcpResult(runtime, teammateGate, result);
        const afterInteraction = getAssignmentKernelSnapshotV2(v2Binding.assignment_id);
        if (afterInteraction && (afterInteraction.terminal
          || afterInteraction.outcome === "awaiting_user_input"
          || afterInteraction.outcome === "awaiting_user_review")) {
          runtime.queueAssignmentKernelV2TurnStop(params.turnId, afterInteraction.terminal_reason ?? afterInteraction.outcome);
        }
        return adaptMcpToolCallResultToDynamicResponse(result, {
          tool: params.tool, arguments: boundArguments.arguments, projections: [], omitted: 0
        });
      } catch (error) {
        recordTeammateMcpResult(runtime, teammateGate, { isError: true });
        return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false };
      } finally {
        parallel.release();
      }
    }
    let lease: ReturnType<typeof openAssignmentKernelOperationV2>;
    try {
      lease = openAssignmentKernelOperationV2({
        snapshot: v2Snapshot,
        controller_request_id: request.id,
        provider_turn_id: typeof params.turnId === "string" ? params.turnId : "unbound-turn",
        capability_id: String(params.tool || "unknown-capability"),
        classified_effect: teammateGate.call?.effect ?? "unknown",
        target_tokens: teammateGate.call?.principal_target_tokens,
        arguments: boundArguments.arguments
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Admission is a deterministic controller decision, not an MCP/native
      // execution failure. Preserve the exact reason for the provider while
      // leaving the canonical gap and Operation graph unchanged.
      recordTeammateMcpResult(runtime, teammateGate, { isError: true, error: message });
      parallel.release();
      return {
        contentItems: [{
          type: "inputText",
          text: `[assignment_kernel_v2_operation_admission_blocked] ${message}`
        }],
        success: false
      };
    }
    let accepted = false;
    let rawResult: any;
    try {
      rawResult = await runtime.callTool(params.tool, boundArguments.arguments, {
        turnId: params.turnId,
        sessionId,
        assignmentKernelV2: lease,
        onMcpAccepted: () => {
          markAssignmentKernelOperationDispatchStartedV2(lease);
          accepted = true;
        }
      });
      const trustedVerification = recordTeammateMcpResult(runtime, teammateGate, rawResult);
      // The legacy loop may recognize the same readback again after the kernel
      // has already verified its apply. Only the admitted canonical verification
      // operation can carry that assertion; later discovery stays discovery.
      const settled = settleAssignmentKernelOperationV2(lease, rawResult, undefined,
        trustedVerification && lease.purpose === "verification" && lease.fulfillment_role === "verification"
          ? { ...trustedVerification, operation_id: lease.operation_id } : null);
      reconcileTeammateCanonicalSettlementV2(teammateGate, settled.snapshot.operations[lease.operation_id]);
      checkpointAssignmentKernelProgressV2({
        runtime,
        turn_id: params.turnId,
        before: v2Snapshot,
        after: settled.snapshot,
        operation_id: lease.operation_id
      });
      settleAssignmentKernelProviderBudgetAtQuiescenceV2(lease.binding);
      const result = params.tool === "revit_search_tools" ? filterQuarantinedToolSearchResult(rawResult) : rawResult;
      const context = assembleBoundedEvidenceContext({
        projections: [...settled.evidence_projections],
        session_id: sessionId,
        model_call_id: typeof params.turnId === "string" ? params.turnId : null,
        source: `assignment_kernel_v2_context:${params.tool}`,
        budget: getEvidenceContextBudget()
      });
      const response = adaptMcpToolCallResultToDynamicResponse(result, {
        tool: params.tool,
        arguments: boundArguments.arguments,
        projections: context.projections,
        omitted: context.omitted
      });
      const observationContext = codexAssignmentEvidenceContextV2(settled.snapshot, lease.operation_id);
      attachDynamicObservationContext(response, params.tool, observationContext);
      return response;
    } catch (error) {
      recordTeammateMcpResult(runtime, teammateGate, { isError: true, error: error instanceof Error ? error.message : String(error) });
      const currentOperation = getAssignmentKernelSnapshotV2(lease.assignment_id)?.operations[lease.operation_id];
      if (!currentOperation || !currentOperation.result) {
        try { failAssignmentKernelOperationV2(lease, error, accepted ? "dispatching" : "not_dispatched"); } catch {}
      }
      const failed = getAssignmentKernelSnapshotV2(lease.assignment_id);
      if (failed && failed.assignment_version > v2Snapshot.assignment_version) {
        try {
          checkpointAssignmentKernelProgressV2({
            runtime,
            turn_id: params.turnId,
            before: v2Snapshot,
            after: failed,
            operation_id: lease.operation_id
          });
        } catch {
          // The original operation failure remains authoritative even if the
          // bounded progression checkpoint itself rejects conflicting state.
        }
      }
      settleAssignmentKernelProviderBudgetAtQuiescenceV2(lease.binding);
      return {
        contentItems: [{ type: "inputText", text: `[assignment_kernel_v2_tool_failed] ${error instanceof Error ? error.message : String(error)}` },
          // Preserve bounded SDK validation/handler diagnostics even when a
          // canonical receipt is missing. Text never grants effect authority.
          ...(rawResult?.isError === true ? adaptMcpToolCallResultToDynamicResponse(rawResult).contentItems
            .filter(item => item.type === "inputText").slice(0, 4).map(item => ({ ...item, text: item.text.slice(0, 8_000) })) : [])],
        success: false
      };
    } finally {
      parallel.release();
    }
  }
  let assignmentLease: AssignmentToolLease;
  try {
    assignmentLease = openAssignmentToolLease({ session_id: sessionId, request: boundRequest, gate: teammateGate });
  } catch (error) {
    recordTeammateMcpResult(runtime, teammateGate, { isError: true, error: "canonical_attempt_open_failed" });
    parallel.release();
    return {
      contentItems: [{ type: "inputText", text: `[assignment_settlement_blocked] ${error instanceof Error ? error.message : String(error)}` }],
      success: false
    };
  }
  let rawResult: any;
  let dispatched = false;
  try {
    markAssignmentToolDispatching(assignmentLease);
    const pendingResult = runtime.callTool(params.tool, boundArguments.arguments, { turnId: params.turnId, sessionId });
    markAssignmentMcpRuntimeAccepted(assignmentLease);
    dispatched = true;
    rawResult = await pendingResult;
    recordTeammateMcpResult(runtime, teammateGate, rawResult);
    recordAssignmentToolNativeResult(assignmentLease, rawResult);
  } catch (error) {
    if (error instanceof Error && error.message === "assignment_tool_result_arrived_post_terminal") {
      quarantineLateAssignmentToolResult(assignmentLease, rawResult);
    } else {
      recordTeammateMcpResult(runtime, teammateGate, { isError: true });
      if (!dispatched) failAssignmentToolBeforeDispatch(assignmentLease, error);
      else failAssignmentToolAfterDispatch(assignmentLease, error);
    }
    parallel.release();
    return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false };
  }
  try {
    const result = params.tool === "revit_search_tools" ? filterQuarantinedToolSearchResult(rawResult) : rawResult;
    const imageEvidence = (Array.isArray(result?.content) ? result.content : []).flatMap((item: any, index: number) => {
      if (item?.type !== "image" || typeof item.data !== "string" || typeof item.mimeType !== "string") return [];
      return [storeEvidence({
        scope: assignmentEvidenceScope(assignmentLease),
        source: `codex_dynamic_visual:${params.tool}:${index}`,
        media_type: item.mimeType,
        trust_level: "host_observed",
        bounded_summary: `Visual evidence ${index + 1} from ${params.tool}.`,
        verification_relevance: "supporting",
        raw: Buffer.from(item.data, "base64")
      }, getEvidenceContextBudget().item_bytes)];
    });
    let imageIndex = 0;
    const durableResult = {
      ...result,
      ...(Array.isArray(result?.content) ? {
        content: result.content.map((item: any) => {
          if (item?.type !== "image" || typeof item.data !== "string") return item;
          const image = imageEvidence[imageIndex++];
          return { ...item, data: undefined, ...(image ? { evidence_id: image.ref.evidence_id, content_hash: image.ref.content_hash } : {}) };
        })
      } : {})
    };
    const stored = storeEvidence({
      scope: assignmentEvidenceScope(assignmentLease),
      source: `codex_dynamic_mcp:${params.tool}`,
      media_type: "application/json",
      trust_level: assignmentToolEvidenceTrust(assignmentLease),
      bounded_summary: `Dynamic MCP ${params.tool} result; complete output retained.`,
      verification_relevance: params.tool === "revit_call_tool" ? "required" : "supporting",
      relationships: imageEvidence.map((item: { ref: { evidence_id: string } }) => ({ evidence_id: item.ref.evidence_id, relation: "capture_for" as const })),
      raw: durableResult
    }, getEvidenceContextBudget().item_bytes);
    const context = assembleBoundedEvidenceContext({
      projections: [stored.projection, ...imageEvidence.map((item: { projection: EvidenceProjectionV1 }) => item.projection)],
      session_id: sessionId,
      model_call_id: typeof params.turnId === "string" ? params.turnId : null,
      source: `codex_dynamic_context:${params.tool}`,
      budget: getEvidenceContextBudget()
    });
    settleAssignmentToolEvidence(assignmentLease, [stored.ref, ...imageEvidence.map((item: { ref: EvidenceRefV1 }) => item.ref)]);
    const progress = recordAssignmentTurnProgress(sessionId, `${String(params.turnId || "turn")}:tool:${assignmentLease.attempt_id}`);
    if (progress && progress.terminal_state !== "open") {
      return {
        contentItems: [{
          type: "inputText",
          text: `[assignment_${progress.terminal_state}] Canonical Assignment terminated at a quiescent tool boundary: ${progress.terminal_reason || "bounded_no_progress"}.`
        }],
        success: false
      };
    }
    return adaptMcpToolCallResultToDynamicResponse(result, {
      tool: params.tool,
      arguments: boundArguments.arguments,
      projections: context.projections,
      omitted: context.omitted
    });
  } catch (error) {
    failAssignmentEvidenceRetention(assignmentLease, error);
    return {
      contentItems: [{ type: "inputText", text: `[evidence_retention_failed] ${error instanceof Error ? error.message : String(error)}` }],
      success: false
    };
  } finally {
    parallel.release();
  }
}
