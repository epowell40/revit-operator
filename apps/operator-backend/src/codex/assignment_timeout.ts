import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/index.js';
import { validLocalAdvisoryPolicyV1 } from '../domain/assignment-kernel/execution_policy.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { assignmentActiveExecutionTimeMsV2 } from '../domain/assignment-kernel/progress/execution_time.js';
import { defaultAssignmentWorkBudgetV2 } from '../assignments/assignment_work_allowance_v2.js';
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from '../assignments/assignment_kernel_v2_progress.js';
import { resolveCodexTurnTimeoutMs } from './timeout_policy.js';
import { canonicalJsonV2 } from '../domain/assignment-kernel/canonical.js';

/** The provider wait must fit the remaining canonical work allowance. A new
 * turn or transport reconnect never gets a fresh assignment clock. This is a
 * transport deadline only; admission, receipts and native authority stay in
 * the assignment controller. Explicit operator timeout settings remain caps. */
export function codexAssignmentTurnTimeLimits(input: {
  snapshot?: AssignmentSnapshotV2 | null; now: string; configuredTimeout?: string;
}): { timeoutMs: number; maxWallMs: number; progressWallCeilingMs?: number } {
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
  const ceiling=snapshot?.spec.execution_policy?.progress_allowance?.max_wall_clock_ms;
  const charged=snapshot?assignmentActiveExecutionTimeMsV2(snapshot,input.now):0;
  const hard=ceiling===undefined?undefined:Math.max(0,Math.min(ceiling-charged,
    input.configuredTimeout===undefined?Infinity:ordinary));
  return {timeoutMs:Math.min(wall,10*60_000),maxWallMs:wall,
    ...(hard===undefined?{}:{progressWallCeilingMs:hard})};
}

/** Transport-time projection only. Native authority, Pause, unknown effects and
 * completion remain with the controller. The current provider turn is active
 * even before its next usage receipt arrives; reconnect cannot reset its age. */
export function createCodexAssignmentProgressTimeMonitor(input:{
 initial:AssignmentSnapshotV2|null|undefined;readCurrent:()=>AssignmentSnapshotV2|null|undefined;
 startedAt:string;now?:()=>string;
}):(()=>number)|undefined {
 const initial=input.initial;
 if(initial?.spec.execution_policy?.progress_allowance?.max_wall_clock_ms===undefined)return undefined;
 const started=Date.parse(input.startedAt),charged=assignmentActiveExecutionTimeMsV2(initial,input.startedAt);
 const policy=canonicalJsonV2(initial.spec.execution_policy),binding=structuredClone(initial.current_binding);
 return ()=>{
  const current=input.readCurrent(),now=(input.now??(()=>new Date().toISOString()))(),at=Date.parse(now);
  if(!current||!validLocalAdvisoryPolicyV1(current.spec)||!sameAssignmentBindingV2(binding,current.current_binding)
    ||!sameAssignmentBindingV2(current.spec.binding,current.current_binding)
    ||canonicalJsonV2(current.spec.execution_policy)!==policy||!Number.isFinite(started)||!Number.isFinite(at)
    ||!Number.isFinite(charged)||at<started)return 0;
  const used=Math.max(assignmentActiveExecutionTimeMsV2(current,now),charged+at-started);
  const limit=defaultAssignmentWorkBudgetV2(current,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2).max_wall_clock_ms;
  return Number.isFinite(used)?Math.max(0,limit-used):0;
 };
}
