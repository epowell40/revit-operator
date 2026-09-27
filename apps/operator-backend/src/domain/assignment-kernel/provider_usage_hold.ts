import { kernelAssertV2 } from "./errors.js";
import { advisoryVerificationV2, validLocalAdvisoryPolicyV1 } from "./execution_policy.js";
import { sameAssignmentBindingV2, type AssignmentBindingV2 } from "./identity.js";
import { deriveAssignmentOutcomeV2 } from "./outcome.js";
import { assignmentProgressBudgetBlockerV2 } from "./progress/controller.js";
import type { AssignmentProgressBudgetV2 } from "./progress/contracts.js";
import type { AssignmentEventV2 } from "./events.js";
import type { OperationV2 } from "./operation.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";

export const PROVIDER_USAGE_HOLD_V1_SCHEMA = "revit-operator.provider-usage-hold/v1" as const;

export interface ProviderUsageWorkerIdentityV1 {
  provider: "openai_codex";
  configured_billing_mode: "chatgpt" | "api_key" | "unknown";
  requested_model: string | null;
  requested_reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  reported_model: string | null;
  reported_model_source: "raw_response" | "rerouted" | null;
}

export interface ProviderUsageHoldV1 {
  schema: typeof PROVIDER_USAGE_HOLD_V1_SCHEMA;
  hold_id: string;
  binding: AssignmentBindingV2;
  attempt_id: string;
  provider_thread_id: string;
  provider_turn_id: string;
  code: "usageLimitExceeded";
  recorded_at: string;
  /** Host-captured allowance, never supplied by a model or Resume request. */
  resume_budget: AssignmentProgressBudgetV2;
  worker_identity?: ProviderUsageWorkerIdentityV1;
}

const budgetKeys = ["max_reasoning_turns", "max_provider_calls", "max_operations", "max_equivalent_operations",
  "max_no_progress_epochs", "max_reconciliation_attempts", "max_wall_clock_ms", "max_total_tokens"] as const;
const identityKeys = ["provider", "configured_billing_mode", "requested_model", "requested_reasoning_effort", "reported_model", "reported_model_source"];
const bindingKeys = ["assignment_id", "run_id", "generation", "session_id", "principal_id", "document_fingerprint"];
const holdKeys = ["schema", "hold_id", "binding", "attempt_id", "provider_thread_id", "provider_turn_id", "code", "recorded_at", "resume_budget", "worker_identity"];
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: unknown, keys: readonly string[]) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const bounded = (value: unknown, max = 240): value is string => typeof value === "string" && value.length > 0
  && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const model = (value: unknown) => value === null || (bounded(value, 160) && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value));

export function validProviderUsageWorkerIdentityV1(value: unknown): value is ProviderUsageWorkerIdentityV1 {
  if (!onlyKeys(value, identityKeys)) return false;
  const identity = value as unknown as ProviderUsageWorkerIdentityV1;
  return identity.provider === "openai_codex" && ["chatgpt", "api_key", "unknown"].includes(identity.configured_billing_mode)
    && model(identity.requested_model) && model(identity.reported_model)
    && (identity.requested_reasoning_effort === null || ["none", "low", "medium", "high", "xhigh", "max"].includes(identity.requested_reasoning_effort))
    && (identity.reported_model === null ? identity.reported_model_source === null
      : identity.reported_model_source === "raw_response" || identity.reported_model_source === "rerouted");
}

export function validateProviderUsageHoldV1(snapshot: AssignmentSnapshotV2,
  event: Extract<AssignmentEventV2, { event_type: "provider_usage_hold_recorded" }>): void {
  const hold = event.hold;
  kernelAssertV2(event.actor === "assignment-execution-controller", "provider_usage_hold_authority_invalid", "A provider usage hold requires the execution controller.");
  kernelAssertV2(onlyKeys(hold, holdKeys) && hold.schema === PROVIDER_USAGE_HOLD_V1_SCHEMA && hold.code === "usageLimitExceeded",
    "provider_usage_hold_invalid", "A hold requires the exact typed provider usage contract.");
  kernelAssertV2(bounded(hold.hold_id) && bounded(hold.attempt_id) && bounded(hold.provider_thread_id) && bounded(hold.provider_turn_id),
    "provider_usage_hold_identity_invalid", "A hold requires bounded exact attempt and provider identities.");
  kernelAssertV2(onlyKeys(hold.binding, bindingKeys) && sameAssignmentBindingV2(snapshot.current_binding, hold.binding),
    "provider_usage_hold_binding_mismatch", "A hold must retain the current assignment, run, owner and document binding.");
  kernelAssertV2(hold.recorded_at === event.occurred_at && Number.isFinite(Date.parse(hold.recorded_at)),
    "provider_usage_hold_time_invalid", "A hold must retain its journal observation time.");
  kernelAssertV2(onlyKeys(hold.resume_budget, budgetKeys) && budgetKeys.every(key => Number.isSafeInteger(hold.resume_budget[key])
    && hold.resume_budget[key] > 0 && hold.resume_budget[key] <= 2_147_483_647),
    "provider_usage_hold_budget_invalid", "A hold requires the bounded host-captured allowance.");
  kernelAssertV2(hold.worker_identity === undefined || validProviderUsageWorkerIdentityV1(hold.worker_identity),
    "provider_usage_hold_worker_identity_invalid", "Worker identity must contain only bounded non-secret display metadata.");
  kernelAssertV2(!snapshot.provider_usage_hold, "provider_usage_hold_already_active", "An active hold cannot be silently replaced.");
}

