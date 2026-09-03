import { createHash } from "node:crypto";
import {
  ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA,
  canonicalJsonV2,
  executionFailureCodeV2,
  type AssignmentBindingV2,
  type AssignmentSnapshotV2,
  type ExecutionFailureClassV2,
  type ExecutionFailurePhaseV2
} from "../domain/assignment-kernel/index.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { deriveAndSettleAssignmentKernelV2 } from "./assignment_kernel_v2_lifecycle.js";
import {
  advanceAssignmentKernelProgressV2,
  evaluatePendingAssignmentCriteriaV2
} from "./assignment_kernel_v2_progress.js";
import { appendCurrentAssignmentKernelEventV2 } from "./assignment_kernel_v2_store.js";

export type AssignmentKernelExecutionFailureDispositionV2 =
  | "terminal_failure"
  | "terminal_preserved"
  | "recovery_pending";

export type AssignmentKernelExecutionFailureSettlementV2 = Readonly<{
  disposition: AssignmentKernelExecutionFailureDispositionV2;
  snapshot: AssignmentSnapshotV2;
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonV2(value), "utf8").digest("hex");
}

function terminalSuccess(snapshot: AssignmentSnapshotV2): boolean {
  return ["complete", "complete_with_issues", "verified_noop"].includes(snapshot.outcome);
}

function terminalOutcome(snapshot: AssignmentSnapshotV2): boolean {
  return ["complete", "complete_with_issues", "verified_noop", "blocked", "failed"].includes(snapshot.outcome);
}

function boundedFailureId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(id)) {
    throw new Error("assignment_kernel_v2_execution_failure_identity_invalid");
  }
  return id;
}

/**
 * Classifies orchestration infrastructure state only. Raw exceptions remain in
 * diagnostic logs and never become semantic task evidence.
 */
export function classifyAssignmentKernelExecutionFailureV2(
  error: unknown,
  options: Readonly<{ canceled?: boolean; runtime?: boolean }> = {}
): ExecutionFailureClassV2 {
  if (options.canceled) return "canceled";
  if (options.runtime) return "runtime";
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:429|quota|rate[ -]?limit|resource exhausted|insufficient capacity)\b/i.test(message)) {
    return "resource_exhausted";
  }
  if (/\b(?:timeout|timed out|deadline|econn\w*|enotfound|socket|network|transport|websocket|http\s*[45]\d\d|status\s*[45]\d\d)\b/i.test(message)) {
    return "transport";
  }
  return "provider";
}

/**
 * Records an authenticated execution-boundary failure against one exact V2
 * binding. Existing task evidence is evaluated first. In-flight operations
 * and unknown effects remain authoritative and must settle or reconcile before
 * this failure can terminalize the Assignment.
 */
export function settleAssignmentKernelExecutionFailureV2(input: Readonly<{
  binding: AssignmentBindingV2;
  failure_id: string;
  error_class: ExecutionFailureClassV2;
  phase: ExecutionFailurePhaseV2;
  occurred_at?: string;
}>): AssignmentKernelExecutionFailureSettlementV2 {
  const resolved = assignmentKernelV2ForBinding({
    session_id: input.binding.session_id,
    assignment_id: input.binding.assignment_id,
    run_id: input.binding.run_id,
    generation: input.binding.generation
  });
  if (!resolved) throw new Error("assignment_kernel_v2_execution_failure_binding_stale_or_mismatched");
  let snapshot = resolved.snapshot;
  const failureId = boundedFailureId(input.failure_id);
  const retained = snapshot.execution_failures[failureId];
  if (retained) {
    if (retained.error_class !== input.error_class || retained.phase !== input.phase) {
      throw new Error("assignment_kernel_v2_execution_failure_identity_conflict");
    }
    if (snapshot.terminal) return { disposition: "terminal_preserved", snapshot };
    if (snapshot.quiescent && terminalOutcome(snapshot)) {
      snapshot = deriveAndSettleAssignmentKernelV2(snapshot.current_binding, retained.code);
      return {
        disposition: snapshot.terminal ? "terminal_preserved" : "recovery_pending",
        snapshot
      };
    }
    const replayed = advanceAssignmentKernelProgressV2({
      binding: snapshot.current_binding,
      now: input.occurred_at
    });
    return {
      disposition: replayed.snapshot.terminal ? "terminal_preserved" : "recovery_pending",
      snapshot: replayed.snapshot
    };
  }
  if (snapshot.terminal) return { disposition: "terminal_preserved", snapshot };

  if (snapshot.quiescent) {
    snapshot = evaluatePendingAssignmentCriteriaV2({ binding: snapshot.current_binding, now: input.occurred_at });
    if (snapshot.terminal) return { disposition: "terminal_preserved", snapshot };
    if (terminalSuccess(snapshot)) {
      snapshot = deriveAndSettleAssignmentKernelV2(snapshot.current_binding, "terminal_outcome_derived_before_execution_failure");
      return {
        disposition: snapshot.terminal ? "terminal_preserved" : "recovery_pending",
        snapshot
      };
    }
    if (terminalOutcome(snapshot)) {
      const retainedFailureId = snapshot.execution_failure_ids.at(-1);
      const retainedFailure = retainedFailureId ? snapshot.execution_failures[retainedFailureId] : undefined;
      snapshot = deriveAndSettleAssignmentKernelV2(
        snapshot.current_binding,
        retainedFailure?.code ?? "terminal_outcome_derived_before_execution_failure"
      );
      return {
        disposition: snapshot.terminal ? "terminal_preserved" : "recovery_pending",
        snapshot
      };
    }
  }

  const failure = {
    schema: ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA,
    failure_id: failureId,
    binding: structuredClone(snapshot.current_binding),
    error_class: input.error_class,
    phase: input.phase,
    code: executionFailureCodeV2(input.error_class)
  } as const;
  snapshot = appendCurrentAssignmentKernelEventV2({
    goal_id: snapshot.current_binding.assignment_id,
    binding: snapshot.current_binding,
    event_id: `execution-failure:${digest({ binding: snapshot.current_binding, failure_id: failureId })}`,
    actor: "assignment-execution-controller",
    occurred_at: input.occurred_at,
    body: { event_type: "execution_failure_recorded", failure }
  }).snapshot;

  if (terminalOutcome(snapshot)) {
    snapshot = deriveAndSettleAssignmentKernelV2(snapshot.current_binding, failure.code);
    return {
      disposition: snapshot.terminal ? "terminal_failure" : "recovery_pending",
      snapshot
    };
  }
  const advanced = advanceAssignmentKernelProgressV2({
    binding: snapshot.current_binding,
    now: input.occurred_at
  });
  snapshot = advanced.snapshot;
  return {
    disposition: snapshot.terminal ? "terminal_failure" : "recovery_pending",
    snapshot
  };
}
