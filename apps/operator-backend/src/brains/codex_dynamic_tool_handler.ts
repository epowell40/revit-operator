import type { CodexServerRequest } from "../codex/app_server.js";
import { CodexMcpToolRuntime } from "../codex/mcp_tool_runtime.js";
import { RevitToolParallelGuard } from "../codex/revit_tool_parallel_guard.js";
import { filterQuarantinedToolSearchResult, findActiveToolQuarantine } from "../codex/revit_tool_contract_memory.js";
import { findInterruptedAutoGoalForSession } from "../goals/auto_goal_runtime.js";
import {
  guardTeammateMcpCall,
  recordTeammateMcpResult,
  teammateLoopSessionIdForOwner
} from "../teammate_loop_runtime.js";
import { storeEvidence } from "../evidence/evidence_store.js";
import { assembleBoundedEvidenceContext, getEvidenceContextBudget } from "../evidence/model_context_budget.js";
import type { EvidenceProjectionV1, EvidenceRefV1 } from "../evidence/evidence_ref.js";
import { adaptMcpToolCallResultToDynamicResponse } from "./codex_dynamic_result_adapter.js";
import {
  assignmentEvidenceScope,
  assignmentToolEvidenceTrust,
  failAssignmentEvidenceRetention,
  failAssignmentToolAfterDispatch,
  failAssignmentToolBeforeDispatch,
  markAssignmentToolDispatched,
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

const parallelGuard = new RevitToolParallelGuard();

export async function handleCodexDynamicToolCall(runtime: CodexMcpToolRuntime, request: CodexServerRequest): Promise<unknown> {
  const params = request.params ?? {};
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
  const journalContext = currentAssignmentJournalContext(sessionId);
  if (!journalContext) {
    return {
      contentItems: [{ type: "inputText", text: "[assignment_settlement_blocked] No current canonical Assignment binding exists for this tool call." }],
      success: false
    };
  }
  if (journalContext.projection.terminal_state !== "open") {
    return {
      contentItems: [{
        type: "inputText",
        text: `[assignment_${journalContext.projection.terminal_state}] Canonical Assignment is already terminal; no further tool dispatch is allowed.`
      }],
      success: false
    };
  }
  const boundArguments = bindCanonicalAssignmentToolArguments(params.tool, params.arguments ?? {}, {
    session_id: sessionId,
    assignment_id: journalContext.assignmentId,
    run_id: journalContext.runId,
    generation: journalContext.generation
  });
  const boundParams = { ...params, arguments: boundArguments.arguments };
  const boundRequest = { ...request, params: boundParams };
  const parallel = parallelGuard.tryAcquire(boundParams);
  if (!parallel.accepted) {
    return { contentItems: [{ type: "inputText", text: parallel.message ?? "Concurrent dependent Revit call blocked." }], success: false };
  }
  const teammateGate = guardTeammateMcpCall(runtime, boundParams);
  if (!teammateGate.allowed) {
    parallel.release();
    return { contentItems: [{ type: "inputText", text: teammateGate.message ?? "Host teammate-loop guard blocked this Revit call." }], success: false };
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
    markAssignmentToolDispatched(assignmentLease);
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
