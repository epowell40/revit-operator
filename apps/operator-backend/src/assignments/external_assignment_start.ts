import { randomUUID } from "node:crypto";
import { assignmentKernelV2Enabled } from "../domain/assignment-kernel/index.js";
import type { GoalRecord } from "../goals/service.js";
import { createAssignmentKernelForGoalV2 } from "./assignment_kernel_v2_factory.js";
import { ensureAssignmentRunForTurn } from "./turn_journal.js";

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
}>): ExternalAssignmentRunBinding {
  const runId = input.requestedRunId?.trim() || `external:${randomUUID()}`;
  if (assignmentKernelV2Enabled()) {
    const binding = createAssignmentKernelForGoalV2({
      goal: input.goal,
      run_id: runId,
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
