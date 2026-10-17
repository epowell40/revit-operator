import type {CodexServerRequest} from '../codex/app_server.js';
import type {CodexMcpToolRuntime} from '../codex/mcp_tool_runtime.js';
import {canonicalJsonV2,sameAssignmentBindingV2,assignmentNativeReadbackResourceBlockerV2,type AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {defaultAssignmentWorkBudgetV2} from '../assignments/assignment_work_allowance_v2.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from '../assignments/assignment_kernel_v2_progress.js';
import {getAssignmentKernelSnapshotV2} from '../assignments/assignment_kernel_v2_store.js';
import {openAssignmentKernelOperationV2,failAssignmentKernelOperationV2} from '../assignments/assignment_kernel_v2_execution.js';
import {bindCanonicalAssignmentToolArguments} from '../assignments/tool_argument_binding.js';
import {operationTargetSelectorV2} from '../verification/verification_capability_admission_v2.js';
import {revitRouteEffect} from '../action_path_mutability.js';

type Lease=ReturnType<typeof openAssignmentKernelOperationV2>;
type ReadPlan=Readonly<{method:string;path:string;body?:unknown}>;
export type CommittedReadbackReservationV2=Readonly<{request:CodexServerRequest;token:object;operation_id:string}>;
type Retained={owner:object;request_id:string|number;turn_id:unknown;arguments:string;lease:Lease;consumed:boolean};
const reservations=new WeakMap<object,Retained>();
export function isCommittedReadbackReservationV2(token:unknown):token is object {
 return typeof token==='object'&&token!==null&&reservations.has(token);
}
function ready(s:AssignmentSnapshotV2){return !s.terminal&&s.outcome==='active'&&!s.completion_proposal
 &&s.execution_control?.state!=='paused'&&!s.provider_usage_hold&&!s.progress_blocker&&!s.provider_budget_exhausted
 &&!s.pending_input_variable_ids.length&&!s.pending_review_ids.length&&!s.unresolved_unknown_operation_ids.length&&!s.execution_failure_ids.length;}

/** Reserve real read operations before the parent budget checkpoint. No dispatch or proof is synthesized. */
export async function reserveCommittedReadbacksV2(input:{runtime:CodexMcpToolRuntime;parent:CodexServerRequest;snapshot:AssignmentSnapshotV2;subjectId:string;plans:readonly ReadPlan[]}):Promise<{entries:CommittedReadbackReservationV2[];reason?:string}> {
 const {runtime,parent,snapshot,subjectId,plans}=input,subject=snapshot.operations[subjectId];
 if(!plans.length||!ready(snapshot)||snapshot.in_flight_operation_ids.length||!subject||subject.settlement_state!=='settled'||subject.persistent_effect!=='applied')return {entries:[],reason:'host_readback_not_ready'};
 const out:CommittedReadbackReservationV2[]=[];
 try{
  const blocker=assignmentNativeReadbackResourceBlockerV2(snapshot,defaultAssignmentWorkBudgetV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2),new Date().toISOString(),plans.length);
  if(blocker)return {entries:[],reason:blocker};
  for(const [index,plan]of plans.entries()){
   if(revitRouteEffect(plan.path,plan.method,plan.body)!=='read')throw Error('host_readback_must_be_read_only');
   const args=bindCanonicalAssignmentToolArguments('revit_call_tool',plan,snapshot.current_binding).arguments;
   await runtime.validateToolArguments?.('revit_call_tool',args);
   const current=getAssignmentKernelSnapshotV2(snapshot.current_binding.assignment_id);
   if(!current||!sameAssignmentBindingV2(current.current_binding,snapshot.current_binding)||!ready(current))throw Error('host_readback_controls_changed');
   const exhausted=assignmentNativeReadbackResourceBlockerV2(current,defaultAssignmentWorkBudgetV2(current,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2),new Date().toISOString(),plans.length-index);
   if(exhausted)throw Error(exhausted);
   const request:CodexServerRequest={id:`host-committed-readback:${subjectId}:${index}`,method:'item/tool/call',
    params:{namespace:'revit_operator',tool:'revit_call_tool',turnId:parent.params?.turnId,threadId:parent.params?.threadId,arguments:args}};
   const lease=openAssignmentKernelOperationV2({snapshot:current,controller_request_id:request.id,provider_turn_id:String(parent.params?.turnId??'unbound-turn'),
    capability_id:'revit_call_tool',classified_effect:'read',arguments:args,
    target_tokens:operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',method:plan.method,path:plan.path},value:plan.body}).principal_target_tokens});
   const token=Object.freeze({});reservations.set(token,{owner:runtime,request_id:request.id,turn_id:parent.params?.turnId,arguments:canonicalJsonV2(args),lease,consumed:false});out.push({request,token,operation_id:lease.operation_id});
   if(getAssignmentKernelSnapshotV2(lease.assignment_id)?.operations[lease.operation_id]?.verification_of_operation_id!==subjectId)throw Error('host_readback_subject_mismatch');
  }
  return {entries:out};
 }catch(error){
  retireCommittedReadbacksV2(out);return {entries:[],reason:String(error).slice(0,300)};
 }
}

/** Only the same in-process call can consume an open, undispatched, immutable read lease. */
export function consumeCommittedReadbackV2(token:unknown,owner:object,request:CodexServerRequest,args:unknown):Lease|null {
 if(!isCommittedReadbackReservationV2(token))return null;
 const r=reservations.get(token)!,s=getAssignmentKernelSnapshotV2(r.lease.assignment_id),op=s?.operations[r.lease.operation_id];
 if(r.owner!==owner||r.consumed||request.id!==r.request_id||request.params?.turnId!==r.turn_id
  ||request.params?.tool!=='revit_call_tool'||canonicalJsonV2(args)!==r.arguments||!s||!ready(s)
  ||!sameAssignmentBindingV2(s.current_binding,r.lease.binding)||!op||op.requested_effect!=='read'
  ||op.settlement_state!=='open'||op.dispatch_state!=='not_dispatched'
  ||s.input_invalidated_operation_ids?.includes(op.operation_id)||s.input_invalidated_operation_ids?.includes(op.verification_of_operation_id??'')
  ||assignmentNativeReadbackResourceBlockerV2(s,defaultAssignmentWorkBudgetV2(s,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2),new Date().toISOString(),0))throw Error('host_readback_reservation_invalid');
 r.consumed=true;return r.lease;
}

/** Rejected schemas, Pause or an earlier failed check must not leave undispatched reservations in flight. */
export function retireCommittedReadbacksV2(batch:readonly CommittedReadbackReservationV2[]):void {
 for(const {token}of batch){const r=reservations.get(token);if(!r)continue;
  const s=getAssignmentKernelSnapshotV2(r.lease.assignment_id),op=s?.operations[r.lease.operation_id];
  if(s&&!s.terminal&&sameAssignmentBindingV2(s.current_binding,r.lease.binding)&&op?.settlement_state==='open'&&op.dispatch_state==='not_dispatched')
   failAssignmentKernelOperationV2(r.lease,Error('host_readback_not_dispatched'),'not_dispatched');
  reservations.delete(token);
 }
}
