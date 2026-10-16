import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2} from '../domain/assignment-kernel/index.js';

type Input={planning:AssignmentSnapshotV2|null;beforeRead:AssignmentSnapshotV2|null;afterRead:AssignmentSnapshotV2|null;
 applyOperationId:string;plan:unknown;response:unknown;retryAttempt:number};
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const stableApply=(op:OperationV2)=>({binding:op.binding,input:op.input,request_identity:op.request_identity,
 admission_state:op.admission_state,dispatch_state:op.dispatch_state,settlement_state:op.settlement_state,
 persistent_effect:op.persistent_effect,result:op.result,observation_ids:op.observation_ids});

/** One new read attempt, never an apply retry or an authorization bypass.
 * The caller already generated a postcommit plan. Every later attempt still
 * reenters ordinary schema/owner/Pause/resource/native admission and settlement.
 */
export function committedReadRetryDecisionV2(input:Input):{retry:boolean;reason:string} {
 try {
  const {planning,beforeRead,afterRead,applyOperationId,plan:rawPlan,response:rawResponse,retryAttempt}=input;
  const plan=obj(rawPlan),response=obj(rawResponse);
  if(retryAttempt!==0||!planning||!beforeRead||!afterRead||response.success!==false)return {retry:false,reason:'not_initial_failed_check'};
  if(afterRead.terminal||afterRead.outcome!=='active'||afterRead.completion_proposal
    ||afterRead.execution_control?.state==='paused'||afterRead.unresolved_unknown_operation_ids.length)return {retry:false,reason:'task_not_active_or_unknown'};
  if(!sameAssignmentBindingV2(planning.current_binding,afterRead.current_binding)
    ||!sameAssignmentBindingV2(beforeRead.current_binding,afterRead.current_binding)
    ||planning.assignment_version>beforeRead.assignment_version||afterRead.assignment_version<=beforeRead.assignment_version)return {retry:false,reason:'binding_or_version_changed'};
  const apply=planning.operations[applyOperationId],current=afterRead.operations[applyOperationId];
  if(!apply||!current||apply.requested_effect!=='apply'||apply.persistent_effect!=='applied'
    ||apply.admission_state!=='admitted'||apply.settlement_state!=='settled'
    ||apply.result?.authority!=='native-host'||apply.result.status!=='succeeded'
    ||apply.result.native_transaction_state!=='committed'
    ||!sameAssignmentBindingV2(apply.binding,afterRead.current_binding)
    ||!sameAssignmentBindingV2(apply.result.binding,afterRead.current_binding)
    ||canonicalJsonV2(stableApply(apply))!==canonicalJsonV2(stableApply(current)))return {retry:false,reason:'commit_untrusted_or_changed'};
  // Prior successful read slices may add verification links; no intervening
  // apply result/input/settlement or new apply is allowed to change the plan.
  for(const op of Object.values(afterRead.operations))if(op.requested_effect==='apply'){
   const prior=planning.operations[op.operation_id];
   if(!prior||canonicalJsonV2(stableApply(prior))!==canonicalJsonV2(stableApply(op)))return {retry:false,reason:'intervening_apply'};
  }
  const added=Object.values(afterRead.operations).filter(op=>!beforeRead.operations[op.operation_id]);
  if(added.length!==1)return {retry:false,reason:'ambiguous_new_operations'};
  const read=added[0]!,result=read.result;
  if(read.requested_effect!=='read'||read.fulfillment_role!=='verification'
    ||read.verification_of_operation_id!==applyOperationId||read.admission_state!=='admitted'
    ||read.settlement_state!=='settled'||read.dispatch_state!=='not_dispatched'
    ||read.persistent_effect!=='none'||read.observation_ids.length
    ||!result||result.status!=='failed_before_dispatch'||result.authority!=='native-host'
    ||result.dispatch_state!=='not_dispatched'||result.persistent_effect!=='none'||result.observation_required
    ||!['not_applicable','not_started'].includes(result.native_transaction_state)
    ||!sameAssignmentBindingV2(read.binding,afterRead.current_binding)
    ||!sameAssignmentBindingV2(result.binding,afterRead.current_binding)
    ||canonicalJsonV2(read.input)!==canonicalJsonV2(plan)
    ||canonicalJsonV2(result.request_identity)!==canonicalJsonV2(read.request_identity)
    ||afterRead.input_invalidated_operation_ids?.includes(applyOperationId)
    ||afterRead.input_invalidated_operation_ids?.includes(read.operation_id))return {retry:false,reason:'read_failure_not_safe_or_matching'};
  if(!Number.isFinite(Date.parse(read.opened_at))||!Number.isFinite(Date.parse(result.completed_at))
    ||Date.parse(read.opened_at)<Date.parse(apply.result.completed_at)
    ||Date.parse(result.completed_at)<Date.parse(read.opened_at))return {retry:false,reason:'read_time_mismatch'};
  const failures=(Array.isArray(response.contentItems)?response.contentItems:[]).flatMap(item=>{
   if(item?.type!=='inputText'||typeof item.text!=='string'||item.text.length>32768)return [];
   try{const value=JSON.parse(item.text);return value?.schema==='revit-operator.revit-bridge-failure.v1'?[value]:[];}catch{return [];}
  });
  if(failures.length!==1)return {retry:false,reason:'failure_envelope_missing_or_ambiguous'};
  const failure=failures[0];
  const allowed=failure.ok===false&&failure.bridge_code==='CERTIFICATION_DIRECT_AUTHORIZATION_UNAVAILABLE'
   &&failure.phase==='certification_native_direct_admission'&&failure.status===503&&failure.retryable===true
   &&failure.request_dispatched===false&&failure.outcome_unknown===false
   &&failure.method===plan.method&&failure.path===plan.path
   &&typeof result.native_correlation_id==='string'&&result.native_correlation_id.length>0
   &&failure.correlation_id===result.native_correlation_id;
  return {retry:allowed,reason:allowed?'retryable_pre_dispatch_authorization_failure':'unsupported_failure'};
 }catch{return {retry:false,reason:'invalid_retry_input'};}
}

export function safeCommittedReadRetryV2(input:Input):boolean{return committedReadRetryDecisionV2(input).retry;}
