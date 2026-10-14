import type { ToolResult } from "../contracts.js";
import type { ChatRequest } from "../contracts.js";
import { isIndependentAssistantTurn } from "../goals/assistant_turn.js";
import { startAutoGoalIfEligible } from "../goals/auto_goal_start.js";
import { assertConversationIntakeResolved, retainedIntakeDecision } from "../conversation_intake.js";
import type { GoalRecord } from "../goals/service.js";
import { assignmentKernelV2Enabled } from "../domain/assignment-kernel/index.js";
import { assignmentKernelV2ForBinding, createAssignmentKernelForGoalV2, type AssignmentKernelTurnBindingV2 } from "./assignment_kernel_v2_factory.js";
import { assignmentRunForBinding, ensureAssignmentRunForTurn, journalAssignmentToolResults } from "./turn_journal.js";
import { preparePdfWorkAllowance, type PdfWorkAllowanceV1 } from "./pdf_work_allowance.js";

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export type PreparedAssignmentTurn = {
  assignmentId: string;
  runId: string;
  generation: number;
  kernelVersion: 1 | 2;
  bindingV2?: AssignmentKernelTurnBindingV2;
};

export function bindPreparedAssignmentToRequest(request: ChatRequest, prepared: PreparedAssignmentTurn | null): ChatRequest {
  if (!prepared) {
    if (!request.user_text?.trim()) return request;
    const context = request.context && typeof request.context === "object" ? request.context : {};
    const ui = (context as Record<string, unknown>).ui;
    return { ...request, context: { ...context, ui: {
      ...(ui && typeof ui === "object" ? ui : {}), authoritative_user_text: request.user_text
    } } };
  }
  const canonical = prepared.kernelVersion === 2 && prepared.bindingV2
    ? assignmentKernelV2ForBinding(prepared.bindingV2)?.snapshot : null;
  const inputContext = canonical && Object.keys(canonical.input_values).length > 0
    ? `\nAuthenticated exact task input values (JSON data): ${JSON.stringify(canonical.input_values)}` : "";
  const requestContext = request.context && typeof request.context === "object" ? request.context : {};
  const ui = (requestContext as Record<string, unknown>).ui;
  return {
    ...request,
    ...(inputContext ? { user_text: `${request.user_text}${inputContext}` } : {}),
    ...(canonical ? { context: { ...requestContext, ui: {
      ...(ui && typeof ui === "object" ? ui : {}),
      // Resume uses the immutable objective and authenticated journal answers,
      // never a stale desktop computer transcript or caller-supplied values.
      authoritative_user_text: `${canonical.spec.source_user_request}${inputContext}`
    } } } : {}),
    assignment_id: prepared.assignmentId,
    assignment_run_id: prepared.runId,
    assignment_generation: prepared.generation
  };
}

/** Ordinary chat counts the same authenticated source workload as external
 * assignments, without requiring budget vocabulary in the user's request. */
export async function prepareAssignmentTurnWithAttachments(input: Omit<Parameters<typeof prepareAssignmentTurn>[0], "sourceWorkAllowance"> & {
  userAttachments: ChatRequest["user_attachments"];
}): Promise<PreparedAssignmentTurn | null> {
  const { userAttachments, ...turn } = input;
  const supplied = input.suppliedBinding;
  if (input.toolResults.length || supplied?.assignment_id !== undefined
      || supplied?.assignment_run_id !== undefined || supplied?.assignment_generation !== undefined)
    return prepareAssignmentTurn(turn);
  const identity = { session_id: input.sessionId, message_id: input.messageId, user_text: input.userText };
  assertConversationIntakeResolved(identity);
  const intake = retainedIntakeDecision(identity);
  const sourceWorkAllowance = intake?.route === "task" && intake.operation_scope?.requested_effect === "apply"
    ? await preparePdfWorkAllowance({ session_id: input.sessionId, start_assignment_run: true,
      work_budget: { requested_effect: "apply", attachment_ids: (userAttachments ?? []).map(attachment => attachment.id) } })
    : undefined;
  return prepareAssignmentTurn({ ...turn, sourceWorkAllowance });
}

