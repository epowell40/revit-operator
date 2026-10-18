import test from 'node:test';
import assert from 'node:assert/strict';
import {committedReadRetryDecisionV2} from '../src/verification/safe_committed_read_retry_v2.js';
import {preDispatchReadRetryV2} from '../src/domain/assignment-kernel/pre_dispatch_read_retry.js';

function fixture(){
 const binding={assignment_id:'task',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const plan={method:'POST',path:'/revit/native-api-ops',body:{operations:[{id:'read',op:'get',target:'doc',memberId:'property:Example'}]}};
 const identity={capability_id:'revit_call_tool',method:'POST',path:plan.path,request_signature:'read-signature'};
 const apply:any={operation_id:'apply',binding,requested_effect:'apply',input:{method:'POST',path:'/revit/set-parameters',body:{changes:[]}},
  admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',persistent_effect:'applied',observation_ids:['apply-evidence'],verification_operation_ids:[],admitted_assignment_version:1,settled_assignment_version:4,
  result:{binding,status:'succeeded',authority:'native-host',native_transaction_state:'committed',dispatch_state:'dispatched',persistent_effect:'applied',completed_at:'2026-10-16T01:20:00Z'}};
 const planning:any={current_binding:binding,assignment_version:4,operations:{apply},terminal:false,outcome:'active',unresolved_unknown_operation_ids:[]};
 const read:any={operation_id:'failed-read',binding,requested_effect:'read',purpose:'verification',fulfillment_role:'verification',verification_of_operation_id:'apply',
  input:plan,request_identity:identity,target:{document_fingerprint:'model',target_id:'id:41'},admission_state:'admitted',dispatch_state:'not_dispatched',settlement_state:'settled',persistent_effect:'none',observation_ids:[],verification_operation_ids:[],
  admitted_assignment_version:5,settled_assignment_version:7,opened_at:'2026-10-16T01:21:00Z',result:{binding,request_identity:identity,status:'failed_before_dispatch',authority:'native-host',dispatch_state:'not_dispatched',persistent_effect:'none',observation_required:false,native_transaction_state:'not_applicable',native_correlation_id:'native-correlation',completed_at:'2026-10-16T01:21:01Z'}};
 const afterRead={...structuredClone(planning),assignment_version:7,operations:{apply:structuredClone(apply),[read.operation_id]:read}};
 const failure={schema:'revit-operator.revit-bridge-failure.v1',ok:false,bridge_code:'CERTIFICATION_DIRECT_AUTHORIZATION_UNAVAILABLE',phase:'certification_native_direct_admission',status:503,retryable:true,request_dispatched:false,outcome_unknown:false,method:plan.method,path:plan.path,correlation_id:'native-correlation'};
 return {planning,beforeRead:structuredClone(planning),afterRead,applyOperationId:'apply',plan,response:{success:false,contentItems:[{type:'inputText',text:JSON.stringify(failure)}]},retryAttempt:0,failure};
}

for(const variant of ['exact','wrong_id','prior_dispatched','prior_write','prior_subject','prior_observed','prior_identity','prior_binding','changed_result_input','extra_operation'] as const)
test(`pre-admitted read retry retains original guards: ${variant}`,()=>{
 const f:any=fixture(),prior=structuredClone(f.afterRead.operations['failed-read']);
 delete prior.result;delete prior.settled_assignment_version;prior.settlement_state='open';
 f.beforeRead.operations['failed-read']=prior;f.beforeRead.assignment_version=5;f.reservedReadOperationId='failed-read';
 if(variant==='wrong_id')f.reservedReadOperationId='foreign';
 if(variant==='prior_dispatched')prior.dispatch_state='dispatched';
 if(variant==='prior_write')prior.requested_effect='apply';
 if(variant==='prior_subject')prior.verification_of_operation_id='foreign';
 if(variant==='prior_observed')prior.observation_ids=['old'];
 if(variant==='prior_identity')prior.request_identity.request_signature='foreign';
 if(variant==='prior_binding')prior.binding.run_id='foreign';
 if(variant==='changed_result_input')f.afterRead.operations['failed-read'].input={...f.plan,body:{changed:true}};
 if(variant==='extra_operation')f.afterRead.operations.other={...prior,operation_id:'foreign'};
 assert.equal(committedReadRetryDecisionV2(f).retry,variant==='exact');
});
test('one native-confirmed pre-dispatch read retry; original failed receipt remains unchanged',()=>{
 const f=fixture(),old=JSON.stringify(f),proposal={...f.afterRead.operations['failed-read'],operation_id:'new-read'};
 assert.equal(committedReadRetryDecisionV2(f).retry,true);
 assert.deepEqual(preDispatchReadRetryV2(f.afterRead as any,proposal),{retry_of_operation_id:'failed-read',retry_basis:'native_pre_dispatch_read'});
 assert.equal(JSON.stringify(f),old);
});
const guards:Record<string,(f:ReturnType<typeof fixture>)=>void>={
 limit:f=>f.retryAttempt=1,success:f=>f.response.success=true,paused:f=>(f.afterRead as any).execution_control={state:'paused'},
 unknown:f=>f.afterRead.unresolved_unknown_operation_ids.push('unknown'),terminal:f=>f.afterRead.terminal=true,
 pending:f=>(f.afterRead as any).completion_proposal={},foreign:f=>f.afterRead.current_binding={...f.afterRead.current_binding,run_id:'foreign'},
 changed_commit:f=>f.afterRead.operations.apply.input={...f.afterRead.operations.apply.input,changed:true},
 intervening_apply:f=>(f.afterRead.operations as any).later={...f.afterRead.operations.apply,operation_id:'later',admitted_assignment_version:6},
 ambiguous_reads:f=>(f.afterRead.operations as any).other={...f.afterRead.operations['failed-read'],operation_id:'other'},
 wrong_role:f=>f.afterRead.operations['failed-read'].fulfillment_role='supporting_control',
 wrong_subject:f=>f.afterRead.operations['failed-read'].verification_of_operation_id='foreign',
 dispatched:f=>f.afterRead.operations['failed-read'].result.dispatch_state='dispatched',
 effect_unknown:f=>f.afterRead.operations['failed-read'].result.persistent_effect='unknown',
 result_after_dispatch:f=>f.afterRead.operations['failed-read'].result.status='failed_after_dispatch',
 result_transport:f=>f.afterRead.operations['failed-read'].result.authority='operator-mcp-transport',
 wrong_request:f=>f.afterRead.operations['failed-read'].result.request_identity={request_signature:'foreign'},
 evidence_required:f=>f.afterRead.operations['failed-read'].result.observation_required=true,
 existing_evidence:f=>f.afterRead.operations['failed-read'].observation_ids.push('observation'),
 stale_read:f=>f.afterRead.operations['failed-read'].opened_at='2026-10-15T01:00:00Z',
 invalidated:f=>(f.afterRead as any).input_invalidated_operation_ids=['apply'],
 missing_failure:f=>f.response.contentItems=[],ambiguous_failure:f=>f.response.contentItems.push(f.response.contentItems[0]!),
};
for(const [name,mutate]of Object.entries(guards))test(`automatic verification retry rejects ${name}`,()=>{const f=fixture();mutate(f);assert.equal(committedReadRetryDecisionV2(f).retry,false);});
for(const [key,value]of Object.entries({bridge_code:'OTHER',phase:'native_execution',status:502,retryable:false,request_dispatched:true,outcome_unknown:true,correlation_id:'foreign',method:'GET',path:'/other'}))
 test(`automatic retry rejects mismatching failure ${key}`,()=>{const f=fixture();f.response.contentItems[0]!.text=JSON.stringify({...f.failure,[key]:value});assert.equal(committedReadRetryDecisionV2(f).retry,false);});
for(const name of ['write','used','chain','no_version','invalidated','changed_plan','new_apply','paused','unknown','foreign','after_dispatch']as const)
 test(`journal-derived retry rejects ${name}`,()=>{const f=fixture(),s:any=f.afterRead,p:any={...s.operations['failed-read'],operation_id:'new-read'};
  if(name==='write')p.requested_effect='apply';if(name==='used')s.operations.used={...p,retry_of_operation_id:'failed-read'};
  if(name==='chain')s.operations['failed-read'].retry_of_operation_id='earlier';if(name==='no_version')delete s.operations['failed-read'].settled_assignment_version;
  if(name==='invalidated')s.input_invalidated_operation_ids=['failed-read'];if(name==='changed_plan')p.input={...p.input,changed:true};
  if(name==='new_apply')s.operations.later={...s.operations.apply,operation_id:'later',admitted_assignment_version:6};if(name==='paused')s.execution_control={state:'paused'};
  if(name==='unknown')s.unresolved_unknown_operation_ids=['old'];if(name==='foreign')p.binding={...p.binding,run_id:'foreign'};
  if(name==='after_dispatch')s.operations['failed-read'].result.dispatch_state='dispatched';
  assert.equal(preDispatchReadRetryV2(s,p),null);
 });
