import { classifyAutoGoalRequest } from "./auto_goal.js";
import { supersedeBlockedAutoGoalForFreshRequest } from "./auto_goal_runtime.js";
import { getCurrentGoalForSession, setAgentGoal, type GoalRecord } from "./service.js";

type JsonMap = Record<string, unknown>;

function object(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function text(value: unknown, max: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length <= max ? normalized : normalized.slice(0, max);
}

export function startAutoGoalIfEligible(input: {
  session_id: string;
  user_text: string;
  tool_result_count: number;
  source: string;
  created_by: string | null;
  request_context?: unknown;
  on_started?: (goal: GoalRecord, signals: string[]) => void;
}): GoalRecord | null {
  if (input.tool_result_count > 0) return null;
  const decision = classifyAutoGoalRequest(input.user_text);
  if (!decision.shouldStart) return null;
  const current = getCurrentGoalForSession(input.session_id);
  if (current && !supersedeBlockedAutoGoalForFreshRequest(input.session_id)) return current;
  const context = object(input.request_context);
  const revit = object(context.revit);
  const document = object(revit.document);
  const projectIdentity = object(document.projectIdentity);
  const goal = setAgentGoal(input.session_id, {
    title: decision.title,
    objective: decision.objective,
    success_criteria: decision.acceptanceCriteria,
    current_phase: "observe",
    current_step: "Capability-aware preflight",
    progress_summary: `Auto-entered goal mode (${decision.signals.join("; ")}).`,
    work_items: [{
      id: "auto.revit-work",
      title: "Complete and verify the requested Revit work",
      status: "in_progress",
      planned_actions: ["Inspect the live model", "Perform the bounded request", "Verify and report the result"]
    }],
    work_budget: {
      mode: "auto_goal",
      source: input.source,
      source_user_request: decision.objective,
      requested_effect: decision.requestedEffect,
      executor_id: text(revit.courier_executor_id, 180) || null,
      document_fingerprint: text(projectIdentity.fingerprint, 128) || null,
      document_title: text(document.title, 260) || null,
      document_path: text(document.path, 1000) || null,
      score: decision.score,
      signals: decision.signals,
      retry_policy: "canonical none/unknown/applied reducer with explicit reconciliation and bounded progress"
    },
    created_by: input.created_by ?? `auto_goal:${input.source}`
  });
  input.on_started?.(goal, decision.signals);
  return goal;
}
