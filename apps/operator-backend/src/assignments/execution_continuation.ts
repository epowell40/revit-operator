import { createHash } from 'node:crypto';
import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import { projectWorkPlan } from './work_plan_projection.js';
import { assignmentWorkBudgetStatusV2 } from './assignment_work_allowance_v2.js';
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from './assignment_kernel_v2_progress.js';

/** Current host scheduling advice for the existing owner loop. Not an execution
 * grant, completion decision, second controller, or an allowance extension. */
export function projectExecutionContinuation(snapshot: AssignmentSnapshotV2, now = new Date().toISOString()) {
  const binding = snapshot.current_binding;
  const base = {schema:'operator.execution-continuation.v1', binding:{session_id:binding.session_id,
    assignment_id:binding.assignment_id,run_id:binding.run_id,generation:binding.generation}};
  const hold = (reason:string) => ({...base,state:'hold',reason,next_items:[]});
  if (snapshot.terminal || snapshot.outcome !== 'active') return hold(snapshot.terminal_reason ?? snapshot.outcome);
  if (snapshot.execution_control?.state === 'paused') return hold('paused');
  if (snapshot.provider_usage_hold || snapshot.in_flight_provider_call_ids.length) return hold('pending_usage');
  if (!snapshot.quiescent || snapshot.in_flight_operation_ids.length || snapshot.unresolved_unknown_operation_ids.length) return hold('unsettled_model_effect');
  if (snapshot.pending_input_variable_ids.length || snapshot.pending_review_ids.length || snapshot.completion_proposal) return hold('input_or_review_pending');
  if (snapshot.progress_blocker) return hold(snapshot.progress_blocker.code);
  const budget=assignmentWorkBudgetStatusV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,now);
  if(snapshot.provider_budget_exhausted || Object.values(budget.resources).some(r=>r.remaining===null||r.remaining<=0))return hold('budget_exhausted');
  if(snapshot.spec.execution_policy?.ready_work_handoff!=='continue_ready_work_v1')return hold('ordinary_task_reporting');
  const plan=projectWorkPlan(snapshot.work_plan,undefined,0,snapshot);
  const next=plan?.ready_items.items??[];
  if(!next.length)return hold('no_ready_work');
  // Repeated observations, status reads, location edits and token use are not
  // construction progress. Preserve the existing domain's no-progress limits.
  const applied=Object.values(snapshot.operations).filter(o=>o.persistent_effect==='applied'&&o.settlement_state==='settled')
    .map(o=>o.operation_id).sort();
  const checked=(snapshot.work_plan?.items??[]).filter(i=>i.completed_at).map(i=>i.item_id).sort();
  const claims=[...new Set((snapshot.work_plan_claims??[]).map(c=>c.item_id))].sort();
  const backchecked=[...new Set((snapshot.work_plan?.items??[]).flatMap(i=>(i.location_history??[])
    .filter(r=>r.drafting?.stage==='checked').map(r=>i.item_id+':'+r.drafting!.pass)))].sort();
  const progress_key=createHash('sha256').update(JSON.stringify({applied,checked,claims,backchecked})).digest('hex');
  return {...base,state:'ready',reason:'ready_work_remaining',progress_key,next_items:next,
    remaining_resources:budget.resources,checkpoint_recommended:budget.checkpoint_recommended,
    notice:'A completed response is not a completed assignment. Continue one useful discrepancy, inspect and check off the result, then select the next. Existing native/provider admission remains authoritative.'};
}
