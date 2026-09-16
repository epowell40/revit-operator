import { randomUUID } from "node:crypto";
import { type GoalRecord, transitionGoal } from "../goals/service.js";
import { getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";
import { controlAssignmentExecutionV2 } from "./assignment_kernel_v2_controls.js";

/** Suspend an idle automatic task without canceling its evidence or objective. */
export function pauseAutomaticAssignmentForNewRequest(goal: GoalRecord): void {
  const snapshot = getAssignmentKernelSnapshotV2(goal.id);
  if (snapshot) {
    if (snapshot.in_flight_operation_ids.length || snapshot.in_flight_provider_call_ids.length
      || snapshot.unresolved_unknown_operation_ids.length) {
      throw new Error("The earlier task still has work running or an unconfirmed model change. Let it finish or reconcile that result before starting another model task.");
    }
    if (snapshot.terminal || snapshot.execution_control?.state === "paused") return;
    controlAssignmentExecutionV2({ binding: snapshot.current_binding,
      command_id: `new-request:${randomUUID()}`,
      expected_command_id: snapshot.execution_control?.command_id ?? null, action: "pause" });
    return;
  }
  if (goal.status === "active") transitionGoal(goal.id, "paused", "Saved while a new automatic request is handled.");
}
