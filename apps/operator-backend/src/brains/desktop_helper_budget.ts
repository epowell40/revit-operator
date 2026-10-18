import type {AssignmentBindingV2,AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/index.js';
import {desktopHelperScopeForSnapshotV1} from '../assignments/desktop_executor_owner.js';
import {assignmentWorkBudgetStatusV2} from '../assignments/assignment_work_allowance_v2.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from '../assignments/assignment_kernel_v2_progress.js';

export type DesktopHelperCallLeaseV1={
 binding:AssignmentBindingV2;initial_call_ids:ReadonlySet<string>;initial_operation_ids:ReadonlySet<string>;
 initial_limit:number;granted_calls:number;warning_issued:boolean;warned_grant?:number;
};

/** A share of the existing task allowance, never a new provider allowance.
 * Leave the other half for the owner to inspect, correct, save or delegate a
 * different bounded step. Actual verified progress may fund both shares. */
export function desktopHelperCallGrantV1(remaining:number):number {
 if(!Number.isSafeInteger(remaining)||remaining<0)throw Error('desktop_helper_call_budget_invalid');
 return remaining===0?0:Math.max(1,Math.floor(remaining/2));
}
export function desktopHelperCallDecisionV1(used:number,grant:number,warned=false,warnedGrant=grant):'continue'|'warn'|'yield'{
 if(![used,grant,warnedGrant].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('desktop_helper_call_budget_invalid');
 // Even a small bounded save/read needs one useful tool call before its report.
 // Exhausted canonical budget is checked separately; no extra call is funded.
 if(grant===0||used>=Math.max(2,grant)||warned&&grant<=warnedGrant)return 'yield';
 return grant>=4&&used>=grant-2?'warn':'continue';
}
export function createDesktopHelperCallLeaseV1(snapshot:AssignmentSnapshotV2,marker:unknown):DesktopHelperCallLeaseV1|null {
 if(!desktopHelperScopeForSnapshotV1(snapshot,marker))return null;
 const calls=assignmentWorkBudgetStatusV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,new Date().toISOString()).resources.provider_calls;
 if(typeof calls.remaining!=='number'||!Number.isSafeInteger(calls.limit)||!Number.isSafeInteger(calls.remaining))return null;
 return {binding:structuredClone(snapshot.current_binding),initial_call_ids:new Set(Object.keys(snapshot.provider_calls)),
  initial_operation_ids:new Set(Object.keys(snapshot.operations)),initial_limit:calls.limit,
  granted_calls:desktopHelperCallGrantV1(calls.remaining),warning_issued:false};
}
export function desktopHelperLeaseDecisionV1(lease:DesktopHelperCallLeaseV1|null|undefined,snapshot:AssignmentSnapshotV2,marker:unknown):null|{
 decision:'continue'|'warn'|'yield';used_calls:number;granted_calls:number;remaining_parent_calls:number;
} {
 if(!lease||!sameAssignmentBindingV2(lease.binding,snapshot.current_binding)||!desktopHelperScopeForSnapshotV1(snapshot,marker))return null;
 const calls=assignmentWorkBudgetStatusV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,new Date().toISOString()).resources.provider_calls;
 if(typeof calls.remaining!=='number')return null;
 // Canonical exhaustion, pause, pending effects and user controls retain their
 // ordinary authority. A local handback cannot reopen or clear any of them.
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.execution_control?.state==='paused'
  ||snapshot.provider_usage_hold||snapshot.provider_budget_exhausted||snapshot.progress_blocker||snapshot.completion_proposal||snapshot.execution_failure_ids.length
  ||snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length
  ||snapshot.pending_input_variable_ids.length||snapshot.pending_review_ids.length||calls.remaining<=0)return null;
 const used=Object.keys(snapshot.provider_calls).filter(id=>!lease.initial_call_ids.has(id)).length;
 const grant=lease.granted_calls+Math.floor(Math.max(0,calls.limit-lease.initial_limit)/2);
 const decision=desktopHelperCallDecisionV1(used,grant,lease.warning_issued,lease.warned_grant??grant);
 return {decision,used_calls:used,granted_calls:grant,remaining_parent_calls:calls.remaining};
}

/** Host-assembled handback with references, not invented accomplishments.
 * It is safe to stop this helper; it does not mark parent work complete. */
export function desktopHelperBudgetReportV1(snapshot:AssignmentSnapshotV2,lease:DesktopHelperCallLeaseV1){
 const operations=Object.values(snapshot.operations).filter(op=>!lease.initial_operation_ids.has(op.operation_id)
  &&op.settlement_state==='settled'&&op.result?.status==='succeeded').slice(-5);
 return {claimed_completed:[],remaining_work:[
  'The scoped helper reached its share of the current call allowance. The desktop owner must inspect retained results and continue the remaining task, including verification and saving as needed.',
  ...operations.map(op=>`Retained operation ${op.operation_id}: ${op.request_identity?.path??op.capability_id}; effect ${op.persistent_effect}; evidence ${op.observation_ids.slice(-1).join(',')||'not available'}.`)
 ],uncertainties:[
  'This is a host-generated partial handback, not a helper completion report or native verification. No proposed tool action at this boundary was dispatched. Do not repeat applied or uncertain work.',
  'The parent task allowance, existing findings, unfinished work and all native/control fences remain unchanged.'
 ]};
}
