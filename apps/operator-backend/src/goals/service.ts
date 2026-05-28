import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

type JsonMap = Record<string, unknown>;

export type GoalStatus = "draft" | "active" | "paused" | "blocked" | "complete" | "canceled" | "failed";
export type GoalLogKind = "action" | "evidence" | "validation";
export type GoalCriterionStatus = "pass" | "fail" | "unknown";

export type GoalLogEntry = {
  id: string;
  ts: string;
  kind: GoalLogKind;
  summary: string;
  details?: JsonMap;
  actor?: string | null;
  artifact_paths?: string[];
};

export type GoalCriterionResult = {
  criterion: string;
  status: GoalCriterionStatus;
  evidence_refs: string[];
  notes?: string;
};

export type GoalCompletionAudit = {
  id: string;
  requested_at: string;
  complete: boolean;
  criteria_results: GoalCriterionResult[];
  evidence_summary: string;
  remaining_work: string[];
  blockers: string[];
  recommendation: string;
};

export type GoalRecord = {
  id: string;
  title: string;
  objective: string;
  acceptance_criteria: string[];
  non_goals: string[];
  created_at: string;
  updated_at: string;
  status: GoalStatus;
  priority?: string | null;
  created_by?: string | null;
  current_phase?: string | null;
  current_step?: string | null;
  progress_summary: string;
  token_budget?: number | null;
  work_budget?: JsonMap | null;
  evidence_log: GoalLogEntry[];
  action_log: GoalLogEntry[];
  validation_log: GoalLogEntry[];
  completion_audit?: GoalCompletionAudit | null;
  related_thread_id?: string | null;
  related_session_id?: string | null;
  related_model_id?: string | null;
  related_project_id?: string | null;
  artifacts: string[];
  error?: string | null;
  blocker?: string | null;
};

export type GoalCreateInput = {
  title?: unknown;
  objective?: unknown;
  acceptance_criteria?: unknown;
  acceptanceCriteria?: unknown;
  non_goals?: unknown;
  nonGoals?: unknown;
  priority?: unknown;
  created_by?: unknown;
  createdBy?: unknown;
  current_phase?: unknown;
  currentPhase?: unknown;
  current_step?: unknown;
  currentStep?: unknown;
  progress_summary?: unknown;
  progressSummary?: unknown;
  token_budget?: unknown;
  tokenBudget?: unknown;
  work_budget?: unknown;
  workBudget?: unknown;
  related_thread_id?: unknown;
  relatedThreadId?: unknown;
  related_session_id?: unknown;
  relatedSessionId?: unknown;
  related_model_id?: unknown;
  relatedModelId?: unknown;
  related_project_id?: unknown;
  relatedProjectId?: unknown;
  artifacts?: unknown;
  status?: unknown;
};

export type GoalUpdateInput = Partial<GoalCreateInput> & {
  status?: unknown;
  error?: unknown;
  blocker?: unknown;
};

