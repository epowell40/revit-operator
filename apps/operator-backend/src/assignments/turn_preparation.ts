import type { ToolResult } from "../contracts.js";
import type { ChatRequest } from "../contracts.js";
import { startAutoGoalIfEligible } from "../goals/auto_goal_start.js";
import type { GoalRecord } from "../goals/service.js";
import { assignmentKernelV2Enabled } from "../domain/assignment-kernel/index.js";
import { assignmentKernelV2ForBinding, createAssignmentKernelForGoalV2, type AssignmentKernelTurnBindingV2 } from "./assignment_kernel_v2_factory.js";
import { assignmentRunForBinding, ensureAssignmentRunForTurn, journalAssignmentToolResults } from "./turn_journal.js";

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
  if (!prepared) return request;
  return {
    ...request,
    assignment_id: prepared.assignmentId,
    assignment_run_id: prepared.runId,
    assignment_generation: prepared.generation
  };
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
  const started = startAutoGoalIfEligible({
    session_id: input.sessionId,
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
        : undefined
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
