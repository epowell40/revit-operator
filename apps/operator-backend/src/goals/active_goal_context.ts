import type { GoalRecord } from "./service.js";
import { normalizeAssignmentControlPlane, reduceAssignmentControlPlane } from "../assignments/control_plane.js";
import { formatAssignmentKernelV2GoalContext } from "./assignment_kernel_v2_prompt.js";

export function formatActiveGoalContext(goal: GoalRecord | null): string {
  if (!goal) return "";
  const kernelV2 = formatAssignmentKernelV2GoalContext(goal);
  if (kernelV2 !== null) return kernelV2;
  if (goal.status !== "active") return "";
  const control = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
  const recentAttempts = control.attempts.slice(-8).map(attempt =>
    `- ${attempt.attempt_id} [${attempt.purpose}/${attempt.requested_effect}] ${attempt.action_path} effect=${attempt.effect.state} authority=${attempt.effect.authority} verification=${attempt.verification.state}`);
  const recentActions = goal.action_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
  const recentEvidence = goal.evidence_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
  const recentValidations = goal.validation_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
  const workItems = (goal.work_items ?? []).filter(item => item.status !== "skipped").slice(-12).map(item => {
    const dependencies = item.depends_on.length ? ` depends_on=${item.depends_on.join(",")}` : "";
    const blocker = item.blocker ? ` blocker=${item.blocker}` : "";
    return `- ${item.id} [${item.status}] ${item.title}${dependencies}${blocker}`;
  });
  const assumptions = (goal.assumptions ?? []).filter(item => item.status === "proposed" || item.status === "accepted").slice(-12).map(item => `- ${item.id} [${item.status}] ${item.statement}${item.basis ? ` (basis: ${item.basis})` : ""}`);
  const resolvedClarifications = control.clarifications.filter(item => item.status === "resolved").slice(-4).map(item =>
    `- ${item.clarification_id}: ${JSON.stringify(item.supplied_values)}`);
  return [
    "ACTIVE GOAL CONTEXT (active_goal_context):",
    `id: ${goal.id}`,
    `title: ${goal.title}`,
    `status: ${goal.status}`,
    `objective: ${goal.objective}`,
    `acceptance_criteria:\n${goal.acceptance_criteria.map(c => `- ${c}`).join("\n")}`,
    goal.non_goals.length > 0 ? `non_goals:\n${goal.non_goals.map(c => `- ${c}`).join("\n")}` : "non_goals: (none)",
    `current_phase: ${goal.current_phase || "(unset)"}`,
    `current_step: ${goal.current_step || "(unset)"}`,
    `progress_summary: ${goal.progress_summary || "(empty)"}`,
    `blocker: ${goal.blocker || "(none)"}`,
    `canonical_control_plane: generation=${control.generation} run_id=${control.run_id ?? "(none)"} phase=${control.phase} outcome=${control.outcome_state} terminal=${control.terminal_state}`,
    `resolved_user_input:\n${resolvedClarifications.length ? resolvedClarifications.join("\n") : "- (none)"}`,
    `canonical_unknown_attempts: ${control.unresolved_unknown_attempt_ids.join(", ") || "(none)"}`,
    `canonical_progress_decision: ${control.progress.decision}${control.progress.reason ? ` (${control.progress.reason})` : ""}`,
    `canonical_recent_attempts:\n${recentAttempts.length ? recentAttempts.join("\n") : "- (none)"}`,
    `work_items:\n${workItems.length ? workItems.join("\n") : "- (none)"}`,
    `assumptions:\n${assumptions.length ? assumptions.join("\n") : "- (none)"}`,
    `recent_action_log:\n${recentActions.length ? recentActions.join("\n") : "- (none)"}`,
    `recent_evidence_log:\n${recentEvidence.length ? recentEvidence.join("\n") : "- (none)"}`,
    `recent_validation_log:\n${recentValidations.length ? recentValidations.join("\n") : "- (none)"}`,
    "Assignment state is owned and automatically journaled by the Revit Operator backend. Do not call Codex create_goal, get_goal, or update_goal tools from this embedded turn.",
    "Goal Mode instructions: work toward the active goal, avoid repeating completed work, pick the next ready work item whose dependencies are complete, use live Revit evidence, and report completion or a concrete task blocker truthfully."
  ].join("\n");
}
