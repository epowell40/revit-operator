import type { GoalLogEntry, GoalRecord, GoalWorkItem } from "../goals/service.js";
import { getGoal, listGoals } from "../goals/service.js";
import { getOperatorTask, listOperatorTasks } from "../tasks/service.js";

type JsonMap = Record<string, unknown>;

export const ASSIGNMENT_PROJECTION_SCHEMA = "revit-operator.assignment-projection/v1" as const;

export type AssignmentLifecyclePhase =
  | "understanding"
  | "inspecting"
  | "planning"
  | "preparing"
  | "previewing"
  | "preview_ready"
  | "awaiting_approval"
  | "applying"
  | "verifying"
  | "correcting"
  | "complete"
  | "complete_with_issues"
  | "paused"
  | "blocked"
  | "outcome_uncertain"
  | "cancelled"
  | "failed"
  | "unknown";

export type AssignmentTruthValue = boolean | null;

export type AssignmentProjection = {
  schema: typeof ASSIGNMENT_PROJECTION_SCHEMA;
  id: string;
  source_kind: "goal" | "task";
  source_record_id: string;
  title: string;
  objective: string | null;
  source_user_request: string | null;
  acceptance_criteria: string[];
  lifecycle: {
    phase: AssignmentLifecyclePhase;
    source_status: string;
    source_phase: string | null;
    current_step: string | null;
    summary: string | null;
  };
  target: {
    session_id: string | null;
    thread_id: string | null;
    model_id: string | null;
    project_id: string | null;
    executor_id: string | null;
    document_fingerprint: string | null;
    document_title: string | null;
    document_path: string | null;
  };
  plan: {
    steps: Array<{
      id: string;
      title: string;
      status: string;
      depends_on: string[];
      blocker: string | null;
      result_summary: string | null;
      evidence_refs: string[];
    }>;
    source: JsonMap | null;
  };
  assumptions: Array<{
    id: string;
    statement: string;
    status: string;
    basis: string | null;
    evidence_refs: string[];
  }>;
  progress: {
    determinate: boolean;
    total: number | null;
    completed: number | null;
    active: number | null;
    pending: number | null;
    blocked: number | null;
    failed: number | null;
    skipped: number | null;
    ratio: number | null;
  };
  approvals: Array<{
    kind: "execution" | "completion_evidence";
    status: string;
    required: boolean | null;
    decided_at: string | null;
    principal_id: string | null;
    preview_hash: string | null;
    binding_status: "bound" | "unbound" | "unknown";
  }>;
  effects: {
    create_count: number | null;
    modify_count: number | null;
    delete_count: number | null;
    created_ids: string[];
    modified_ids: string[];
    deleted_ids: string[];
    affected_categories: string[];
    summary: string | null;
  };
  evidence: {
    entries: Array<{ id: string; kind: string; ts: string; summary: string; artifact_paths: string[] }>;
    artifact_paths: string[];
  };
  artifacts: Array<{ path: string; sha256: string | null; size_bytes: number | null; role: string }>;
  blockers: string[];
  verification: {
    state: string;
    criteria: Array<{ criterion: string; status: string; evidence_refs: string[]; notes: string | null }>;
    evidence_paths: string[];
    notes: string[];
  };
  execution: {
    substrate: string | null;
    requested_effect: "read" | "preview" | "apply" | null;
    task_ids: string[];
    batch_job_ids: string[];
  };
  truth: {
    stale: AssignmentTruthValue;
    outcome_uncertain: AssignmentTruthValue;
    reconciliation_required: AssignmentTruthValue;
  };
  history: Array<{ ts: string; kind: string; text: string }>;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

function object(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of array(value)) {
    const candidate = text(item);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function explicitBoolean(...values: unknown[]): AssignmentTruthValue {
  for (const value of values) {
    if (value === true) return true;
    if (value === false) return false;
  }
  return null;
}

function truthMerge(left: AssignmentTruthValue, right: AssignmentTruthValue): AssignmentTruthValue {
  if (left === true || right === true) return true;
  if (left === false || right === false) return false;
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function goalLifecycle(goal: GoalRecord): AssignmentLifecyclePhase {
  if (goal.status === "complete") return "complete";
  if (goal.status === "paused") return "paused";
  if (goal.status === "blocked") return "blocked";
  if (goal.status === "canceled") return "cancelled";
  if (goal.status === "failed") return "failed";
  if (goal.status === "draft") return "understanding";
  const phase = text(goal.current_phase).toLowerCase().replace(/[\s-]+/g, "_");
  if (!phase) return "understanding";
  if (/outcome.*uncertain|unknown.*outcome/.test(phase)) return "outcome_uncertain";
  if (/await.*approval|waiting.*approval/.test(phase)) return "awaiting_approval";
  if (/preview.*ready/.test(phase)) return "preview_ready";
  if (/understand|intake/.test(phase)) return "understanding";
  if (/inspect|observe|discover|query|preflight/.test(phase)) return "inspecting";
  if (/plan/.test(phase)) return "planning";
  if (/prepar|automat|generat|compil|admission/.test(phase)) return "preparing";
  if (/preview|dry_run/.test(phase)) return "previewing";
  if (/apply|execut|write|dispatch/.test(phase)) return "applying";
  if (/verif|validat|readback|audit/.test(phase)) return "verifying";
  if (/correct|repair|retry/.test(phase)) return "correcting";
  return "unknown";
}

function taskLifecycle(status: string): AssignmentLifecyclePhase {
  switch (status.toLowerCase()) {
    case "planning": return "planning";
    case "awaiting_approval": return "awaiting_approval";
    case "queued": return "preparing";
    case "running": return "applying";
    case "paused": return "paused";
    case "cancelled": return "cancelled";
    case "failed": return "failed";
    case "succeeded": return "complete";
    case "succeeded_with_failures": return "complete_with_issues";
    default: return "unknown";
  }
}

function goalSteps(workItems: GoalWorkItem[]): AssignmentProjection["plan"]["steps"] {
  return (workItems ?? []).map(item => ({
    id: item.id,
    title: item.title,
    status: item.status,
    depends_on: [...item.depends_on],
    blocker: item.blocker,
    result_summary: item.result_summary,
    evidence_refs: [...item.evidence_refs]
  }));
}

function progressFromSteps(steps: AssignmentProjection["plan"]["steps"]): AssignmentProjection["progress"] {
  if (steps.length === 0) return {
    determinate: false, total: null, completed: null, active: null, pending: null,
    blocked: null, failed: null, skipped: null, ratio: null
  };
  const completed = steps.filter(step => step.status === "complete").length;
  const skipped = steps.filter(step => step.status === "skipped").length;
  const active = steps.filter(step => step.status === "in_progress").length;
  const blocked = steps.filter(step => step.status === "blocked").length;
  const failed = steps.filter(step => step.status === "failed").length;
  const pending = Math.max(0, steps.length - completed - skipped - active - blocked - failed);
  return {
    determinate: true,
    total: steps.length,
    completed,
    active,
    pending,
    blocked,
    failed,
    skipped,
    ratio: (completed + skipped) / steps.length
  };
}

function progressFromTask(value: unknown): AssignmentProjection["progress"] {
  const progress = object(value);
  const total = finite(progress.total);
  if (total === null || total === 0) return {
    determinate: false, total: total === 0 ? 0 : null, completed: null, active: null,
    pending: null, blocked: null, failed: null, skipped: null, ratio: null
  };
  const completed = finite(progress.succeeded) ?? 0;
  const active = finite(progress.running) ?? 0;
  const pending = finite(progress.pending) ?? 0;
  const failed = finite(progress.failed) ?? 0;
  const skipped = finite(progress.skipped) ?? 0;
  return { determinate: true, total, completed, active, pending, blocked: null, failed, skipped, ratio: (completed + skipped) / total };
}

function goalEvidence(goal: GoalRecord): AssignmentProjection["evidence"] {
  const logs = [
    ...goal.action_log.map(entry => ({ ...entry, displayKind: "action" })),
    ...goal.evidence_log.map(entry => ({ ...entry, displayKind: "evidence" })),
    ...goal.validation_log.map(entry => ({ ...entry, displayKind: "validation" }))
  ];
  const entries = logs.map(entry => ({
    id: entry.id,
    kind: entry.displayKind,
    ts: entry.ts,
    summary: entry.summary,
    artifact_paths: [...(entry.artifact_paths ?? [])]
  }));
  return { entries, artifact_paths: unique([...goal.artifacts, ...entries.flatMap(entry => entry.artifact_paths)]) };
}

function artifactsFromGoal(goal: GoalRecord, evidence: AssignmentProjection["evidence"]): AssignmentProjection["artifacts"] {
  const typed = new Map<string, { path: string; sha256: string | null; size_bytes: number | null; role: string }>();
  for (const entry of goal.evidence_log) {
    if (entry.evidence?.kind !== "artifact") continue;
    typed.set(entry.evidence.artifact.path, {
      path: entry.evidence.artifact.path,
      sha256: entry.evidence.artifact.sha256,
      size_bytes: entry.evidence.artifact.size_bytes,
      role: "evidence"
    });
  }
  for (const artifactPath of evidence.artifact_paths) {
    if (!typed.has(artifactPath)) typed.set(artifactPath, { path: artifactPath, sha256: null, size_bytes: null, role: "unverified_reference" });
  }
  return [...typed.values()];
}

function goalApprovals(goal: GoalRecord): AssignmentProjection["approvals"] {
  return goal.evidence_log.flatMap(entry => entry.evidence?.kind === "human_approval" ? [{
    kind: "completion_evidence" as const,
    status: entry.evidence.approval.status,
    required: null,
    decided_at: entry.evidence.approval.recorded_at,
    principal_id: entry.evidence.approval.approver_identity,
    preview_hash: null,
    binding_status: "unbound" as const
  }] : []);
}

function historyFromGoal(goal: GoalRecord): AssignmentProjection["history"] {
  const entry = (row: GoalLogEntry, kind: string) => ({ ts: row.ts, kind, text: row.summary });
  const history = [
    { ts: goal.created_at, kind: "created", text: `Created ${goal.title}` },
    ...goal.action_log.map(row => entry(row, "action")),
    ...goal.evidence_log.map(row => entry(row, "evidence")),
    ...goal.validation_log.map(row => entry(row, "validation")),
    ...(goal.completion_audit ? [{ ts: goal.completion_audit.requested_at, kind: "completion_audit", text: goal.completion_audit.recommendation }] : [])
  ];
  return history.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function projectGoalAssignment(goal: GoalRecord): AssignmentProjection {
  const steps = goalSteps(goal.work_items);
  const evidence = goalEvidence(goal);
  const workBudget = object(goal.work_budget);
  const criteria = goal.completion_audit?.criteria_results.map(result => ({
    criterion: result.criterion,
    status: result.status,
    evidence_refs: [...result.evidence_refs],
    notes: result.notes ?? null
  })) ?? [];
  const blockers = unique([
    ...(goal.blocker ? [goal.blocker] : []),
    ...(goal.error ? [goal.error] : []),
    ...goal.work_items.flatMap(item => item.blocker ? [item.blocker] : [])
  ]);
  return {
    schema: ASSIGNMENT_PROJECTION_SCHEMA,
    id: `goal:${goal.id}`,
    source_kind: "goal",
    source_record_id: goal.id,
    title: goal.title,
    objective: goal.objective,
    source_user_request: text(workBudget.source_user_request ?? workBudget.user_request) || goal.objective,
    acceptance_criteria: [...goal.acceptance_criteria],
    lifecycle: {
      phase: goalLifecycle(goal), source_status: goal.status, source_phase: goal.current_phase ?? null,
      current_step: goal.current_step ?? null, summary: goal.progress_summary || null
    },
    target: {
      session_id: goal.related_session_id ?? null, thread_id: goal.related_thread_id ?? null,
      model_id: goal.related_model_id ?? null, project_id: goal.related_project_id ?? null,
      executor_id: text(workBudget.executor_id) || null,
      document_fingerprint: text(workBudget.document_fingerprint) || null,
      document_title: text(workBudget.document_title) || null,
      document_path: text(workBudget.document_path) || null
    },
    plan: { steps, source: null },
    assumptions: goal.assumptions.map(item => ({
      id: item.id,
      statement: item.statement,
      status: item.status,
      basis: item.basis,
      evidence_refs: [...item.evidence_refs]
    })),
    progress: progressFromSteps(steps),
    approvals: goalApprovals(goal),
    effects: {
      create_count: finite(workBudget.create_count), modify_count: finite(workBudget.modify_count), delete_count: finite(workBudget.delete_count),
      created_ids: stringList(workBudget.created_ids), modified_ids: stringList(workBudget.modified_ids), deleted_ids: stringList(workBudget.deleted_ids),
      affected_categories: stringList(workBudget.affected_categories), summary: text(workBudget.effect_summary) || null
    },
    evidence,
    artifacts: artifactsFromGoal(goal, evidence),
    blockers,
    verification: {
      state: goal.completion_audit ? (goal.completion_audit.complete ? "passed" : "incomplete") : "unknown",
      criteria,
      evidence_paths: evidence.artifact_paths,
      notes: goal.completion_audit ? unique([goal.completion_audit.evidence_summary, ...goal.completion_audit.remaining_work]) : []
    },
    execution: {
      substrate: text(workBudget.execution_substrate ?? workBudget.mode) || null,
      requested_effect: ["read", "preview", "apply"].includes(text(workBudget.requested_effect).toLowerCase())
        ? text(workBudget.requested_effect).toLowerCase() as "read" | "preview" | "apply"
        : null,
      task_ids: stringList(workBudget.task_ids),
      batch_job_ids: stringList(workBudget.batch_job_ids)
    },
    truth: {
      stale: explicitBoolean(workBudget.stale),
      outcome_uncertain: explicitBoolean(workBudget.outcome_uncertain),
      reconciliation_required: explicitBoolean(workBudget.reconciliation_required)
    },
    history: historyFromGoal(goal),
    created_at: goal.created_at,
    updated_at: goal.updated_at,
    finished_at: goal.status === "complete" || goal.status === "canceled" || goal.status === "failed" ? goal.updated_at : null
  };
}

function taskApprovals(task: JsonMap): AssignmentProjection["approvals"] {
  const approval = object(object(task.plan).approval);
  if (Object.keys(approval).length === 0) return [];
  const required = explicitBoolean(approval.required);
  const approvedAt = text(approval.approved_at) || null;
  const previewHash = text(approval.preview_hash ?? approval.preview_receipt_hash) || null;
  const approvedPreviewHash = text(approval.approved_preview_hash) || null;
  const principalId = text(approval.principal_id ?? approval.approved_by) || null;
  const serverBound = text(object(task.source).backend_surface) === "revit_batch" &&
    approval.preview_binding_schema === "revit-operator.batch-preview-binding.v1" &&
    approval.preview_hash_verified === true && /^sha256:[0-9a-f]{64}$/.test(previewHash || "");
  const approvalBound = serverBound && (!approvedAt || (approvedPreviewHash === previewHash && !!principalId));
  const status = required === false ? "not_required" : approvedAt ? "approved" : text(task.status) === "awaiting_approval" ? "awaiting" : "unknown";
  return [{
    kind: "execution", status, required, decided_at: approvedAt,
    principal_id: principalId,
    preview_hash: previewHash,
    binding_status: approvalBound ? "bound" : approvedAt || previewHash ? "unbound" : "unknown"
  }];
}

function taskArtifacts(task: JsonMap): AssignmentProjection["artifacts"] {
  const evidence = object(task.evidence);
  const artifacts = object(task.artifacts);
  const evidencePaths = stringList(evidence.artifact_paths);
  const outputPaths = stringList(evidence.output_paths);
  const all = unique([...stringList(artifacts.workspace_paths), ...evidencePaths, ...outputPaths]);
  return all.map(path => ({
    path, sha256: null, size_bytes: null,
    role: outputPaths.includes(path) ? "deliverable" : evidencePaths.includes(path) ? "evidence" : "artifact"
  }));
}

function effectsFromTask(task: JsonMap): AssignmentProjection["effects"] {
  const result = object(task.result);
  const effects = object(result.effect_summary);
  const createdIds = stringList(effects.created_ids ?? result.created_ids);
  const modifiedIds = stringList(effects.modified_ids ?? result.modified_ids ?? result.changed_element_ids);
  const deletedIds = stringList(effects.deleted_ids ?? result.deleted_ids);
  return {
    create_count: finite(effects.create_count ?? result.create_count) ?? (createdIds.length ? createdIds.length : null),
    modify_count: finite(effects.modify_count ?? result.modify_count) ?? (modifiedIds.length ? modifiedIds.length : null),
    delete_count: finite(effects.delete_count ?? result.delete_count) ?? (deletedIds.length ? deletedIds.length : null),
    created_ids: createdIds,
    modified_ids: modifiedIds,
    deleted_ids: deletedIds,
    affected_categories: stringList(effects.affected_categories ?? result.affected_categories),
    summary: text(effects.summary ?? result.effect_summary_text) || null
  };
}

function taskGoalId(task: JsonMap): string {
  const related = object(task.related);
  const source = object(task.source);
  return text(related.assignment_id ?? related.goal_id ?? source.assignment_id ?? source.goal_id);
}

export function projectTaskAssignment(task: JsonMap): AssignmentProjection {
  const source = object(task.source);
  const related = object(task.related);
  const plan = object(task.plan);
  const verification = object(task.verification);
  const result = object(task.result);
  const target = object(source.target_context ?? related.target_context);
  const progress = progressFromTask(task.progress);
  const artifacts = taskArtifacts(task);
  const artifactPaths = artifacts.map(artifact => artifact.path);
  const events = array(task.events).map(value => object(value)).map(value => ({
    ts: text(value.ts), kind: text(value.kind) || "event", text: text(value.text)
  })).filter(value => value.ts || value.text);
  const previewItems = array(plan.preview_items);
  const approvals = taskApprovals(task);
  const status = text(task.status);
  const blockers = unique([text(task.error), ...stringList(result.blockers)]);
  const taskId = text(task.id);
  const batchJobId = text(related.batch_job_id ?? source.batch_job_id);
  return {
    schema: ASSIGNMENT_PROJECTION_SCHEMA,
    id: `task:${taskId}`,
    source_kind: "task",
    source_record_id: taskId,
    title: text(task.title) || "Operator task",
    objective: text(source.user_request ?? source.objective) || null,
    source_user_request: text(source.user_request ?? source.query_text) || null,
    acceptance_criteria: stringList(source.acceptance_criteria),
    lifecycle: {
      phase: taskLifecycle(status), source_status: status || "unknown", source_phase: null,
      current_step: null, summary: text(result.summary ?? result.planner_summary) || null
    },
    target: {
      session_id: text(source.session_id ?? related.session_id) || null,
      thread_id: text(related.thread_id) || null,
      model_id: text(target.model_id) || null,
      project_id: text(target.project_id) || null,
      executor_id: text(target.executor_id) || null,
      document_fingerprint: text(target.project_fingerprint ?? target.document_fingerprint) || null,
      document_title: text(target.document_title) || null,
      document_path: text(target.document_path) || null
    },
    plan: { steps: [], source: { ...plan, preview_items: previewItems.slice(0, 12) } },
    assumptions: [],
    progress,
    approvals,
    effects: effectsFromTask(task),
    evidence: {
      entries: events.map((event, index) => ({ id: `${taskId}:event:${index}`, kind: event.kind, ts: event.ts, summary: event.text, artifact_paths: [] })),
      artifact_paths: artifactPaths
    },
    artifacts,
    blockers,
    verification: {
      state: text(verification.status) || "unknown",
      criteria: [],
      evidence_paths: stringList(verification.evidence_paths),
      notes: stringList(verification.notes)
    },
    execution: {
      substrate: text(task.executor_kind) || null,
      requested_effect: null,
      task_ids: taskId ? [taskId] : [],
      batch_job_ids: batchJobId ? [batchJobId] : []
    },
    truth: {
      stale: explicitBoolean(result.stale, target.stale),
      outcome_uncertain: explicitBoolean(result.outcome_uncertain, result.reconciliation_required === true ? true : undefined),
      reconciliation_required: explicitBoolean(result.reconciliation_required)
    },
    history: [{ ts: text(task.created_at), kind: "created", text: `Created ${text(task.title) || "Operator task"}` }, ...events]
      .filter(event => event.ts)
      .sort((a, b) => a.ts.localeCompare(b.ts)),
    created_at: text(task.created_at),
    updated_at: text(task.updated_at),
    finished_at: text(task.finished_at) || null
  };
}

function mergeTaskIntoGoal(goal: AssignmentProjection, task: AssignmentProjection): AssignmentProjection {
  const taskHasDeterminateProgress = task.progress.determinate;
  const goalHasDeterminateProgress = goal.progress.determinate;
  return {
    ...goal,
    acceptance_criteria: unique([...goal.acceptance_criteria, ...task.acceptance_criteria]),
    target: {
      session_id: goal.target.session_id ?? task.target.session_id,
      thread_id: goal.target.thread_id ?? task.target.thread_id,
      model_id: goal.target.model_id ?? task.target.model_id,
      project_id: goal.target.project_id ?? task.target.project_id,
      executor_id: goal.target.executor_id ?? task.target.executor_id,
      document_fingerprint: goal.target.document_fingerprint ?? task.target.document_fingerprint,
      document_title: goal.target.document_title ?? task.target.document_title,
      document_path: goal.target.document_path ?? task.target.document_path
    },
    progress: !goalHasDeterminateProgress && taskHasDeterminateProgress ? task.progress : goal.progress,
    approvals: [...goal.approvals, ...task.approvals],
    effects: {
      create_count: goal.effects.create_count ?? task.effects.create_count,
      modify_count: goal.effects.modify_count ?? task.effects.modify_count,
      delete_count: goal.effects.delete_count ?? task.effects.delete_count,
      created_ids: unique([...goal.effects.created_ids, ...task.effects.created_ids]),
      modified_ids: unique([...goal.effects.modified_ids, ...task.effects.modified_ids]),
      deleted_ids: unique([...goal.effects.deleted_ids, ...task.effects.deleted_ids]),
      affected_categories: unique([...goal.effects.affected_categories, ...task.effects.affected_categories]),
      summary: goal.effects.summary ?? task.effects.summary
    },
    evidence: {
      entries: [...goal.evidence.entries, ...task.evidence.entries],
      artifact_paths: unique([...goal.evidence.artifact_paths, ...task.evidence.artifact_paths])
    },
    artifacts: [...new Map([...goal.artifacts, ...task.artifacts].map(artifact => [artifact.path, artifact])).values()],
    blockers: unique([...goal.blockers, ...task.blockers]),
    verification: goal.verification.state === "unknown" ? task.verification : goal.verification,
    execution: {
      substrate: goal.execution.substrate ?? task.execution.substrate,
      requested_effect: goal.execution.requested_effect ?? task.execution.requested_effect,
      task_ids: unique([...goal.execution.task_ids, ...task.execution.task_ids]),
      batch_job_ids: unique([...goal.execution.batch_job_ids, ...task.execution.batch_job_ids])
    },
    truth: {
      stale: truthMerge(goal.truth.stale, task.truth.stale),
      outcome_uncertain: truthMerge(goal.truth.outcome_uncertain, task.truth.outcome_uncertain),
      reconciliation_required: truthMerge(goal.truth.reconciliation_required, task.truth.reconciliation_required)
    },
    history: [...goal.history, ...task.history].sort((a, b) => a.ts.localeCompare(b.ts)),
    updated_at: goal.updated_at.localeCompare(task.updated_at) >= 0 ? goal.updated_at : task.updated_at,
    finished_at: goal.finished_at ?? task.finished_at
  };
}

export function buildAssignmentProjection(goals: GoalRecord[], tasks: JsonMap[]): AssignmentProjection[] {
  const projectedGoals = new Map(goals.map(goal => [goal.id, projectGoalAssignment(goal)]));
  const unboundTasks: AssignmentProjection[] = [];
  for (const task of tasks) {
    const projected = projectTaskAssignment(task);
    const goalId = taskGoalId(task);
    const goal = goalId ? projectedGoals.get(goalId) : undefined;
    if (goal) projectedGoals.set(goalId, mergeTaskIntoGoal(goal, projected));
    else unboundTasks.push(projected);
  }
  return [...projectedGoals.values(), ...unboundTasks]
    .sort((a, b) => `${b.updated_at}|${b.id}`.localeCompare(`${a.updated_at}|${a.id}`));
}

export function listAssignmentProjections(args: { limit?: number; session_id?: string; lifecycle?: string } = {}): AssignmentProjection[] {
  const limit = Math.max(1, Math.min(200, Math.trunc(args.limit ?? 50) || 50));
  const sessionId = text(args.session_id);
  const lifecycle = text(args.lifecycle).toLowerCase();
  return buildAssignmentProjection(listGoals(200), listOperatorTasks(200))
    .filter(assignment => !sessionId || assignment.target.session_id === sessionId)
    .filter(assignment => !lifecycle || assignment.lifecycle.phase === lifecycle)
    .slice(0, limit);
}

export function getAssignmentProjection(assignmentId: string): AssignmentProjection | null {
  const requested = text(assignmentId);
  if (!requested) return null;
  const explicitGoalId = requested.startsWith("goal:") ? requested.slice("goal:".length) : "";
  const explicitTaskId = requested.startsWith("task:") ? requested.slice("task:".length) : "";
  const goal = explicitTaskId ? null : getGoal(explicitGoalId || requested);
  if (goal) {
    const relatedTasks = listOperatorTasks(200).filter(task => taskGoalId(task) === goal.id);
    let assignment = projectGoalAssignment(goal);
    for (const relatedTask of relatedTasks) assignment = mergeTaskIntoGoal(assignment, projectTaskAssignment(relatedTask));
    return assignment;
  }
  const task = explicitGoalId ? null : getOperatorTask(explicitTaskId || requested);
  if (!task) return null;
  const relatedGoalId = taskGoalId(task);
  const relatedGoal = relatedGoalId ? getGoal(relatedGoalId) : null;
  return relatedGoal ? mergeTaskIntoGoal(projectGoalAssignment(relatedGoal), projectTaskAssignment(task)) : projectTaskAssignment(task);
}
