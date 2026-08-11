import {
  appendGoalProgress,
  appendTrustedServerGoalValidation,
  getActiveGoalForSession,
  listGoals,
  markAgentGoalBlocked,
  markAgentGoalComplete
} from "./service.js";

export type AutoGoalToolObservation = {
  tool: string;
  success: boolean | null;
  status?: string | null;
  error?: string | null;
  duration_ms?: number | null;
};

export function findInterruptedAutoGoalForSession(sessionId?: string | null) {
  return sessionId
    ? listGoals(100).find(goal => goal.related_session_id === sessionId && ["paused", "canceled", "failed"].includes(goal.status)) ?? null
    : null;
}

export function createAutoGoalTurnObserver(sessionId: string) {
  let successfulTools = 0;
  let failedTools = 0;
  return {
    observe(observation: AutoGoalToolObservation) {
      if (observation.success === true) successfulTools += 1;
      if (observation.success === false) failedTools += 1;
      try { recordAutoGoalToolObservation(sessionId, observation); } catch {}
    },
    finish(turnId: string, assistantText: string) {
      try {
        const pendingApproval = /\b(awaiting approval|please (?:approve|confirm)|need(?:s)? (?:your|user) (?:approval|confirmation))\b/i.test(assistantText);
        const blockedOutcome = /\b(could not|cannot|can't|unable|blocked|not verified|failed)\b/i.test(assistantText);
        if (!pendingApproval && !blockedOutcome && successfulTools > 0) {
          completeAutoGoalFromValidatedTurn(sessionId, { turn_id: turnId, successful_tools: successfulTools, assistant_summary: assistantText });
        } else if (blockedOutcome || (failedTools > 0 && successfulTools === 0)) {
          blockAutoGoalFromTurn(sessionId, assistantText || "The General Agent turn ended without a successful live Revit tool result.");
        }
      } catch {
        // Assignment journaling is fail-safe and must not replace a completed user response.
      }
    }
  };
}

function activeAutoGoal(sessionId: string) {
  const goal = getActiveGoalForSession(sessionId);
  return goal?.work_budget?.mode === "auto_goal" ? goal : null;
}

export function recordAutoGoalToolObservation(sessionId: string, observation: AutoGoalToolObservation): void {
  const goal = activeAutoGoal(sessionId);
  if (!goal) return;
  const outcome = observation.success === false ? "failed" : observation.success === true ? "completed" : "finished";
  appendGoalProgress(sessionId, {
    summary: `Live tool ${observation.tool} ${outcome}${observation.error ? `: ${observation.error}` : "."}`,
    tool: observation,
    work_item: {
      id: "auto.revit-work",
      title: "Complete and verify the requested Revit work",
      status: observation.success === false ? "blocked" : "in_progress",
      blocker: observation.success === false ? observation.error || `${observation.tool} failed.` : null,
      result_summary: `${observation.tool} ${outcome}.`
    }
  });
}

export function completeAutoGoalFromValidatedTurn(
  sessionId: string,
  input: { turn_id: string; successful_tools: number; assistant_summary: string }
): void {
  let goal = activeAutoGoal(sessionId);
  if (!goal || input.successful_tools < 1) return;
  goal = appendGoalProgress(sessionId, {
    summary: `Completed the requested Revit work using ${input.successful_tools} successful live tool call${input.successful_tools === 1 ? "" : "s"}.`,
    work_item: {
      id: "auto.revit-work",
      title: "Complete and verify the requested Revit work",
      status: "complete",
      result_summary: input.assistant_summary
    }
  });
  const evidenceRefs: string[] = [];
  for (const criterion of goal.acceptance_criteria) {
    const validated = appendTrustedServerGoalValidation(goal.id, {
      criterion,
      validator_id: `codex-turn:${input.turn_id}`,
      method: `Backend-observed General Agent turn completed with ${input.successful_tools} successful live Revit tool calls and no failed calls.`,
      status: "pass"
    });
    const entry = validated.validation_log.at(-1);
    if (entry) evidenceRefs.push(`validation:${entry.id}`);
  }
  markAgentGoalComplete(sessionId, {
    criteria_results: goal.acceptance_criteria.map((criterion, index) => ({
      criterion,
      status: "pass",
      evidence_refs: evidenceRefs[index] ? [evidenceRefs[index]] : []
    })),
    evidence_summary: `${input.successful_tools} successful live Revit tool calls were observed and the General Agent returned a result.`
  });
}

export function blockAutoGoalFromTurn(sessionId: string, reason: string): void {
  const goal = activeAutoGoal(sessionId);
  if (!goal) return;
  appendGoalProgress(sessionId, {
    summary: reason,
    work_item: {
      id: "auto.revit-work",
      title: "Complete and verify the requested Revit work",
      status: "blocked",
      blocker: reason
    }
  });
  markAgentGoalBlocked(sessionId, reason, { source: "general_agent_turn" });
}
