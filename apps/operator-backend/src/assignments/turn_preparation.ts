import type { ToolResult } from "../contracts.js";
import { startAutoGoalIfEligible } from "../goals/auto_goal_start.js";
import type { GoalRecord } from "../goals/service.js";
import { assignmentRunForBinding, ensureAssignmentRunForTurn, journalAssignmentToolResults } from "./turn_journal.js";

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
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
}): { assignmentId: string; runId: string; generation: number } | null {
  const assignmentId = text(input.suppliedBinding?.assignment_id, 240);
  const runId = text(input.suppliedBinding?.assignment_run_id, 240);
  const generation = input.suppliedBinding?.assignment_generation;
  const suppliedCount = Number(Boolean(assignmentId)) + Number(Boolean(runId)) + Number(typeof generation === "number");
  if (suppliedCount > 0) {
    if (!assignmentId || !runId || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("assignment_binding_incomplete");
    }
    const bound = assignmentRunForBinding(input.sessionId, assignmentId, runId, generation);
    if (!bound) throw new Error("assignment_binding_stale_or_mismatched");
    journalAssignmentToolResults(input.sessionId, input.toolResults, `outer_${input.source}_result`);
    return { assignmentId: bound.assignmentId, runId: bound.runId, generation: bound.generation };
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
  const assignment = ensureAssignmentRunForTurn(
    input.sessionId,
    `chat:${input.messageId}`,
    `outer_${input.source}`,
    input.toolResults.length === 0 && Boolean(input.userText.trim()) && Boolean(started)
  );
  if (started && !assignment) throw new Error("assignment_run_creation_failed");
  journalAssignmentToolResults(input.sessionId, input.toolResults, `outer_${input.source}_result`);
  return assignment ? {
    assignmentId: assignment.assignmentId,
    runId: assignment.runId,
    generation: assignment.generation
  } : null;
}
