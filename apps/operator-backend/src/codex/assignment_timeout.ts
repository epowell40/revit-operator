import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/index.js';
import { validLocalAdvisoryPolicyV1 } from '../domain/assignment-kernel/execution_policy.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { assignmentActiveExecutionTimeMsV2 } from '../domain/assignment-kernel/progress/execution_time.js';
import { defaultAssignmentWorkBudgetV2 } from '../assignments/assignment_work_allowance_v2.js';
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from '../assignments/assignment_kernel_v2_progress.js';
import { resolveCodexTurnTimeoutMs } from './timeout_policy.js';

/** The provider wait must fit the remaining canonical work allowance. A new
 * turn or transport reconnect never gets a fresh assignment clock. This is a
 * transport deadline only; admission, receipts and native authority stay in
 * the assignment controller. Explicit operator timeout settings remain caps. */
export function codexAssignmentTurnTimeLimits(input: {
  snapshot?: AssignmentSnapshotV2 | null; now: string; configuredTimeout?: string;
}): { timeoutMs: number; maxWallMs: number } {
  const ordinary=resolveCodexTurnTimeoutMs(input.configuredTimeout);
  let wall=ordinary;
  const snapshot=input.snapshot;
  if(snapshot){
    if(snapshot.outcome!=='active' || snapshot.terminal
      || snapshot.unresolved_unknown_operation_ids.length>0
      || (snapshot.execution_control && snapshot.execution_control.state!=='running')
      || !validLocalAdvisoryPolicyV1(snapshot.spec)
      || !sameAssignmentBindingV2(snapshot.spec.binding,snapshot.current_binding)) {
      return {timeoutMs:0,maxWallMs:0};
    }
    const budget=defaultAssignmentWorkBudgetV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2);
    const charged=assignmentActiveExecutionTimeMsV2(snapshot,input.now);
    wall=Number.isFinite(charged)
      ? Math.max(0,Math.min(120*60_000,budget.max_wall_clock_ms)-charged) : 0;
    if(input.configuredTimeout!==undefined)wall=Math.min(wall,ordinary);
  }
  return {timeoutMs:Math.min(wall,10*60_000),maxWallMs:wall};
}