export type AgentGoalSetInput = GoalCreateInput & {
  session_id?: unknown;
  thread_id?: unknown;
  success_criteria?: unknown;
  successCriteria?: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function goalsRoot(): string {
  return ensureDir(path.join(ensureWorkspaceLayout().artifacts, "goals"));
}

function goalDir(goalId: string): string {
  return path.join(goalsRoot(), goalId);
}

function goalPath(goalId: string): string {
  return path.join(goalDir(goalId), "goal.json");
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function clip(value: unknown, max = 1000): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max).trim()}...`;
}

function asStringList(value: unknown, maxItems = 80, maxLength = 1000): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|;/g)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = clip(item, maxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function asJsonMap(value: unknown): JsonMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as JsonMap) };
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeStatus(value: unknown): GoalStatus | null {
  const status = clip(value, 80).toLowerCase();
  if (
    status === "draft" ||
    status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "complete" ||
    status === "canceled" ||
    status === "failed"
  ) {
    return status;
  }
  if (status === "cancelled") return "canceled";
  return null;
}

function normalizeLogEntry(value: unknown, kind: GoalLogKind): GoalLogEntry {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as any) : {};
  const summary = clip(obj.summary ?? obj.text ?? obj.message ?? value, 2000);
  if (!summary) throw new Error(`${kind} summary is required.`);
  return {
    id: clip(obj.id, 120) || randomUUID(),
    ts: clip(obj.ts, 80) || nowIso(),
    kind,
    summary,
    ...(asJsonMap(obj.details) ? { details: asJsonMap(obj.details)! } : {}),
    actor: clip(obj.actor, 160) || null,
    artifact_paths: asStringList(obj.artifact_paths ?? obj.artifactPaths, 40, 600)
  };
}

function normalizeCriterionResults(value: unknown, criteria: string[], evidenceLog: GoalLogEntry[], validationLog: GoalLogEntry[]): GoalCriterionResult[] {
  if (Array.isArray(value) && value.length > 0) {
    return value.map((item, index) => {
      const obj = item && typeof item === "object" ? (item as any) : {};
      const criterion = clip(obj.criterion, 1000) || criteria[index] || `Criterion ${index + 1}`;
      const rawStatus = clip(obj.status, 80).toLowerCase();
      const status: GoalCriterionStatus = rawStatus === "pass" || rawStatus === "passed" ? "pass" : rawStatus === "fail" || rawStatus === "failed" ? "fail" : "unknown";
      return {
        criterion,
        status,
        evidence_refs: asStringList(obj.evidence_refs ?? obj.evidenceRefs, 40, 400),
        ...(clip(obj.notes, 1000) ? { notes: clip(obj.notes, 1000) } : {})
      };
    });
  }

  const evidenceText = evidenceLog.map(e => e.summary.toLowerCase()).join("\n");
  const validationText = validationLog.map(v => v.summary.toLowerCase()).join("\n");
  return criteria.map(criterion => {
    const c = criterion.toLowerCase();
    const hasEvidence = c.length >= 5 && (evidenceText.includes(c) || validationText.includes(c));
    return {
      criterion,
      status: hasEvidence ? "pass" : "unknown",
      evidence_refs: hasEvidence ? ["matched evidence/validation summary text"] : []
    };
  });
}

const allowedTransitions: Record<GoalStatus, GoalStatus[]> = {
  draft: ["active", "canceled"],
  active: ["paused", "blocked", "complete", "canceled", "failed"],
  paused: ["active", "canceled"],
  blocked: ["active", "canceled"],
  complete: [],
  canceled: [],
  failed: []
};

function assertTransition(from: GoalStatus, to: GoalStatus): void {
  if (from === to) return;
  if (!allowedTransitions[from]?.includes(to)) {
    throw new Error(`Invalid goal status transition: ${from} -> ${to}.`);
  }
}

function saveGoal(goal: GoalRecord): GoalRecord {
  const next = { ...goal, updated_at: nowIso() };
  writeJson(goalPath(next.id), next);
  return next;
}

export function createGoal(input: GoalCreateInput): GoalRecord {
  const title = clip(input.title, 180);
  const objective = clip(input.objective, 5000);
  const acceptanceCriteria = asStringList(input.acceptance_criteria ?? input.acceptanceCriteria, 80, 1200);
  if (!title) throw new Error("title is required.");
  if (!objective) throw new Error("objective is required.");
  if (acceptanceCriteria.length === 0) throw new Error("acceptance_criteria is required.");

  const createdAt = nowIso();
  const requestedStatus = normalizeStatus(input.status);
  const status: GoalStatus = requestedStatus === "active" ? "active" : "draft";
  const goal: GoalRecord = {
    id: randomUUID(),
    title,
    objective,
    acceptance_criteria: acceptanceCriteria,
    non_goals: asStringList(input.non_goals ?? input.nonGoals, 40, 1200),
    created_at: createdAt,
    updated_at: createdAt,
    status,
    priority: clip(input.priority, 80) || null,
    created_by: clip(input.created_by ?? input.createdBy, 180) || null,
    current_phase: clip(input.current_phase ?? input.currentPhase, 180) || null,
    current_step: clip(input.current_step ?? input.currentStep, 240) || null,
    progress_summary: clip(input.progress_summary ?? input.progressSummary, 3000) || "Goal created.",
    token_budget: asNumberOrNull(input.token_budget ?? input.tokenBudget),
    work_budget: asJsonMap(input.work_budget ?? input.workBudget),
    evidence_log: [],
    action_log: [],
    validation_log: [],
    completion_audit: null,
    related_thread_id: clip(input.related_thread_id ?? input.relatedThreadId, 180) || null,
    related_session_id: clip(input.related_session_id ?? input.relatedSessionId, 180) || null,
    related_model_id: clip(input.related_model_id ?? input.relatedModelId, 180) || null,
    related_project_id: clip(input.related_project_id ?? input.relatedProjectId, 180) || null,
    artifacts: asStringList(input.artifacts, 80, 600),
    error: null,
    blocker: null
  };
  writeJson(goalPath(goal.id), goal);
  return goal;
}

export function getGoal(goalId: string): GoalRecord | null {
  const id = clip(goalId, 160);
  if (!id) return null;
  return readJson<GoalRecord>(goalPath(id));
}

export function listGoals(limit = 50): GoalRecord[] {
  const root = goalsRoot();
  const records: GoalRecord[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const goal = readJson<GoalRecord>(path.join(root, entry.name, "goal.json"));
    if (goal) records.push(goal);
  }
  records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return records.slice(0, Math.max(1, Math.min(200, limit)));
}

export function updateGoal(goalId: string, input: GoalUpdateInput): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status === "complete" || goal.status === "canceled") {
    throw new Error(`Cannot edit a ${goal.status} goal.`);
  }

  const requestedStatus = normalizeStatus(input.status);
  if (requestedStatus && requestedStatus !== goal.status) assertTransition(goal.status, requestedStatus);

  const next: GoalRecord = {
    ...goal,
    title: clip(input.title, 180) || goal.title,
    objective: clip(input.objective, 5000) || goal.objective,
    acceptance_criteria: (input.acceptance_criteria ?? input.acceptanceCriteria) !== undefined
      ? asStringList(input.acceptance_criteria ?? input.acceptanceCriteria, 80, 1200)
      : goal.acceptance_criteria,
    non_goals: (input.non_goals ?? input.nonGoals) !== undefined ? asStringList(input.non_goals ?? input.nonGoals, 40, 1200) : goal.non_goals,
    status: requestedStatus ?? goal.status,
    priority: input.priority !== undefined ? clip(input.priority, 80) || null : goal.priority ?? null,
    current_phase: (input.current_phase ?? input.currentPhase) !== undefined ? clip(input.current_phase ?? input.currentPhase, 180) || null : goal.current_phase ?? null,
    current_step: (input.current_step ?? input.currentStep) !== undefined ? clip(input.current_step ?? input.currentStep, 240) || null : goal.current_step ?? null,
    progress_summary: (input.progress_summary ?? input.progressSummary) !== undefined ? clip(input.progress_summary ?? input.progressSummary, 3000) : goal.progress_summary,
    token_budget: (input.token_budget ?? input.tokenBudget) !== undefined ? asNumberOrNull(input.token_budget ?? input.tokenBudget) : goal.token_budget ?? null,
    work_budget: (input.work_budget ?? input.workBudget) !== undefined ? asJsonMap(input.work_budget ?? input.workBudget) : goal.work_budget ?? null,
    related_thread_id: (input.related_thread_id ?? input.relatedThreadId) !== undefined ? clip(input.related_thread_id ?? input.relatedThreadId, 180) || null : goal.related_thread_id ?? null,
    related_session_id: (input.related_session_id ?? input.relatedSessionId) !== undefined ? clip(input.related_session_id ?? input.relatedSessionId, 180) || null : goal.related_session_id ?? null,
    related_model_id: (input.related_model_id ?? input.relatedModelId) !== undefined ? clip(input.related_model_id ?? input.relatedModelId, 180) || null : goal.related_model_id ?? null,
    related_project_id: (input.related_project_id ?? input.relatedProjectId) !== undefined ? clip(input.related_project_id ?? input.relatedProjectId, 180) || null : goal.related_project_id ?? null,
    artifacts: input.artifacts !== undefined ? asStringList(input.artifacts, 80, 600) : goal.artifacts,
    error: input.error !== undefined ? clip(input.error, 2000) || null : goal.error ?? null,
    blocker: input.blocker !== undefined ? clip(input.blocker, 2000) || null : goal.blocker ?? null
  };
  if (next.acceptance_criteria.length === 0) throw new Error("acceptance_criteria cannot be empty.");
  return saveGoal(next);
}

export function transitionGoal(goalId: string, status: GoalStatus, reason?: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  assertTransition(goal.status, status);
  const reasonText = clip(reason, 2000);
  const next: GoalRecord = {
    ...goal,
    status,
    ...(status === "blocked" ? { blocker: reasonText || goal.blocker || "Blocked." } : {}),
    ...(status === "failed" ? { error: reasonText || goal.error || "Goal failed." } : {}),
    progress_summary:
      status === "active" && goal.status === "draft"
        ? "Goal activated."
        : status === "active" && (goal.status === "paused" || goal.status === "blocked")
          ? "Goal resumed."
          : status === "paused"
            ? "Goal paused."
            : status === "canceled"
              ? "Goal canceled."
              : goal.progress_summary
  };
  return saveGoal(next);
}

export function appendGoalAction(goalId: string, entry: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active" && goal.status !== "blocked") throw new Error(`Cannot append action while goal is ${goal.status}.`);
  const log = normalizeLogEntry(entry, "action");
  return saveGoal({ ...goal, action_log: [...goal.action_log, log].slice(-500), progress_summary: log.summary });
}

export function appendGoalEvidence(goalId: string, entry: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active" && goal.status !== "blocked") throw new Error(`Cannot append evidence while goal is ${goal.status}.`);
  const log = normalizeLogEntry(entry, "evidence");
  const artifacts = [...goal.artifacts];
  for (const p of log.artifact_paths ?? []) {
    if (!artifacts.includes(p)) artifacts.push(p);
  }
  return saveGoal({ ...goal, evidence_log: [...goal.evidence_log, log].slice(-500), artifacts: artifacts.slice(-200) });
}

export function appendGoalValidation(goalId: string, entry: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active" && goal.status !== "blocked") throw new Error(`Cannot append validation while goal is ${goal.status}.`);
  const log = normalizeLogEntry(entry, "validation");
  return saveGoal({ ...goal, validation_log: [...goal.validation_log, log].slice(-500) });
}

export function requestGoalCompletionAudit(goalId: string, input?: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active") throw new Error(`Completion audit requires an active goal, got ${goal.status}.`);
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as any) : {};
  const criteriaResults = normalizeCriterionResults(obj.criteria_results ?? obj.criteriaResults, goal.acceptance_criteria, goal.evidence_log, goal.validation_log);
  const blockers = asStringList(obj.blockers, 40, 1200);
  if (goal.blocker) blockers.unshift(goal.blocker);
  const remainingWork = asStringList(obj.remaining_work ?? obj.remainingWork, 80, 1200);
  const complete = criteriaResults.length > 0 && criteriaResults.every(r => r.status === "pass") && blockers.length === 0;
  for (const r of criteriaResults) {
    if (r.status !== "pass" && !remainingWork.includes(r.criterion)) remainingWork.push(r.criterion);
  }
  const audit: GoalCompletionAudit = {
    id: randomUUID(),
    requested_at: nowIso(),
    complete,
    criteria_results: criteriaResults,
    evidence_summary:
      clip(obj.evidence_summary ?? obj.evidenceSummary, 3000) ||
      `Evidence entries: ${goal.evidence_log.length}; validation entries: ${goal.validation_log.length}; actions: ${goal.action_log.length}.`,
    remaining_work: remainingWork,
    blockers,
    recommendation:
      clip(obj.recommendation, 2000) ||
      (complete ? "All acceptance criteria have passing evidence. Goal can be completed." : "Do not complete yet; one or more criteria are failed or unknown.")
  };
  return saveGoal({ ...goal, completion_audit: audit });
}

export function completeGoalAfterAudit(goalId: string): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active") throw new Error(`Cannot complete a ${goal.status} goal.`);
  if (!goal.completion_audit?.complete) throw new Error("Goal cannot be marked complete until completion audit passes.");
  return saveGoal({ ...goal, status: "complete", progress_summary: "Goal completed after passing completion audit." });
}

export function getActiveGoalForSession(sessionId?: string | null): GoalRecord | null {
  const sid = clip(sessionId, 180);
  const goals = listGoals(100);
  const candidates = goals.filter(g => g.status === "active" && (!sid || !g.related_session_id || g.related_session_id === sid));
  return candidates[0] ?? null;
}

export function setAgentGoal(sessionId: string, input: AgentGoalSetInput): GoalRecord {
  const sid = clip(sessionId || input.session_id, 180);
  if (!sid) throw new Error("session_id is required.");
  const acceptance =
    input.acceptance_criteria ??
    input.acceptanceCriteria ??
    input.success_criteria ??
    input.successCriteria;
  const existing = getActiveGoalForSession(sid);
  if (existing) {
    return updateGoal(existing.id, {
      ...(input as GoalUpdateInput),
      acceptance_criteria: acceptance,
      related_session_id: sid,
      related_thread_id: input.related_thread_id ?? input.relatedThreadId ?? input.thread_id,
      status: "active"
    });
  }
  return createGoal({
    ...input,
    acceptance_criteria: acceptance,
    title: input.title ?? input.objective,
    related_session_id: sid,
    related_thread_id: input.related_thread_id ?? input.relatedThreadId ?? input.thread_id,
    status: "active"
  });
}

export function clearAgentGoal(sessionId: string, reason?: unknown): GoalRecord | null {
  const sid = clip(sessionId, 180);
  const goals = listGoals(100);
  const goal = goals.find(g =>
    (g.status === "active" || g.status === "blocked" || g.status === "paused") &&
    (!sid || !g.related_session_id || g.related_session_id === sid)
  ) ?? null;
  if (!goal) return null;
  return transitionGoal(goal.id, "canceled", reason ?? "Goal cleared.");
}

export function appendGoalProgress(sessionId: string, entry: unknown): GoalRecord {
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) throw new Error("No active goal for session.");
  const obj = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as any) : {};
  const summary =
    clip(obj.summary, 2000) ||
    [
      clip(obj.observation, 700),
      clip(obj.action, 700),
      clip(obj.result, 700)
    ].filter(Boolean).join(" | ") ||
    "Goal progress recorded.";
  return appendGoalAction(goal.id, {
    summary,
    details: asJsonMap(obj) ?? { value: entry }
  });
}

export function markAgentGoalBlocked(sessionId: string, reason: unknown, evidence?: unknown): GoalRecord {
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) throw new Error("No active goal for session.");
  if (evidence !== undefined) appendGoalEvidence(goal.id, { summary: "Blocker evidence recorded.", details: asJsonMap(evidence) ?? { evidence } });
  return transitionGoal(goal.id, "blocked", reason);
}

export function markAgentGoalComplete(sessionId: string, evidence?: unknown): GoalRecord {
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) throw new Error("No active goal for session.");
  if (evidence !== undefined) appendGoalEvidence(goal.id, { summary: "Completion evidence recorded.", details: asJsonMap(evidence) ?? { evidence } });
  const audited = requestGoalCompletionAudit(goal.id, {
    criteria_results: goal.acceptance_criteria.map((criterion) => ({
      criterion,
      status: "pass",
      evidence_refs: evidence !== undefined ? ["completion evidence"] : ["agent completion request"]
    })),
    evidence_summary: evidence !== undefined ? "Completion evidence supplied by caller." : "Caller requested completion.",
    blockers: []
  });
  return completeGoalAfterAudit(audited.id);
}

export function formatActiveGoalContext(goal: GoalRecord | null): string {
  if (!goal || goal.status !== "active") return "";
  const recentActions = goal.action_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
  const recentEvidence = goal.evidence_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
  const recentValidations = goal.validation_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
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
    `recent_action_log:\n${recentActions.length ? recentActions.join("\n") : "- (none)"}`,
    `recent_evidence_log:\n${recentEvidence.length ? recentEvidence.join("\n") : "- (none)"}`,
    `recent_validation_log:\n${recentValidations.length ? recentValidations.join("\n") : "- (none)"}`,
    "Goal Mode instructions: work toward the active goal, avoid repeating completed work, pick the next concrete action, record evidence after meaningful actions, run validations when available, mark uncertainty as not complete, and request a completion audit before any complete status."
  ].join("\n");
}
