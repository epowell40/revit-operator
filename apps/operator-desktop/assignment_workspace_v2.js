import {
  parseAssignmentKernelPublicationV2,
  parseAssignmentKernelSessionIndexResponseV2
} from "@revitoperator/assignment-kernel-v2-contracts";
import { assignmentInputMetadata } from "./assignment_input_controls.mjs";
import { checkpointResourceRenewalAvailable } from "./public/checkpoint_followup.mjs";
import { advisoryWorkPlanDisplay } from './advisory_progress.mjs';

// A small, disposable display model. All lifecycle and evidence values come
// from the exact publication; this adapter never reads or writes legacy Goals.
export function assignmentWorkspaceGoalV2(raw) {
  const publication = parseAssignmentKernelPublicationV2(raw);
  const snapshot = publication.snapshot;
  const advisoryPlan = advisoryWorkPlanDisplay(snapshot);
  const spec = snapshot.spec;
  if (!spec || !Array.isArray(spec.criteria) || !Array.isArray(spec.work_units)
      || typeof spec.source_user_request !== "string" || !snapshot.work_unit_states) {
    throw new Error("Canonical assignment display fields are missing.");
  }
  const binding = snapshot.current_binding;
  const outcome = snapshot.outcome;
  const hold = !snapshot.terminal ? snapshot.provider_usage_hold : undefined;
  const heldBlocker = Boolean(hold && (["blocked", "failed"].includes(outcome) || snapshot.progress_blocker
    || snapshot.provider_budget_exhausted || snapshot.execution_failure_ids?.length));
  const unknown = (snapshot.unresolved_unknown_operation_ids || []).length > 0;
  const phase = hold && unknown ? "outcome_uncertain" : !snapshot.terminal && snapshot.execution_control?.state === "paused"
    ? snapshot.quiescent ? "paused" : "pausing"
    : hold ? !snapshot.quiescent ? "stopping_after_usage_limit" : heldBlocker ? outcome === "failed" ? "failed" : "blocked" : "waiting_for_usage"
    : outcome === "verified_noop" ? "complete" : outcome;
  const criteria = Object.values(snapshot.criteria || {});
  const operations = Object.values(snapshot.operations || {});
  const observations = Object.values(snapshot.observations || {});
  const updatedAt = [spec.created_at, snapshot.finished_at, snapshot.execution_control?.changed_at, hold?.recorded_at,
    ...criteria.map(item => item.evaluated_at),
    ...Object.values(snapshot.provider_calls).flatMap(item => [item.admitted_at, item.completed_at])
  ].filter(value => typeof value === "string").sort().at(-1) || spec.created_at;
  const worker = hold?.worker_identity;
  const account = worker?.configured_billing_mode === "chatgpt" ? "configured ChatGPT sign-in"
    : worker?.configured_billing_mode === "api_key" ? "configured API-key login" : "unconfirmed account mode";
  const holdSummary = hold ? `Usage limit reached for this worker's ${account}. Task state is retained; model changes may be unsaved.`
    + (unknown ? " Check uncertain model changes before continuing." : !snapshot.quiescent ? " Waiting for admitted work to settle."
      : heldBlocker ? " A separate task issue must be resolved before this work can continue."
      : snapshot.execution_control?.state === "paused" ? " The task is also paused. Use Resume when usage is available." : " Use Resume when usage is available.") : "";
  const summary = snapshot.terminal_reason || holdSummary || ({
    outcome_uncertain: "A model result needs checking before continuing.",
    paused: "Task paused. Completed work and unanswered questions are saved.",
    pausing: "Pausing after admitted work settles. No new work will start.",
    awaiting_user_input: "Waiting for your input.",
    awaiting_user_review: "Waiting for your review.",
    active: "Working toward the requested outcome."
  })[phase] || outcome;
  return {
    id: `goal:${publication.assignment_id}`,
    title: spec.source_user_request.slice(0, 180),
    objective: spec.source_user_request,
    status: phase,
    created_at: spec.created_at,
    updated_at: updatedAt,
    related_session_id: binding.session_id,
    acceptance_criteria: spec.criteria.map(item => item.requirement),
    current_phase: phase,
    current_step: summary,
    progress_summary: summary,
    work_items: advisoryPlan?.items ?? spec.work_units.filter(item => !(spec.requested_effect === "apply"
      && item.work_unit_id === "work-preview"
      && !operations.some(operation => operation.work_unit_id === item.work_unit_id)
      && !(snapshot.pending_review_ids || []).length
      && !["active", "blocked", "failed", "awaiting_user_review"].includes(snapshot.work_unit_states[item.work_unit_id])
    )).map(item => ({
      id: item.work_unit_id,
      title: item.title || (item.work_unit_id === "work-primary" ? "Perform the requested work"
        : item.work_unit_id === "work-evidence" ? "Verify the result" : item.work_unit_id),
      status: snapshot.work_unit_states[item.work_unit_id] === "active" ? "in_progress"
        : snapshot.work_unit_states[item.work_unit_id] || "pending",
      depends_on: item.dependency_ids || []
    })),
    action_log: operations.map(item => ({ summary: item.capability_id, ts: item.admitted_at })),
    evidence_log: observations.map(item => ({ summary: item.observation_id, ts: item.observed_at })),
    validation_log: criteria.map(item => ({ summary: `${item.status}: ${item.reason}`, ts: item.evaluated_at })),
    blocker: ["blocked", "failed"].includes(outcome) ? summary : "",
    _assignmentPhase: phase,
    // Legacy goal controls mutate legacy status, not the V2 journal. Never
    // expose them as canonical pause/resume/audit controls.
    _sourceKind: "assignment_kernel_v2",
    _sourceRecordId: publication.assignment_id,
    _assignmentVersion: publication.assignment_version,
    _bindingV2: { assignment_id: binding.assignment_id, session_id: binding.session_id, run_id: binding.run_id, generation: binding.generation },
    _executionControl: snapshot.execution_control || null,
    _providerUsageHold: hold || null,
    _canRenewResources: checkpointResourceRenewalAvailable(snapshot, publication.supports_explicit_resource_renewal_v1),
    _resourceRenewalAddsTime: publication.supports_active_time_renewal_v1 === true,
    _canResume: !snapshot.terminal && !heldBlocker && snapshot.quiescent && !(snapshot.unresolved_unknown_operation_ids || []).length && !snapshot.pending_input_variable_ids.length && !snapshot.pending_review_ids.length,
    _canPause: !snapshot.terminal && snapshot.execution_control?.state !== "paused",
    _canRecover: !snapshot.terminal && (snapshot.in_flight_operation_ids || []).length > 0,
    _pendingInputs: Object.values(snapshot.clarifications || {}).filter(item => !item.resolved_at).map(item => ({
      clarification_id: item.clarification_id, variable_id: item.variable_id, question: item.question,
      ...(typeof item.work_summary === "string" && item.work_summary ? {work_summary: item.work_summary} : {}),
      ...assignmentInputMetadata(spec, item.variable_id)
    })),
    _projection: {
      ...(advisoryPlan?{progress:advisoryPlan.progress}:{}),
      target: { session_id: binding.session_id, document_fingerprint: binding.document_fingerprint },
      truth: {
        outcome_uncertain: (snapshot.unresolved_unknown_operation_ids || []).length > 0,
        reconciliation_required: (snapshot.unresolved_unknown_operation_ids || []).length > 0
      },
      execution: { requested_effect: spec.requested_effect }
    }
  };
}

