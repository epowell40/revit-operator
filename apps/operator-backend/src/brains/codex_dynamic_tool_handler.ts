import { committedDrawingSpecImportReadbackPlanV2 } from "../verification/drawing_spec_import_v2.js";
import {committedExcelTableImportReadbackPlanV2} from '../verification/excel_table_import_v2.js';
import {committedDeletedElementsReadbackPlansV2}from '../verification/deleted_elements_postcondition_v2.js';
import { committedCheckNeedsRefreshV2 } from '../verification/regular_schedule_recheck_v2.js';
import { checkedEditIsCurrentV2 } from '../verification/current_postcondition_v2.js';
import { committedRegularSchedulePresentationReadbackPlanV2 } from "../verification/regular_schedule_presentation_v2.js";
import { committedProjectParameterBindingReadbackPlanV2 } from "../verification/project_parameter_binding_v2.js";
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
  teammateDesktopHelperScopeForOwner,
  teammateDesktopHelperCallLeaseForOwner,
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
import { recoverRetainedAssignmentCompletionsV2 } from "../assignments/assignment_kernel_v2_completion_recovery.js";
import { codexAssignmentEvidenceContextV2 } from "./codex_assignment_evidence.js";
import { nativeChildProjectionReferencesV2 } from "../assignments/assignment_kernel_v2_child_projection.js";
import {
  commitAssignmentKernelObservationV2,
  failAssignmentKernelOperationV2,
  leaseFromOperation,
  markAssignmentKernelOperationDispatchStartedV2,
  openAssignmentKernelOperationV2,
  settleAssignmentKernelOperationV2
} from "../assignments/assignment_kernel_v2_execution.js";
import { settleAssignmentKernelProviderBudgetAtQuiescenceV2 } from "../assignments/assignment_kernel_v2_provider_budget.js";
import {
  DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,
  advanceAssignmentKernelProgressV2,
  recordAssignmentProgressEpochV2
} from "../assignments/assignment_kernel_v2_progress.js";
import { assignmentWorkBudgetStatusV2,defaultAssignmentWorkBudgetV2 } from "../assignments/assignment_work_allowance_v2.js";
import { deriveProgressGapsV2,decideAssignmentProgressV2,assignmentNativeReadbackResourceBlockerV2 } from "../domain/assignment-kernel/index.js";
import { reconcileCanonicalToolVerification } from "../teammate_verification_state.js";
import { expandExactRegisteredStageToolArguments } from "../existing_conditions/registered_stage_handoff_http.js";
import { committedTagReadbackPlanV2 } from "../verification/committed_tag_readback_plan_v2.js";
import { committedVisibilityReadbackPlanV2 } from "../verification/committed_visibility_readback_plan_v2.js";
import { committedParameterReadbackPlanV2, committedTypedParameterReadbackPlanV2 } from "../verification/committed_parameter_readback_plan_v2.js";
import { committedCircuitReadbackPlanV2, committedTypedCircuitReadbackPlanV2 } from "../verification/circuit_membership_postcondition_v2.js";
import { committedElementTypeReadbackPlanV2 } from "../verification/element_type_postcondition_v2.js";
import { committedDuplicatedTypeReadbackPlanV2 } from "../verification/duplicated_type_postcondition_v2.js";
import { committedCreatedTagReadbackPlanV2 } from "../verification/created_tag_postcondition_v2.js";
import { committedSheetMoveReadbackPlansV2 } from "../verification/sheet_move_postcondition_v2.js";
import { committedNativeAnnotationReadbackPlanV2 } from "../verification/native_annotation_postcondition_v2.js";
import { committedModelPointMoveReadbackPlanV2 } from "../verification/model_point_move_postcondition_v2.js";
import { committedScheduleReadbackPlanV2 } from "../verification/committed_schedule_readback_plan_v2.js";
import { committedCreatedScheduleReadbackPlanV2 } from "../verification/created_schedule_postcondition_v2.js";
import { committedScheduleCellBackgroundReadbackPlanV2 } from "../verification/schedule_cell_appearance_v2.js";
import { committedNativeSchedulePresentationReadbackPlanV2, committedNativeSchedulePresentationReadbackPlansV2 } from "../verification/native_schedule_presentation_v2.js";
import { committedSavedDocumentReadbackPlanV2 } from '../verification/committed_saved_document_readback_plan_v2.js';
import { codexRequestedScopeReadbackV1 } from './codex_requested_scope_readback.js';
import { committedReadRetryDecisionV2 } from '../verification/safe_committed_read_retry_v2.js';
import { validFamilyStaticTextScopeV1 } from '../domain/assignment-kernel/work_plan_family_scope.js';
import {DESKTOP_HELPER_RETURN_REASON,peekDesktopHelperReturnV1,retainDesktopHelperReturnV1,desktopHelperReturnMessageV1,isDesktopHelperReturnRequestV1} from './desktop_helper_return.js';
import {desktopHelperLeaseDecisionV1,desktopHelperBudgetReportV1} from './desktop_helper_budget.js';
import {reserveCommittedReadbacksV2,consumeCommittedReadbackV2,retireCommittedReadbacksV2,isCommittedReadbackReservationV2} from './committed_readback_reservations_v2.js';
import {evaluatePendingAssignmentCriteriaV2} from '../assignments/assignment_kernel_v2_progress.js';

