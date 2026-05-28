import path from "node:path";
import { benchmarkDataRoot, prettyJson, readTextFile, replaceTemplateTokens } from "./files.js";
import type { BenchmarkTaskDefinition, ExecutorDecision, PlannerPlan, SingleLoopDecision } from "./types.js";

function promptsDir(): string {
  return path.join(benchmarkDataRoot(), "prompts");
}

function promptPath(fileName: string): string {
  return path.join(promptsDir(), fileName);
}

function render(fileName: string, tokens: Record<string, string>): string {
  return replaceTemplateTokens(readTextFile(promptPath(fileName)), tokens);
}

export function buildPlannerPrompts(input: {
  task: BenchmarkTaskDefinition;
  stateSummary: string;
  progressSummary: string;
  escalationContext: string;
}): { system: string; user: string } {
  return {
    system: render("planner_system.md", {}),
    user: render("planner_user.md", {
      TASK_JSON: prettyJson(input.task),
      STATE_SUMMARY: input.stateSummary,
      PROGRESS_SUMMARY: input.progressSummary,
      ESCALATION_CONTEXT: input.escalationContext
    })
  };
}

export function buildExecutorPrompts(input: {
  task: BenchmarkTaskDefinition;
  plan: PlannerPlan;
  currentSubgoalJson: string;
  stateSummary: string;
  progressSummary: string;
}): { system: string; user: string } {
  return {
    system: render("executor_system.md", {}),
    user: render("executor_user.md", {
      TASK_JSON: prettyJson(input.task),
      PLAN_JSON: prettyJson(input.plan),
      CURRENT_SUBGOAL_JSON: input.currentSubgoalJson,
      STATE_SUMMARY: input.stateSummary,
      PROGRESS_SUMMARY: input.progressSummary
    })
  };
}

export function buildSingleLoopPrompts(input: {
  task: BenchmarkTaskDefinition;
  stateSummary: string;
  progressSummary: string;
}): { system: string; user: string } {
  return {
    system: render("single_loop_system.md", {}),
    user: render("single_loop_user.md", {
      TASK_JSON: prettyJson(input.task),
      STATE_SUMMARY: input.stateSummary,
      PROGRESS_SUMMARY: input.progressSummary
    })
  };
}

function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Model response was empty.");
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1]!.trim() : trimmed;
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return candidate.slice(objectStart, objectEnd + 1);
  }
  throw new Error("Could not find a JSON object in the model response.");
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
}

function normalizeConfidence(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

export function parsePlannerPlan(rawText: string): PlannerPlan {
  const parsed = JSON.parse(extractJsonBlock(rawText)) as Record<string, unknown>;
  const orderedSubgoals = Array.isArray(parsed.ordered_subgoals)
    ? parsed.ordered_subgoals
        .map((entry, index) => {
          const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          const title = String(row.title ?? row.name ?? `Subgoal ${index + 1}`).trim();
          if (!title) return null;
          return {
            id: String(row.id ?? `subgoal_${index + 1}`).trim() || `subgoal_${index + 1}`,
            title,
            success_signal: String(row.success_signal ?? row.expected_state ?? "").trim()
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    : [];
  if (orderedSubgoals.length === 0) throw new Error("Planner returned no ordered_subgoals.");
  return {
    objective: String(parsed.objective ?? "").trim(),
    preconditions: normalizeStringList(parsed.preconditions),
    ordered_subgoals: orderedSubgoals,
    expected_visible_state_changes: normalizeStringList(parsed.expected_visible_state_changes),
    escalation_rules: normalizeStringList(parsed.escalation_rules),
    done_criteria: normalizeStringList(parsed.done_criteria)
  };
}

export function parseExecutorDecision(rawText: string): ExecutorDecision {
  const parsed = JSON.parse(extractJsonBlock(rawText)) as Record<string, unknown>;
  return {
    current_subgoal: String(parsed.current_subgoal ?? parsed.subgoal ?? "").trim(),
    current_subgoal_id: String(parsed.current_subgoal_id ?? "").trim() || null,
    chosen_action: String(parsed.chosen_action ?? parsed.action ?? "").trim(),
    target: String(parsed.target ?? "").trim(),
    brief_reason: String(parsed.brief_reason ?? parsed.reason ?? "").trim(),
    expected_result: String(parsed.expected_result ?? "").trim(),
    expected_state: String(parsed.expected_state ?? "").trim() || null,
    confidence: normalizeConfidence(parsed.confidence),
    recommend_escalation: Boolean(parsed.recommend_escalation),
    escalation_reason: String(parsed.escalation_reason ?? "").trim() || null,
    done: Boolean(parsed.done),
    subgoal_completed: typeof parsed.subgoal_completed === "boolean" ? parsed.subgoal_completed : undefined,
    high_impact_action: typeof parsed.high_impact_action === "boolean" ? parsed.high_impact_action : undefined
  };
}

export function parseSingleLoopDecision(rawText: string): SingleLoopDecision {
  const parsed = JSON.parse(extractJsonBlock(rawText)) as Record<string, unknown>;
  return {
    ...parseExecutorDecision(rawText),
    plan_note: String(parsed.plan_note ?? "").trim() || null
  };
}