export async function readAssignmentWorkspaceV2(readJson, sessionId, limit = 30) {
  const session = `${sessionId || ""}`.trim();
  if (!session) throw Object.assign(new Error("session_id is required."), { status: 400 });
  const count = Math.max(1, Math.min(30, Number.parseInt(`${limit}`, 10) || 30));
  const response = parseAssignmentKernelSessionIndexResponseV2(await readJson(
    `/api/assignments/v2?limit=${count}&session_id=${encodeURIComponent(session)}`, { method: "GET" }
  ));
  const index = response.assignment_kernel_v2_session_index;
  if (index.session_id !== session) throw new Error("Canonical assignment session mismatch.");
  const assignments = [];
  // Keep publication reads bounded; large evidence payloads never reach the UI.
  for (let offset = 0; offset < index.assignments.length; offset += 4) {
    assignments.push(...await Promise.all(index.assignments.slice(offset, offset + 4).map(async entry => {
      const exact = await readJson(`/api/assignments/v2/${encodeURIComponent(entry.assignment_id)}`, { method: "GET" });
      const publication = parseAssignmentKernelPublicationV2(exact.assignment_kernel_v2);
      const binding = publication.snapshot.current_binding;
      if (publication.assignment_id !== entry.assignment_id || binding.session_id !== session
          || binding.principal_id !== entry.binding.principal_id
          || binding.generation < entry.binding.generation
          || (binding.generation === entry.binding.generation && binding.run_id !== entry.binding.run_id)
          || publication.assignment_version < entry.assignment_version) {
        throw new Error("Canonical assignment publication mismatch.");
      }
      return assignmentWorkspaceGoalV2(publication);
    })));
  }
  return { ok: true, session_id: session, assignments };
}