const parallelGuard = new RevitToolParallelGuard();
// Only in-process deterministic checking receives this token. Request IDs,
// JSON fields and model prose cannot bypass the local helper allowance.
const HOST_READBACK=Symbol('host-readback');

function attachCurrentAssignmentContext(response: ReturnType<typeof adaptMcpToolCallResultToDynamicResponse>,
  tool: unknown, assignmentId: string, operationId?: string): void {
  const snapshot = getAssignmentKernelSnapshotV2(assignmentId);
  if (!snapshot) return;
  attachDynamicObservationContext(response, tool, codexAssignmentEvidenceContextV2(snapshot, operationId,
    assignmentWorkBudgetStatusV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, new Date().toISOString())));
}

function checkpointAssignmentKernelProgressV2(input: Readonly<{
  runtime: CodexMcpToolRuntime;
  turn_id: unknown;
  before: NonNullable<ReturnType<typeof getAssignmentKernelSnapshotV2>>;
  after: NonNullable<ReturnType<typeof getAssignmentKernelSnapshotV2>>;
  operation_id: string;
  progress_already_recorded?:boolean;
}>): void {
  const gapIds = deriveProgressGapsV2(input.before).map(gap => gap.gap_id);
  const epoch = input.progress_already_recorded?input.after:recordAssignmentProgressEpochV2({
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

export async function handleCodexDynamicToolCall(runtime: CodexMcpToolRuntime, request: CodexServerRequest,hostBoundary?:unknown): Promise<unknown> {
  const params = request.params ?? {};
  if ((params.namespace === "revit_operator" || params.namespace === "mcp__revit_operator") && ["operator_read_attachment", "operator_read_output_pdf"].includes(params.tool)) {
    try {
      const sessionId = teammateLoopSessionIdForOwner(runtime, params.turnId);
      if (!sessionId) throw new Error("Attachment reads require a current host-owned conversation turn.");
      const conversation = teammateLoopIsConversationForOwner(runtime, params.turnId);
      const binding = runtime.assignmentKernelV2Binding?.(params.turnId, sessionId);
      const snapshot = binding ? getAssignmentKernelSnapshotV2(binding.assignment_id) : null;
      if (!conversation) {
        const interrupted = findInterruptedAutoGoalForSession(sessionId);
        const journal = binding ? null : currentAssignmentJournalContext(sessionId);
        if (interrupted || snapshot?.completion_proposal || snapshot?.execution_control?.state === "paused" || snapshot?.terminal
          || (!snapshot && (!journal || journal.projection.terminal_state !== "open"))) {
          throw new Error("The model task is not active; resume it before reading more task documents.");
        }
      } else if (binding) {
        throw new Error("An independent document question cannot use an earlier model-task binding.");
      }
      // Document inspection cannot satisfy model observation/change criteria.
      // The source receipt and page pixels are delivered directly to the active
      // provider, without opening or settling a native/model operation.
      const result = params.tool === "operator_read_output_pdf"
        ? await runtime.readOutputPdfForTurn(params.arguments, { turnId: params.turnId, sessionId })
        : await runtime.readAttachmentForTurn(params.arguments, { turnId: params.turnId, sessionId });
      const response = adaptMcpToolCallResultToDynamicResponse(result);
      if (snapshot) attachCurrentAssignmentContext(response, params.tool, snapshot.current_binding.assignment_id);
      return response;
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
  if (v2Snapshot?.completion_proposal) {
    runtime.queueAssignmentKernelV2TurnStop(params.turnId, "advisory_completion_proposed");
    return { contentItems: [{ type: "inputText", text: "Unverified checkpoint retained for independent review; no further tool work was dispatched." }], success: false };
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
  if(peekDesktopHelperReturnV1(runtime,params.turnId)){
    runtime.queueAssignmentKernelV2TurnStop(params.turnId,DESKTOP_HELPER_RETURN_REASON);
    return {contentItems:[{type:'inputText',text:'Scoped helper return is retained; no further helper tool was dispatched. The desktop owner must consume the report after provider drain.'}],success:false};
  }
  const boundArguments = bindCanonicalAssignmentToolArguments(params.tool, params.arguments ?? {}, {
    session_id: sessionId,
    assignment_id: v2Binding?.assignment_id ?? journalContext!.assignmentId,
    run_id: v2Binding?.run_id ?? journalContext!.runId,
    generation: v2Binding?.generation ?? journalContext!.generation
  });
  try {
    if (params.tool === "revit_call_tool") {
      boundArguments.arguments = expandExactRegisteredStageToolArguments(boundArguments.arguments, {
        session_id: sessionId,
        assignment_id: v2Binding?.assignment_id ?? journalContext!.assignmentId,
        run_id: v2Binding?.run_id ?? journalContext!.runId,
        generation: v2Binding?.generation ?? journalContext!.generation
      });
    }
  } catch (error) {
    return { contentItems: [{ type: "inputText", text: `[tool_request_invalid] ${
      (error instanceof Error ? error.message : String(error)).slice(0, 5_000)}` }], success: false };
  }
  const boundParams = { ...params, arguments: boundArguments.arguments };
  const boundRequest = { ...request, params: boundParams };
  if(v2Snapshot&&v2Binding&&hostBoundary!==HOST_READBACK&&!isCommittedReadbackReservationV2(hostBoundary)&&!isDesktopHelperReturnRequestV1(String(params.tool),boundArguments.arguments)){
    const marker=teammateDesktopHelperScopeForOwner(runtime,params.turnId),lease=teammateDesktopHelperCallLeaseForOwner(runtime,params.turnId);
    const decision=desktopHelperLeaseDecisionV1(lease,v2Snapshot,marker);
    if(decision?.decision==='warn'&&lease){
      lease.warning_issued=true;lease.warned_grant=decision.granted_calls;
      return {success:false,contentItems:[{type:'inputText',text:'The scoped helper is near its share of the existing task call allowance. This tool was not dispatched. Return a bounded subtask report now using propose_completion: actual findings and evidence references, remaining work and uncertainties. Keep subtask findings distinct from the parent checklist; this report cannot complete the parent task. The desktop owner needs the remaining allowance for inspection, correction, saving and final delivery; no extra allowance or write authority was granted.'}]};
    }
    if(decision?.decision==='yield'&&lease){
      const returned=retainDesktopHelperReturnV1({owner:runtime,turn_id:params.turnId,binding:v2Snapshot.current_binding,
        marker,tool:'host_desktop_helper_call_yield',arguments:{report:desktopHelperBudgetReportV1(v2Snapshot,lease)}});
      if(returned){runtime.queueAssignmentKernelV2TurnStop(params.turnId,DESKTOP_HELPER_RETURN_REASON);
        const response={success:true,contentItems:[{type:'inputText' as const,text:desktopHelperReturnMessageV1(returned)}]};
        attachCurrentAssignmentContext(response,params.tool,v2Binding.assignment_id);return response;}
      return {success:false,contentItems:[{type:'inputText',text:'Scoped helper handback could not be retained under current parent controls. No tool was dispatched. Re-establish current task state; do not repeat any uncertain edit.'}]};
    }
  }
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
  const teammateGate = guardTeammateMcpCall(runtime, boundParams, v2Snapshot);
  if (!teammateGate.allowed) {
    parallel.release();
    return { contentItems: [{ type: "inputText", text: teammateGate.message ?? "Host teammate-loop guard blocked this Revit call." }], success: false };
  }
  if (v2Snapshot && v2Binding) {
    if (teammateGate.call?.effect === "interaction" || teammateGate.call?.effect === "completion_claim") {
      try {
        // The helper's local instruction is not the entire authenticated user
        // request. Do not let its inspection handoff place the desktop owner
        // behind a whole-task review fence. No existing fence is cleared.
        const helperReturn=retainDesktopHelperReturnV1({owner:runtime,turn_id:params.turnId,binding:v2Snapshot.current_binding,
          marker:teammateDesktopHelperScopeForOwner(runtime,params.turnId),tool:String(params.tool),arguments:boundArguments.arguments});
        if(helperReturn){
          const text=desktopHelperReturnMessageV1(helperReturn);
          recordTeammateMcpResult(runtime,teammateGate,{content:[{type:'text',text}]});
          // Existing post-tool flush delivers the response before interrupting
          // this helper provider. Nothing changes the parent lifecycle state.
          runtime.queueAssignmentKernelV2TurnStop(params.turnId,DESKTOP_HELPER_RETURN_REASON);
          const response={contentItems:[{type:'inputText' as const,text}],success:true};
          attachCurrentAssignmentContext(response,params.tool,v2Binding.assignment_id);return response;
        }
        let result = await runtime.callTool(params.tool, boundArguments.arguments, {
          turnId: params.turnId,
          sessionId,
          assignmentKernelV2Binding: v2Binding
        });
        let hostScopeNotice:string|undefined;
        // The actor requested a supported coverage check. Gather missing native
        // evidence through ordinary guarded calls, not through a longer prompt.
        if(params.tool==='operator_manage_work_plan'&&boundArguments.arguments.action==='check_scope'
          &&validFamilyStaticTextScopeV1(boundArguments.arguments.scopeCheck)
          &&boundArguments.arguments.operationIds===undefined&&!result?.isError){
          parallel.release();
          try {
            const host=await codexRequestedScopeReadbackV1({runtime,request:boundRequest,binding:v2Binding,
              session_id:sessionId,arguments:boundArguments.arguments,dispatch:r=>handleCodexDynamicToolCall(runtime,r,HOST_READBACK)});
            if(host){result=host.result;hostScopeNotice=host.notice;}
          }catch(error){hostScopeNotice='Host native scope readback remains unavailable: '+String(error).slice(0,800);}
        }
        recordTeammateMcpResult(runtime, teammateGate, result);
        const afterInteraction = getAssignmentKernelSnapshotV2(v2Binding.assignment_id);
        if (afterInteraction && (afterInteraction.completion_proposal || afterInteraction.terminal
          || afterInteraction.outcome === "awaiting_user_input"
          || afterInteraction.outcome === "awaiting_user_review")) {
          runtime.queueAssignmentKernelV2TurnStop(params.turnId, afterInteraction.completion_proposal ? "advisory_completion_proposed" : afterInteraction.terminal_reason ?? afterInteraction.outcome);
        }
        const response = adaptMcpToolCallResultToDynamicResponse(result, {
          tool: params.tool, arguments: boundArguments.arguments, projections: [], omitted: 0
        });
        if(hostScopeNotice)response.contentItems.push({type:'inputText',text:hostScopeNotice});
        attachCurrentAssignmentContext(response, params.tool, v2Binding.assignment_id);
        return response;
      } catch (error) {
        recordTeammateMcpResult(runtime, teammateGate, { isError: true });
        return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false };
      } finally {
        parallel.release();
      }
    }
    let lease: ReturnType<typeof openAssignmentKernelOperationV2>;
    try {
      if(hostBoundary===HOST_READBACK){
        const fresh=getAssignmentKernelSnapshotV2(v2Binding.assignment_id);
        const exhausted=fresh?assignmentNativeReadbackResourceBlockerV2(fresh,defaultAssignmentWorkBudgetV2(fresh,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2),new Date().toISOString(),1):'assignment_missing';
        if(exhausted)throw Error(exhausted);
      }
      lease = consumeCommittedReadbackV2(hostBoundary,runtime,boundRequest,boundArguments.arguments)??openAssignmentKernelOperationV2({
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
      recordTeammateMcpResult(runtime, teammateGate, rawResult);
      // V2 derives postcondition truth from retained native evidence itself.
      // A legacy target-match assertion can precede a complete multi-read check;
      // forwarding it would reject and discard useful partial observations.
      const settled = settleAssignmentKernelOperationV2(lease, rawResult);
      if (!teammateGate.state?.canonical_supervision_only) {
        reconcileCanonicalToolVerification(teammateGate.state, settled.snapshot, lease.operation_id);
        reconcileTeammateCanonicalSettlementV2(teammateGate, settled.snapshot.operations[lease.operation_id]);
      }
      const epoch=recordAssignmentProgressEpochV2({
        before:v2Snapshot,after:settled.snapshot,stated_gap_ids:deriveProgressGapsV2(v2Snapshot).map(g=>g.gap_id),admitted_operation_ids:[lease.operation_id]
      });
      // Evaluate authoritative evidence at its causal settlement boundary.
      // Reserve finite real native checks before the general budget checkpoint;
      // their in-flight operations keep the task open without another paid call.
      if(decideAssignmentProgressV2({snapshot:epoch,budget:defaultAssignmentWorkBudgetV2(epoch,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2),now:new Date().toISOString()}).decision==='evaluate_criteria')
        evaluatePendingAssignmentCriteriaV2({binding:epoch.current_binding});
      // The user need not prescribe a verification recipe. After a reviewed
      // existing-tag commit, perform one bounded separate read through this
      // same handler's schema, owner, pause, admission and MCP settlement gates.
      // A refused/failed read leaves the successful edit and open check intact.
      const current = getAssignmentKernelSnapshotV2(lease.assignment_id);
      const typedRead = current?.operations[lease.operation_id]
        ? committedTypedParameterReadbackPlanV2(current,current.operations[lease.operation_id]!,rawResult)
          ?? committedTypedCircuitReadbackPlanV2(current,current.operations[lease.operation_id]!,rawResult) : null;
      const readPlan = typedRead?.plan ?? (current?.operations[lease.operation_id]
        ? committedTagReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedVisibilityReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedScheduleCellBackgroundReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedRegularSchedulePresentationReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedDrawingSpecImportReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedExcelTableImportReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedProjectParameterBindingReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedNativeSchedulePresentationReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedScheduleReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedCreatedScheduleReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedSavedDocumentReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedParameterReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedElementTypeReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedDuplicatedTypeReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedCreatedTagReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedNativeAnnotationReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedModelPointMoveReadbackPlanV2(current, current.operations[lease.operation_id]!)
          ?? committedCircuitReadbackPlanV2(current, current.operations[lease.operation_id]!) : null);
      let hostReadResponse: ReturnType<typeof adaptMcpToolCallResultToDynamicResponse> | null = null;
      const readPlans=readPlan?[readPlan]:(current?.operations[lease.operation_id]
        ? committedDeletedElementsReadbackPlansV2(current,current.operations[lease.operation_id]!)
          ?? committedNativeSchedulePresentationReadbackPlansV2(current,current.operations[lease.operation_id]!)
          ?? committedSheetMoveReadbackPlansV2(current,current.operations[lease.operation_id]!)??[]:[]);
      const batch=current&&readPlans.length?await reserveCommittedReadbacksV2({runtime,parent:boundRequest,snapshot:current,subjectId:typedRead?.operation_id??lease.operation_id,plans:readPlans}):{entries:[]};
      checkpointAssignmentKernelProgressV2({runtime,turn_id:params.turnId,before:v2Snapshot,after:epoch,operation_id:lease.operation_id,progress_already_recorded:true});
      if(readPlans.length&&!batch.entries.length)hostReadResponse={success:false,contentItems:[{type:'inputText',text:`Automatic readback remains unverified (${batch.reason??'not admitted'}). Retain the committed change; do not repeat it.`}]};
      if (batch.entries.length) {
        // Native dispatch has returned and canonical settlement is retained.
        // Release only this completed route's lease before the separate read
        // reacquires the ordinary guard. Otherwise same-route reads (visibility
        // and schedule settings) are mistaken for concurrent duplicate calls.
        // The new call still validates ownership, pause, admission and freshness.
        parallel.release();
        try{for(const [index,entry] of batch.entries.entries())try {
          const plan=readPlans[index]!;
          const applyOperationId=typedRead?.operation_id ?? lease.operation_id;
          const beforeRead=getAssignmentKernelSnapshotV2(lease.assignment_id);
          let response = await handleCodexDynamicToolCall(runtime,entry.request,entry.token) as ReturnType<typeof adaptMcpToolCallResultToDynamicResponse>;
          if(hostReadResponse)hostReadResponse.contentItems.push(...response.contentItems);else hostReadResponse=response;
          const retryDecision=committedReadRetryDecisionV2({planning:current,beforeRead,afterRead:getAssignmentKernelSnapshotV2(lease.assignment_id),
            applyOperationId,plan,response,retryAttempt:0,reservedReadOperationId:entry.operation_id});
          if(!response.success&&!retryDecision.retry)hostReadResponse.contentItems.push({type:'inputText',text:`Automatic readback remains unverified (${retryDecision.reason}). Obtain fresh authorized evidence; do not repeat the committed change.`});
          if(retryDecision.retry){
            const retrySnapshot=getAssignmentKernelSnapshotV2(lease.assignment_id);
            const exhausted=retrySnapshot?assignmentNativeReadbackResourceBlockerV2(retrySnapshot,defaultAssignmentWorkBudgetV2(retrySnapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2),new Date().toISOString(),1):'assignment_missing';
            if(exhausted){hostReadResponse.contentItems.push({type:'inputText',text:`The separate read retry was not admitted (${exhausted}); the committed change remains retained and unverified.`});break;}
            await new Promise(resolve=>setTimeout(resolve,200));
            response=await handleCodexDynamicToolCall(runtime,{
              id:`host-committed-readback:${applyOperationId}:${index}:retry:1`,method:'item/tool/call',
              params:{namespace:'revit_operator',tool:'revit_call_tool',turnId:params.turnId,threadId:params.threadId,arguments:plan}
            },HOST_READBACK) as ReturnType<typeof adaptMcpToolCallResultToDynamicResponse>;
            hostReadResponse.contentItems.push({type:'inputText',text:'Host attempted one separate read after a confirmed pre-dispatch authorization-service availability failure. The original failed read remains retained; the new read must independently establish its postcondition.'},...response.contentItems);
          }
          if(!response.success)break;
        } catch (error) {
          const failure = { success:false, contentItems:[{type:"inputText" as const,text:
            `Host readback remains unverified: ${String(error).slice(0,1000)}`}] };
          if(hostReadResponse)hostReadResponse.contentItems.push(...failure.contentItems);else hostReadResponse=failure;
          break;
        }
        }finally{retireCommittedReadbacksV2(batch.entries);
          const afterReads=getAssignmentKernelSnapshotV2(lease.assignment_id);
          if(afterReads&&!afterReads.terminal)checkpointAssignmentKernelProgressV2({runtime,turn_id:params.turnId,before:v2Snapshot,after:afterReads,operation_id:lease.operation_id,progress_already_recorded:true});
        }
      }
      // A later edit can invalidate earlier checks. Refresh only previously
      // successful recognized checks, with real reads through ordinary gates.
      // Bound fan-out and stop at the first refusal/mismatch. Never replay an
      // apply, reinterpret a failed check, or manufacture a final proof fact.
      if(current?.operations[lease.operation_id]?.requested_effect==='apply') {
        parallel.release();
        for(let n=0;n<16;n++) {
          const before=getAssignmentKernelSnapshotV2(lease.assignment_id);if(!before)break;
          const candidate=Object.values(before.operations)
            .filter(op=>committedCheckNeedsRefreshV2(before,op))
            .sort((a,b)=>`${b.settled_at??b.opened_at}:${b.operation_id}`.localeCompare(`${a.settled_at??a.opened_at}:${a.operation_id}`))
            .map(op=>({op,plan:committedRegularSchedulePresentationReadbackPlanV2(before,op)
              ??committedVisibilityReadbackPlanV2(before,op)})).find(v=>v.plan);
          if(!candidate)break;
          try {
            const response=await handleCodexDynamicToolCall(runtime,{
              id:`host-final-committed-readback:${lease.operation_id}:${candidate.op.operation_id}:${n}`,method:'item/tool/call',
              params:{namespace:'revit_operator',tool:'revit_call_tool',turnId:params.turnId,threadId:params.threadId,arguments:candidate.plan}
            },HOST_READBACK) as ReturnType<typeof adaptMcpToolCallResultToDynamicResponse>;
            if(hostReadResponse)hostReadResponse.contentItems.push(...response.contentItems);else hostReadResponse=response;
            const after=getAssignmentKernelSnapshotV2(lease.assignment_id);
            if(!response.success||!after||!checkedEditIsCurrentV2(after,candidate.op.operation_id))break;
          }catch(error){
            const item={type:'inputText' as const,text:`Final native recheck remains open: ${String(error).slice(0,500)}. Do not replay committed changes.`};
            if(hostReadResponse)hostReadResponse.contentItems.push(item);else hostReadResponse={success:false,contentItems:[item]};break;
          }
        }
      }
      settleAssignmentKernelProviderBudgetAtQuiescenceV2(lease.binding);
      const result = params.tool === "revit_search_tools" ? filterQuarantinedToolSearchResult(rawResult) : rawResult;
      const childProjections: EvidenceProjectionV1[] = [];
      for (const reference of nativeChildProjectionReferencesV2(settled.snapshot, lease.operation_id, rawResult)) {
        try {
          const child = settled.snapshot.operations[reference.operation_id];
          if (!child) continue;
          const retained = commitAssignmentKernelObservationV2(leaseFromOperation(child));
          const projection = retained.evidence_projections.find(item => item.evidence_id === reference.evidence_id);
          if (projection) childProjections.push(projection);
        } catch { /* Missing child provenance remains unprojected and fail closed. */ }
      }
      const context = assembleBoundedEvidenceContext({
        projections: [...settled.evidence_projections, ...childProjections],
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
      if (hostReadResponse) response.contentItems.push({ type:"inputText", text:
        "Host requested a separate bounded native readback. Its result and verification status are retained in the assignment context; the edit receipt itself is not proof." },
        ...hostReadResponse.contentItems);
      attachCurrentAssignmentContext(response, params.tool, lease.assignment_id, lease.operation_id);
      return response;
    } catch (error) {
      recordTeammateMcpResult(runtime, teammateGate, { isError: true, error: error instanceof Error ? error.message : String(error) });
      // An MCP handoff can fail after the native child flushed its signed
      // completion. Recover only retained exact results, children first. This
      // never calls Revit or infers a successful parent from a child's receipt.
      try { recoverRetainedAssignmentCompletionsV2(lease.binding); } catch { /* Invalid/conflicting records remain unresolved. */ }
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
      const response: ReturnType<typeof adaptMcpToolCallResultToDynamicResponse> = {
        contentItems: [{ type: "inputText", text: `[assignment_kernel_v2_tool_failed] ${error instanceof Error ? error.message : String(error)}` },
          // Preserve bounded SDK validation/handler diagnostics even when a
          // canonical receipt is missing. Text never grants effect authority.
          ...(rawResult?.isError === true ? adaptMcpToolCallResultToDynamicResponse(rawResult).contentItems
            .filter(item => item.type === "inputText").slice(0, 4).map(item => ({ ...item, text: item.text.slice(0, 8_000) })) : [])],
        success: false
      };
      attachCurrentAssignmentContext(response, params.tool, lease.assignment_id, lease.operation_id);
      return response;
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