export function prepareAssignmentTurn(input: {
  sessionId: string;
  messageId: string;
  userText: string;
  toolResults: ToolResult[];
  source: string;
  createdBy: string | null;
  requestContext?: unknown;
  suppliedBinding?: { assignment_id?: unknown; assignment_run_id?: unknown; assignment_generation?: unknown };
  /** Host-derived before creation, never copied from chat request fields. */
  sourceWorkAllowance?: PdfWorkAllowanceV1;
  onGoalStarted?: (goal: GoalRecord, signals: string[]) => void;
}): PreparedAssignmentTurn | null {
  const assignmentId = text(input.suppliedBinding?.assignment_id, 240);
  const runId = text(input.suppliedBinding?.assignment_run_id, 240);
  const generation = input.suppliedBinding?.assignment_generation;
  const suppliedCount = Number(Boolean(assignmentId)) + Number(Boolean(runId)) + Number(typeof generation === "number");
  if (suppliedCount > 0) {
    if (!assignmentId || !runId || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("assignment_binding_incomplete");
    }
    const v2 = assignmentKernelV2ForBinding({ session_id: input.sessionId, assignment_id: assignmentId, run_id: runId, generation });
    if (v2) {
      if (input.toolResults.length > 0) throw new Error("assignment_kernel_v2_legacy_tool_results_forbidden");
      return {
        assignmentId: v2.binding.assignment_id,
        runId: v2.binding.run_id,
        generation: v2.binding.generation,
        kernelVersion: 2,
        bindingV2: v2.binding
      };
    }
    const bound = assignmentRunForBinding(input.sessionId, assignmentId, runId, generation);
    if (!bound) throw new Error("assignment_binding_stale_or_mismatched");
    journalAssignmentToolResults(input.sessionId, input.toolResults, `outer_${input.source}_result`);
    return { assignmentId: bound.assignmentId, runId: bound.runId, generation: bound.generation, kernelVersion: 1 };
  }
  assertConversationIntakeResolved({session_id:input.sessionId,message_id:input.messageId,user_text:input.userText});
  const intake=retainedIntakeDecision({session_id:input.sessionId,message_id:input.messageId,user_text:input.userText});
  if ((!intake || intake.route === "answer")
      && isIndependentAssistantTurn({ user_text: input.userText, context: input.requestContext, tool_results: input.toolResults })) return null;
  const started = startAutoGoalIfEligible({
    session_id: input.sessionId,
    message_id: input.messageId,
    user_text: input.userText,
    tool_result_count: input.toolResults.length,
    source: input.source,
    created_by: input.createdBy,
    request_context: input.requestContext,
    on_started: input.onGoalStarted
  });
  if (started && assignmentKernelV2Enabled()) {
    if (input.toolResults.length > 0) throw new Error("assignment_kernel_v2_legacy_tool_results_forbidden");
    const binding = createAssignmentKernelForGoalV2({
      goal: started,
      run_id: `chat:${input.messageId}`,
      document_fingerprint: typeof started.work_budget?.document_fingerprint === "string"
        ? started.work_budget.document_fingerprint
        : undefined,
      ...(started.work_budget?.conversation_message_id === input.messageId
        ? { source_work_allowance: input.sourceWorkAllowance } : {})
    });
    return {
      assignmentId: binding.assignment_id,
      runId: binding.run_id,
      generation: binding.generation,
      kernelVersion: 2,
      bindingV2: binding
    };
  }
  const assignment = ensureAssignmentRunForTurn(
    input.sessionId,
    `chat:${input.messageId}`,
    `outer_${input.source}`,
    input.toolResults.length === 0 && Boolean(input.userText.trim()) && Boolean(started)
  );
  if (started && !assignment) throw new Error("assignment_run_creation_failed");
  journalAssignmentToolResults(input.sessionId, input.toolResults, `outer_${input.source}_result`);
  return assignment ? {
    assignmentId: assignment.assignmentId, runId: assignment.runId,
    generation: assignment.generation, kernelVersion: 1
  } : null;
}
