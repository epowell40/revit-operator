import type {AssignmentBindingV2,AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {sameAssignmentBindingV2,assignmentConsecutiveNoProgressEpochsV2} from '../domain/assignment-kernel/index.js';
import {advisoryVerificationV2} from '../domain/assignment-kernel/execution_policy.js';
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
 decision:'continue'|'warn'|'yield';used_calls:number;granted_calls:number;remaining_parent_calls:number;reason?:'inspection_handoff';
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
 // Return findings, not a success verdict, before another supporting read uses
 // the final no-progress slot needed by the desktop owner's actual inspection.
 // The existing canonical controller still owns exhaustion and completion.
 if(used>0&&desktopHelperInspectionHandoffV1(snapshot))return {decision:'yield',used_calls:used,granted_calls:grant,
  remaining_parent_calls:calls.remaining,reason:'inspection_handoff'};
 const decision=desktopHelperCallDecisionV1(used,grant,lease.warning_issued,lease.warned_grant??grant);
 return {decision,used_calls:used,granted_calls:grant,remaining_parent_calls:calls.remaining};
}

/** A conservative handback boundary, never native/visual verification. */
export function desktopHelperInspectionHandoffV1(snapshot:AssignmentSnapshotV2):boolean {
 const budget=DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,streak=assignmentConsecutiveNoProgressEpochsV2(snapshot);
 if(advisoryVerificationV2(snapshot)||snapshot.spec.requested_effect!=='apply'||snapshot.spec.work_plan_required!==true
  ||snapshot.terminal||snapshot.outcome!=='active'||snapshot.execution_control?.state==='paused'
  ||snapshot.provider_usage_hold||snapshot.provider_budget_exhausted||snapshot.progress_blocker||snapshot.completion_proposal
  ||snapshot.execution_failure_ids.length||snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length
  ||snapshot.pending_input_variable_ids.length||snapshot.pending_review_ids.length
  ||snapshot.quiescent!==true||snapshot.in_flight_provider_call_ids.length
  ||streak!==budget.max_no_progress_epochs-1)return false;
 const items=snapshot.work_plan?.items;
 if(!Array.isArray(items)||items.some(i=>i.deferrals?.some((d:{resumed_at?:string})=>!d.resumed_at)))return false;
 const pending=items.filter(i=>!i.completed_at),edits=items.filter(i=>i.kind==='edit');
 if(pending.length!==1||pending[0].kind!=='inspection'||!edits.length||edits.some(i=>!i.completed_at)
  ||!items.some(i=>i.kind==='inspection'&&i.completed_at))return false;
 const dependencies=pending[0].depends_on;
 return Array.isArray(dependencies)&&dependencies.length>0
  &&dependencies.every(id=>items.some(i=>i.item_id===id&&i.kind==='edit'&&i.completed_at));
}

/** Host-assembled handback with references, not invented accomplishments.
 * It is safe to stop this helper; it does not mark parent work complete. */
export function desktopHelperBudgetReportV1(snapshot:AssignmentSnapshotV2,lease:DesktopHelperCallLeaseV1,reason?:'inspection_handoff'){
 const operations=Object.values(snapshot.operations).filter(op=>!lease.initial_operation_ids.has(op.operation_id)
  &&op.settlement_state==='settled'&&op.result?.status==='succeeded').slice(-5);
 return {claimed_completed:[],remaining_work:[
  reason==='inspection_handoff'
   ?'The sole remaining declared item is an inspection. Return the retained findings to the desktop owner for the actual remaining inspection before spending another no-progress slot. This item remains pending; native, visual and final delivery requirements are not completed by this handback.'
   :'The scoped helper reached its share of the current call allowance. The desktop owner must inspect retained results and continue the remaining task, including verification and saving as needed.',
  ...(reason==='inspection_handoff'?snapshot.work_plan!.items.filter(i=>!i.completed_at).map(i=>`Pending inspection ${i.item_id}: ${i.description}`):[]),
  ...operations.map(op=>`Retained operation ${op.operation_id}: ${op.request_identity?.path??op.capability_id}; effect ${op.persistent_effect}; evidence ${op.observation_ids.slice(-1).join(',')||'not available'}.`)
 ],uncertainties:[
  'This is a host-generated partial handback, not a helper completion report or native verification. No proposed tool action at this boundary was dispatched. Do not repeat applied or uncertain work.',
  'The parent task allowance, existing findings, unfinished work and all native/control fences remain unchanged.'
 ]};
}
