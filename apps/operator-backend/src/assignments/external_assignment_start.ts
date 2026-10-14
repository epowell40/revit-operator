import { randomUUID } from "node:crypto";
import { assignmentKernelV2Enabled } from "../domain/assignment-kernel/index.js";
import type { GoalRecord } from "../goals/service.js";
import { createAssignmentKernelForGoalV2 } from "./assignment_kernel_v2_factory.js";
import { ensureAssignmentRunForTurn } from "./turn_journal.js";
import { classifyAutoGoalRequest } from "../goals/auto_goal.js";
import { assertConversationIntakeResolved, retainedIntakeDecision } from "../conversation_intake.js";
import { preparePdfWorkAllowance, type PdfWorkAllowanceV1 } from "./pdf_work_allowance.js";

/** The controller sends the user's request; the backend owns its effect contract. */
export function normalizeExternalAssignmentRequest(input: Record<string, unknown>): Record<string, unknown> {
  const budget = input.work_budget as Record<string, unknown> | undefined;
  if (input.start_assignment_run !== true || budget?.mode !== "sidecar_computer" || budget?.source !== "operator_desktop") return input;
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  const source = (typeof budget.source_user_request === "string" ? budget.source_user_request.trim() : "") || objective;
  if (!source || source !== objective) throw new Error("external_assignment_source_request_mismatch");
  const messageId = typeof budget.conversation_message_id === "string" ? budget.conversation_message_id.trim() : "";
  if (messageId) {
    const exact = { session_id: String(input.session_id ?? ""), message_id: messageId, user_text: source };
    assertConversationIntakeResolved(exact);
    const decision = retainedIntakeDecision(exact);
    if (!decision || decision.route === "answer" || !decision.operation_scope)
      throw new Error("external_assignment_semantic_scope_required");
    return { ...input, work_budget: { ...budget, source_user_request: source,
      requested_effect: decision.operation_scope.requested_effect } };
  }
  return { ...input, work_budget: { ...budget, source_user_request: source, requested_effect: classifyAutoGoalRequest(source).requestedEffect } };
}

export type ExternalAssignmentRunBinding = Readonly<{
  assignmentId: string;
  runId: string;
  generation: number;
  kernelVersion: 1 | 2;
}>;

/** Trusted external-controller edge. V2 and V1 are mutually exclusive writes. */
export function startExternalAssignmentRun(input: Readonly<{
  goal: GoalRecord;
  sessionId: string;
  requestedRunId?: string;
  actor: string;
  source_work_allowance?: PdfWorkAllowanceV1;
}>): ExternalAssignmentRunBinding {
  const runId = input.requestedRunId?.trim() || `external:${randomUUID()}`;
  if (assignmentKernelV2Enabled()) {
    const binding = createAssignmentKernelForGoalV2({
      goal: input.goal,
      run_id: runId,
      source_work_allowance: input.source_work_allowance,
      document_fingerprint: typeof input.goal.work_budget?.document_fingerprint === "string"
        ? input.goal.work_budget.document_fingerprint
        : undefined
    });
    return {
      assignmentId: binding.assignment_id,
      runId: binding.run_id,
      generation: binding.generation,
      kernelVersion: 2
    };
  }
  const legacy = ensureAssignmentRunForTurn(input.sessionId, runId, input.actor, false);
  if (!legacy) throw new Error("assignment_run_creation_failed");
  return { ...legacy, kernelVersion: 1 };
}

/** Resolve the exact source allowance before creating an external assignment. */
export async function prepareExternalAssignmentRequest(input: Record<string,unknown>) {
  const normalizedRequest=normalizeExternalAssignmentRequest(input);
  const sourceAllowance=await preparePdfWorkAllowance(normalizedRequest);
  return {normalizedRequest,sourceAllowance};
}