export function assertProviderUsageOperationAdmissionV1(snapshot: AssignmentSnapshotV2, operation: OperationV2): void {
  if (!snapshot.provider_usage_hold || operation.parent_operation_id) return;
  const prior = operation.reconciliation_of_operation_id ? snapshot.operations[operation.reconciliation_of_operation_id] : undefined;
  kernelAssertV2(operation.requested_effect === "read" && operation.purpose === "reconciliation"
    && prior?.persistent_effect === "unknown" && sameAssignmentBindingV2(prior.binding, snapshot.current_binding),
    "assignment_provider_usage_held", "A usage hold admits only exact read-only reconciliation or already-authorized children.");
}

export function assertProviderUsageResumeV1(snapshot: AssignmentSnapshotV2,
  event: Extract<AssignmentEventV2, { event_type: "execution_control_requested" }>): void {
  const hold = snapshot.provider_usage_hold;
  if (!hold) {
    kernelAssertV2(event.expected_hold_id == null, "provider_usage_resume_hold_stale", "The expected usage hold is no longer active.");
    return;
  }
  kernelAssertV2(event.expected_hold_id === hold.hold_id, "provider_usage_resume_hold_stale", "Resume must name the exact current usage hold.");
  kernelAssertV2(Number.isSafeInteger(event.expected_assignment_version) && event.expected_assignment_version === event.assignment_version - 1,
    "provider_usage_resume_version_stale", "Resume must match the exact reviewed assignment version.");
  kernelAssertV2(sameAssignmentBindingV2(hold.binding, snapshot.current_binding), "provider_usage_resume_binding_stale", "A hold cannot resume another run or document.");
  kernelAssertV2(snapshot.quiescent && snapshot.in_flight_operation_ids.length === 0 && snapshot.in_flight_provider_call_ids.length === 0,
    "assignment_resume_not_quiescent", "Admitted work must settle before resuming.");
  kernelAssertV2(snapshot.unresolved_unknown_operation_ids.length === 0, "assignment_resume_reconciliation_required", "Unknown effects must be reconciled before resuming.");
  kernelAssertV2(snapshot.pending_input_variable_ids.length === 0 && snapshot.pending_review_ids.length === 0 && !snapshot.completion_proposal,
    "provider_usage_resume_input_or_review_pending", "Required input and review must be resolved first.");
  kernelAssertV2(!snapshot.progress_blocker && !snapshot.provider_budget_exhausted && snapshot.execution_failure_ids.length === 0,
    "provider_usage_resume_execution_blocked", "Resume cannot clear a separate failure or budget stop.");
  const outcome = deriveAssignmentOutcomeV2({ ...snapshot, provider_usage_hold: undefined });
  kernelAssertV2(!["awaiting_user_input", "awaiting_user_review", "blocked", "failed"].includes(outcome),
    "provider_usage_resume_execution_blocked", "The retained task still has execution prerequisites.");
  const exhausted = assignmentProgressBudgetBlockerV2(snapshot, hold.resume_budget, event.occurred_at);
  kernelAssertV2(!exhausted, "provider_usage_resume_budget_exhausted", "Resume retains the frozen cumulative task allowance.");
  if (advisoryVerificationV2(snapshot)) {
    const policy = snapshot.spec.execution_policy!;
    kernelAssertV2(validLocalAdvisoryPolicyV1(snapshot.spec), "provider_usage_resume_policy_invalid", "Resume requires the unchanged creation-time policy.");
    const original = { ...hold.resume_budget, max_provider_calls: policy.max_provider_calls, max_reasoning_turns: policy.max_provider_calls,
      max_operations: policy.max_operations, max_total_tokens: policy.max_total_tokens, max_wall_clock_ms: policy.max_wall_clock_ms };
    kernelAssertV2(!assignmentProgressBudgetBlockerV2(snapshot, original, event.occurred_at),
      "provider_usage_resume_budget_exhausted", "Resume cannot exceed the original advisory policy.");
  }
}

export function applyAssignmentExecutionControlV2(snapshot: AssignmentSnapshotV2,
  event: Extract<AssignmentEventV2, { event_type: "execution_control_requested" }>): AssignmentSnapshotV2 {
  kernelAssertV2(event.actor === "authenticated-user", "assignment_control_authority_invalid", "Execution controls require an authenticated user.");
  kernelAssertV2(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(event.command_id), "assignment_control_identity_invalid", "Execution controls require a bounded command identity.");
  kernelAssertV2(event.expected_command_id === (snapshot.execution_control?.command_id ?? null), "assignment_control_stale", "Execution control changed since this command was prepared.");
  kernelAssertV2(event.action === "pause" || event.action === "resume", "assignment_control_action_invalid", "Unknown execution control.");
  if (event.action === "resume") {
    kernelAssertV2(snapshot.quiescent, "assignment_resume_not_quiescent", "Admitted work must settle before resuming.");
    kernelAssertV2(snapshot.unresolved_unknown_operation_ids.length === 0, "assignment_resume_reconciliation_required", "Unknown effects must be reconciled before resuming ordinary work.");
    assertProviderUsageResumeV1(snapshot, event);
  }
  return { ...snapshot, ...(event.action === "resume" && snapshot.provider_usage_hold ? { provider_usage_hold: undefined } : {}),
    execution_control: { state: event.action === "pause" ? "paused" : "running", command_id: event.command_id, changed_at: event.occurred_at } };
}
